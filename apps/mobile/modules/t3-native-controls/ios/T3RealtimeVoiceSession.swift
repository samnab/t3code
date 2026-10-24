import AVFoundation

enum T3RealtimeVoiceSessionError: String, Error {
  case unavailable
  case busy
  case permissionDenied
  case notOwner
  case interrupted
  case invalidRoute
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

    var isDuplex: Bool { !inputs.isEmpty && !outputs.isEmpty }
  }

  private static func isVoice(_ session: AVAudioSession) -> Bool {
    session.category == .playAndRecord && session.mode == .voiceChat
  }

  private typealias Listener = (_ reason: String, _ owner: Owner) -> Void

  /// One successful prepare. A fault watch acts only while its stamp is still current, so a
  /// delayed tick from an ended owner or an earlier prepare cannot touch its replacement.
  struct Incarnation: Equatable {
    let owner: Owner
    let number: UInt64
    let faults: UInt64
  }

  /// Starts `tick` repeating on a control queue and returns its cancel. The IO thread only
  /// bumps an atomic; this is what turns that into cleanup and an event without JS.
  /// Host tests replace it with a manual scheduler.
  var startFaultWatch: (@escaping () -> Void) -> () -> Void = { tick in
    let timer = DispatchSource.makeTimerSource(queue: T3RealtimeVoiceSession.faultQueue)
    timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(50))
    timer.setEventHandler(handler: tick)
    timer.resume()
    return { timer.cancel() }
  }
  private static let faultQueue = DispatchQueue(label: "T3RealtimeVoiceSession.faults")

  private let device = T3RealtimeVoiceAudioDevice.shared()
  // `lock` serializes prepare/end and is held across AVAudioSession calls, which may post
  // notifications synchronously. Observers only take `stateLock`, which never is.
  private let lock = NSLock()
  private var owner: Owner?
  private var nextGeneration: UInt64 = 1
  private var observers: [NSObjectProtocol] = []
  private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  private var incarnation: Incarnation?
  private var incarnations: UInt64 = 0
  private var cancelFaultWatch: (() -> Void)?
  // Observers capture the owner they were installed for and act only while it is still
  // `observed`, checking and revoking under `stateLock`. A callback already running for an
  // ended owner therefore cannot revoke, or speak for, its replacement.
  private let stateLock = NSLock()
  private var observed: Owner?
  private var authorizedRoute: Route?
  private var listener: (module: ObjectIdentifier, notify: Listener)?

  /// Read by other audio-session users (video preview) so they leave voice alone.
  var ownsAudioSession: Bool { stateLock.withLock { observed != nil } }

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
      // The attempt starts here, at native lock entry, not at the JS tap; anything revoked
      // before this read belongs to the previous lifetime. The device counter covers
      // observers, IO faults and WebRTC stops. The success path below makes exactly one
      // deliberate revoke, hence +1: adding another would make every prepare fail closed.
      let revocations = device.revocationCount &+ 1
      // Faults before this read are the previous lifetime's; later ones fail this attempt.
      let faults = device.faultCount
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
      stopFaultWatch()
      let candidate = owner ?? Owner(token: token, generation: nextGeneration, module: moduleId)
      if owner == nil { nextGeneration += 1 }
      stateLock.withLock {
        observed = candidate
        authorizedRoute = nil
      }
      // A fresh capture lifetime: any open epoch closes, and the caller opens a new one.
      device.revokeCapture()
      let restore = owner == nil ? (session.category, session.mode, session.categoryOptions) : previous
      if owner == nil { observe(candidate) }
      let failed = { [self] (error: Error) -> Error in
        device.revokeCapture()
        if owner == nil { release(restore) } else { stateLock.withLock { authorizedRoute = nil } }
        return error
      }
      do {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        try session.setActive(true)
      } catch {
        throw failed(error)
      }
      let route = Route(session.currentRoute)
      guard Self.isVoice(session), route.isDuplex else {
        throw failed(T3RealtimeVoiceSessionError.invalidRoute)
      }
      stateLock.withLock { authorizedRoute = route }
      // A revocation after arming disarms the gate; re-reading the counter last reports it.
      guard device.armCapture(since: revocations), Self.isVoice(session),
        Route(session.currentRoute) == route, device.revocationCount == revocations
      else {
        throw failed(T3RealtimeVoiceSessionError.interrupted)
      }
      if owner == nil { previous = restore }
      owner = candidate
      incarnations += 1
      let current = Incarnation(owner: candidate, number: incarnations, faults: faults)
      incarnation = current
      cancelFaultWatch = startFaultWatch { [weak self] in self?.drainFault(current) }
      return candidate
    }
  }

  /// Control queue. Ends the incarnation that faulted and reports it once. The gate is
  /// already closed by the IO thread; this releases the owner and audio session natively,
  /// whether or not JS is running. It never prepares or reopens anything.
  func drainFault(_ stamp: Incarnation) {
    let faulted = lock.withLock { () -> Bool in
      guard incarnation == stamp, device.faultCount != stamp.faults else { return false }
      endLocked()
      return true
    }
    if faulted { notify("audioFault", stamp.owner) }
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
      endLocked()
      return true
    }
  }

  /// Caller holds `lock`.
  private func endLocked() {
    stopFaultWatch()
    stateLock.withLock {
      observed = nil
      authorizedRoute = nil
    }
    device.revokeCapture()
    owner = nil
    release(previous)
    previous = nil
  }

  /// Caller holds `lock`. A tick already queued finds its stamp stale and does nothing.
  private func stopFaultWatch() {
    cancelFaultWatch?()
    cancelFaultWatch = nil
    incarnation = nil
  }

  func snapshot() -> [String: Any] {
    let owner = stateLock.withLock { observed }
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
      observed = nil
      authorizedRoute = nil
    }
    let session = AVAudioSession.sharedInstance()
    if let restore { try? session.setCategory(restore.0, mode: restore.1, options: restore.2) }
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private func observe(_ observer: Owner) {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) {
        [weak self] note in
        // shouldResume is a playback hint, not consent to reopen a microphone.
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: raw) == .began
        else { return }
        self?.revoke(observer, "interruption")
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) {
        [weak self] note in
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let session = AVAudioSession.sharedInstance()
        let expected: Bool
        switch raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) {
        case nil, .unknown?, .oldDeviceUnavailable?, .noSuitableRouteForCategory?:
          expected = false
        default:
          expected = Self.isVoice(session)
        }
        self?.routeChanged(observer, "route:\(raw ?? 0)", expected: expected, route: Route(session.currentRoute))
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.revoke(observer, "mediaServicesReset", resetUnit: true)
      },
    ]
  }

  private func routeChanged(_ observer: Owner, _ reason: String, expected: Bool, route: Route) {
    enum Action { case ignore, refresh, revoked }
    let action = stateLock.withLock { () -> Action in
      guard observed == observer else { return .ignore }
      // Any other input or output, including a newly connected headset or a speaker
      // override, stays private until the user prepares again.
      if expected, let authorized = authorizedRoute, authorized == route { return .refresh }
      // While preparing there is no authorized route yet; prepare validates after arming.
      if expected, authorizedRoute == nil { return .ignore }
      revokeLocked(resetUnit: false)
      return .revoked
    }
    switch action {
    case .ignore: break
    case .refresh: device.notifyRouteParametersChanged()
    case .revoked: notify(reason, observer)
    }
  }

  private func revoke(_ observer: Owner, _ reason: String, resetUnit: Bool = false) {
    let current = stateLock.withLock { () -> Bool in
      guard observed == observer else { return false }
      revokeLocked(resetUnit: resetUnit)
      return true
    }
    if current { notify(reason, observer) }
  }

  /// Caller holds `stateLock`. The device only takes its own locks and posts to the ADM thread.
  private func revokeLocked(resetUnit: Bool) {
    authorizedRoute = nil
    if resetUnit { device.revokeCaptureAndResetUnit() } else { device.revokeCapture() }
  }

  private func notify(_ reason: String, _ owner: Owner) {
    let notify = stateLock.withLock { listener?.module == owner.module ? listener?.notify : nil }
    notify?(reason, owner)
  }
}
