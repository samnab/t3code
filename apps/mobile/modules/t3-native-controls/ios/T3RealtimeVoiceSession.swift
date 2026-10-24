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
/// Native observers close the send gate synchronously, before any JS hears about it, and
/// any genuine fault ends the owner natively; only a new `prepare` captures again.
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
  private typealias Restore = (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)

  /// One successful prepare. A fault watch acts only while its stamp is still current, so a
  /// delayed tick from an ended owner or an earlier prepare cannot touch its replacement.
  struct Incarnation: Equatable {
    let owner: Owner
    let number: UInt64
    let faults: UInt64
  }

  /// Starts `tick` repeating on the control queue and returns its cancel. Every genuine fault
  /// only bumps the device's fault count; this is what turns that into cleanup without JS.
  /// Host tests replace it with a manual scheduler.
  var startFaultWatch: (@escaping () -> Void) -> () -> Void = { tick in
    let timer = DispatchSource.makeTimerSource(queue: T3RealtimeVoiceSession.controlQueue)
    timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(50))
    timer.setEventHandler(handler: tick)
    timer.resume()
    return { timer.cancel() }
  }
  /// Fault ticks and post-teardown release run here, never on the IO or ADM thread.
  static let controlQueue = DispatchQueue(label: "T3RealtimeVoiceSession.control")

  private let device = T3RealtimeVoiceAudioDevice.shared()
  // `lock` serializes prepare/end and is held across AVAudioSession calls, which may post
  // notifications synchronously. Observers only take `stateLock`, which never is.
  private let lock = NSLock()
  private var owner: Owner?
  private var nextGeneration: UInt64 = 1
  private var observers: [NSObjectProtocol] = []
  private var previous: Restore?
  private var incarnation: Incarnation?
  private var incarnations: UInt64 = 0
  private var cancelFaultWatch: (() -> Void)?
  // Observers capture the owner they were installed for and act only while it is still
  // `observed`, checking and revoking under `stateLock`. A callback already running for an
  // ended owner therefore cannot revoke, or speak for, its replacement.
  private let stateLock = NSLock()
  private var observed: Owner?
  private var authorizedRoute: Route?
  // The latest observer fault, stamped with the device fault count it produced.
  private var observerFault: (count: UInt64, reason: String)?
  // An ended owner whose audio unit is still being torn down: the session stays active,
  // and nothing may prepare, until the device reports the unit gone.
  private var releasing = false
  private var listener: (module: ObjectIdentifier, notify: Listener)?

  /// Read by other audio-session users (video preview, dictation) so they leave voice alone.
  var ownsAudioSession: Bool { stateLock.withLock { observed != nil || releasing } }

  /// Receives faults that ended owners prepared by `module`, once the gate is closed and the
  /// owner, audio unit and audio session are released. A deliberate `end` reports nothing.
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
      // Arming before an ended owner's teardown finished would let that teardown dispose the
      // new lifetime's audio unit.
      guard !stateLock.withLock({ releasing }) else { throw T3RealtimeVoiceSessionError.busy }
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
      // The old incarnation and its watch are gone, so any failure from here ends the owner
      // natively; leaving it owned would leave nothing to clean it up.
      let failed = { [self] (error: Error) -> Error in
        endLocked(candidate, restore: restore, reason: faultReason(since: faults))
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

  /// Control queue. Ends the incarnation that faulted; it is reported once, after teardown.
  /// The gate is already closed by whoever faulted; this releases the owner, audio unit and
  /// audio session natively, whether or not JS is running. It never reopens anything.
  func drainFault(_ stamp: Incarnation) {
    lock.withLock {
      guard incarnation == stamp, let reason = faultReason(since: stamp.faults) else { return }
      endLocked(stamp.owner, restore: previous, reason: reason)
    }
  }

  /// Caller holds `lock`. Why the lifetime that read `faults` must end, or nil when nothing
  /// faulted since. IO and ADM faults carry no reason of their own.
  private func faultReason(since faults: UInt64) -> String? {
    guard device.faultCount != faults else { return nil }
    let noted = stateLock.withLock { observerFault }
    if let noted, noted.count > faults { return noted.reason }
    return "audioFault"
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
      endLocked(owner, restore: previous, reason: nil)
      return true
    }
  }

  /// Caller holds `lock`. Closes the gate now and drops ownership. The audio session is
  /// restored and deactivated, and `reason` reported for `ended`, only after the device
  /// stopped and disposed its audio unit, since IO must stop before deactivation.
  private func endLocked(_ ended: Owner, restore: Restore?, reason: String?) {
    stopFaultWatch()
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    stateLock.withLock {
      observed = nil
      authorizedRoute = nil
      releasing = true
    }
    owner = nil
    previous = nil
    device.endCapture { [weak self] in
      Self.controlQueue.async { self?.released(ended, restore: restore, reason: reason) }
    }
  }

  /// Control queue, once the ended owner's audio unit is gone. Prepare is busy until here.
  private func released(_ ended: Owner, restore: Restore?, reason: String?) {
    lock.withLock {
      let session = AVAudioSession.sharedInstance()
      if let restore { try? session.setCategory(restore.0, mode: restore.1, options: restore.2) }
      try? session.setActive(false, options: [.notifyOthersOnDeactivation])
      stateLock.withLock { releasing = false }
    }
    if let reason { notify(reason, ended) }
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
      "owned": ownsAudioSession,
      "generation": Double(owner?.generation ?? 0),
      "armed": device.captureArmed,
      "epoch": Double(device.openEpoch),
    ]
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
        self?.fault(observer, "interruption")
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
        self?.fault(observer, "mediaServicesReset")
      },
    ]
  }

  private func routeChanged(_ observer: Owner, _ reason: String, expected: Bool, route: Route) {
    let refresh = stateLock.withLock { () -> Bool in
      guard observed == observer else { return false }
      // Any other input or output, including a newly connected headset or a speaker
      // override, stays private until the user prepares again.
      if expected, let authorized = authorizedRoute, authorized == route { return true }
      // While preparing there is no authorized route yet; prepare validates after arming.
      if expected, authorizedRoute == nil { return false }
      faultLocked(reason)
      return false
    }
    if refresh { device.notifyRouteParametersChanged() }
  }

  private func fault(_ observer: Owner, _ reason: String) {
    stateLock.withLock {
      if observed == observer { faultLocked(reason) }
    }
  }

  /// Caller holds `stateLock`. Closes the gate synchronously and raises the same native fault
  /// an IO failure does, so the watch (or a failing prepare) ends the owner and reports
  /// `reason`. The device only touches atomics here.
  private func faultLocked(_ reason: String) {
    authorizedRoute = nil
    device.faultCapture()
    observerFault = (device.faultCount, reason)
  }

  private func notify(_ reason: String, _ owner: Owner) {
    let notify = stateLock.withLock { listener?.module == owner.module ? listener?.notify : nil }
    notify?(reason, owner)
  }
}
