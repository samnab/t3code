import AVFoundation

enum T3RealtimeVoiceSessionError: String, Error {
  case unavailable
  case busy
  case permissionDenied
  case notOwner
  case interrupted
}

/// Owns AVAudioSession for realtime voice between an explicit `prepare` and `end`.
/// Native observers close the send gate synchronously, before any JS hears about it.
/// Nothing here runs at launch; the module calls in only on a JS user action.
///
/// Owners are bound to the module instance that prepared them, so a destroyed module's
/// cleanup cannot end a replacement module's session.
final class T3RealtimeVoiceSession {
  static let shared = T3RealtimeVoiceSession()

  struct Owner: Equatable {
    let token: String
    let generation: UInt64
    let module: ObjectIdentifier
  }

  /// Input and output port identities captured when capture was armed.
  private struct Route: Equatable {
    let inputs: [String]
    let outputs: [String]

    init(_ route: AVAudioSessionRouteDescription) {
      inputs = route.inputs.map(\.uid)
      outputs = route.outputs.map(\.uid)
    }
  }

  private typealias Listener = (_ reason: String, _ owner: Owner) -> Void

  private let device = T3RealtimeVoiceAudioDevice.shared()
  // `lock` serializes prepare/end and is held across AVAudioSession calls, which may post
  // notifications synchronously. Observers only take `stateLock`, which never is.
  private let lock = NSLock()
  private var owner: Owner?
  private var nextGeneration: UInt64 = 1
  private var observers: [NSObjectProtocol] = []
  private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  private let stateLock = NSLock()
  private var publishedOwner: Owner?
  private var authorizedRoute: Route?
  private var listener: (module: ObjectIdentifier, notify: Listener)?

  /// Read by other audio-session users (video preview) so they leave voice alone.
  var ownsAudioSession: Bool { stateLock.withLock { publishedOwner != nil } }

  /// Receives revocations for owners prepared by `module`, after the gate is already closed.
  func setRevokedListener(module: AnyObject, _ notify: @escaping (String, Owner) -> Void) {
    stateLock.withLock { listener = (ObjectIdentifier(module), notify) }
  }

  func clearRevokedListener(module: AnyObject) {
    stateLock.withLock {
      if listener?.module == ObjectIdentifier(module) { listener = nil }
    }
  }

  /// Starts a fresh capture lifetime: any open epoch closes, and the caller opens a new one.
  func prepare(owner token: String, module: AnyObject) throws -> Owner {
    try lock.withLock {
      guard T3RealtimeVoiceAudioDevice.installedInWebRTCModuleOptions else {
        throw T3RealtimeVoiceSessionError.unavailable
      }
      let moduleId = ObjectIdentifier(module)
      if let owner, owner.token != token || owner.module != moduleId {
        throw T3RealtimeVoiceSessionError.busy
      }
      guard AVAudioApplication.shared.recordPermission == .granted else {
        throw T3RealtimeVoiceSessionError.permissionDenied
      }
      let session = AVAudioSession.sharedInstance()
      // Dictation (expo-audio) records in playAndRecord with the default mode. Never take
      // the microphone from it; this also fails closed if it left that category behind.
      if owner == nil, session.category == .playAndRecord, session.mode != .voiceChat {
        throw T3RealtimeVoiceSessionError.busy
      }
      if owner != nil { device.revokeCapture() }
      stateLock.withLock { authorizedRoute = nil }
      let restore = owner == nil ? (session.category, session.mode, session.categoryOptions) : previous
      // Observe before activating so an interruption during activation invalidates this prepare.
      if owner == nil { observe() }
      let revocations = device.revocationCount
      do {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        try session.setActive(true)
      } catch {
        if owner == nil { release(restore) }
        throw error
      }
      let route = Route(session.currentRoute)
      stateLock.withLock { authorizedRoute = route }
      // Route changes before this point are not compared, so check the route once more
      // after arming. Either failure leaves capture disarmed.
      guard device.armCapture(since: revocations), Route(session.currentRoute) == route else {
        device.revokeCapture()
        if owner == nil { release(restore) } else { stateLock.withLock { authorizedRoute = nil } }
        throw T3RealtimeVoiceSessionError.interrupted
      }
      let current = owner ?? Owner(token: token, generation: nextGeneration, module: moduleId)
      if owner == nil {
        nextGeneration += 1
        previous = restore
      }
      owner = current
      stateLock.withLock { publishedOwner = current }
      return current
    }
  }

  func openGate(owner token: String, module: AnyObject, leaseSeconds: Double) throws -> UInt64 {
    try lock.withLock {
      guard let owner, owner.token == token, owner.module == ObjectIdentifier(module) else {
        throw T3RealtimeVoiceSessionError.notOwner
      }
      return device.openGate(withLeaseSeconds: leaseSeconds)
    }
  }

  func renewLease(epoch: UInt64, leaseSeconds: Double) -> Bool {
    device.renewLease(forEpoch: epoch, leaseSeconds: leaseSeconds)
  }

  func closeGate(epoch: UInt64) -> Bool {
    device.closeGate(forEpoch: epoch)
  }

  /// Ends the owner only if `module` prepared it and, when given, the token matches.
  func end(module: AnyObject, owner token: String? = nil) -> Bool {
    lock.withLock {
      guard let owner, owner.module == ObjectIdentifier(module), token == nil || owner.token == token
      else { return false }
      device.revokeCapture()
      self.owner = nil
      release(previous)
      previous = nil
      return true
    }
  }

  func snapshot() -> [String: Any] {
    let owner = stateLock.withLock { publishedOwner }
    return [
      "installed": T3RealtimeVoiceAudioDevice.installedInWebRTCModuleOptions,
      "adopted": device.adoptedByWebRTC,
      "owned": owner != nil,
      "generation": Double(owner?.generation ?? 0),
      "armed": device.captureArmed,
      "epoch": Double(device.openEpoch),
    ]
  }

  private func release(
    _ restore: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  ) {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    stateLock.withLock {
      publishedOwner = nil
      authorizedRoute = nil
    }
    let session = AVAudioSession.sharedInstance()
    if let restore { try? session.setCategory(restore.0, mode: restore.1, options: restore.2) }
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private func observe() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) {
        [weak self] note in
        // shouldResume is a playback hint, not consent to reopen a microphone.
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: raw) == .began
        else { return }
        self?.revoke("interruption")
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) {
        [weak self] note in
        guard let self else { return }
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
        let session = AVAudioSession.sharedInstance()
        let authorized = stateLock.withLock { self.authorizedRoute }
        if reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory {
          revoke("route:\(raw ?? 0)")
          return
        }
        // While preparing there is no authorized route yet; prepare re-checks after arming.
        guard let authorized else { return }
        // Any other input or output, including a newly connected headset or a speaker
        // override, stays private until the user prepares again.
        if session.category != .playAndRecord || session.mode != .voiceChat
          || Route(session.currentRoute) != authorized
        {
          revoke("route:\(raw ?? 0)")
        } else {
          device.notifyRouteParametersChanged()
        }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.device.revokeCaptureAndResetUnit()
        self?.notify("mediaServicesReset")
      },
    ]
  }

  private func revoke(_ reason: String) {
    device.revokeCapture()
    notify(reason)
  }

  private func notify(_ reason: String) {
    let target = stateLock.withLock { () -> (Listener, Owner)? in
      guard let owner = publishedOwner, let listener, listener.module == owner.module else { return nil }
      return (listener.notify, owner)
    }
    if let (notify, owner) = target { notify(reason, owner) }
  }
}
