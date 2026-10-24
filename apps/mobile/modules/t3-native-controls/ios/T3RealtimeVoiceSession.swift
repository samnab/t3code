import AVFoundation

enum T3RealtimeVoiceSessionError: String, Error {
  case unavailable
  case busy
  case permissionDenied
  case notOwner
}

/// Owns AVAudioSession for realtime voice between an explicit `prepare` and `end`.
/// Native observers close the send gate synchronously, before any JS hears about it.
/// Nothing here runs at launch; the module calls in only on a JS user action.
final class T3RealtimeVoiceSession {
  static let shared = T3RealtimeVoiceSession()

  /// Receives the reason after the gate is already closed. Called off the main thread.
  var onRevoked: ((String) -> Void)?

  private let device = T3RealtimeVoiceAudioDevice.shared()
  private let lock = NSLock()
  private var owner: String?
  private var observers: [NSObjectProtocol] = []
  private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

  /// Read by other audio-session users (video preview) so they leave voice alone.
  var ownsAudioSession: Bool { lock.withLock { owner != nil } }

  func prepare(owner token: String) throws {
    try lock.withLock {
      guard T3RealtimeVoiceAudioDevice.installedInWebRTCModuleOptions else {
        throw T3RealtimeVoiceSessionError.unavailable
      }
      if let owner, owner != token { throw T3RealtimeVoiceSessionError.busy }
      guard AVAudioApplication.shared.recordPermission == .granted else {
        throw T3RealtimeVoiceSessionError.permissionDenied
      }
      let session = AVAudioSession.sharedInstance()
      // Dictation (expo-audio) records in playAndRecord with the default mode. Never take
      // the microphone from it; this also fails closed if it left that category behind.
      if owner == nil, session.category == .playAndRecord, session.mode != .voiceChat {
        throw T3RealtimeVoiceSessionError.busy
      }
      let restore = (session.category, session.mode, session.categoryOptions)
      do {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        try session.setActive(true)
      } catch {
        if owner == nil { try? session.setCategory(restore.0, mode: restore.1, options: restore.2) }
        throw error
      }
      if owner == nil {
        previous = restore
        observe()
      }
      owner = token
      device.armCapture()
    }
  }

  func openGate(owner token: String, leaseSeconds: Double) throws -> UInt64 {
    try lock.withLock {
      guard owner == token else { throw T3RealtimeVoiceSessionError.notOwner }
      return device.openGate(withLeaseSeconds: leaseSeconds)
    }
  }

  func renewLease(epoch: UInt64, leaseSeconds: Double) -> Bool {
    device.renewLease(forEpoch: epoch, leaseSeconds: leaseSeconds)
  }

  func closeGate(epoch: UInt64) -> Bool {
    device.closeGate(forEpoch: epoch)
  }

  /// Ends only the matching owner, so stale cleanup cannot end a newer session.
  func end(owner token: String) -> Bool {
    lock.withLock {
      guard owner == token else { return false }
      device.revokeCapture()
      observers.forEach(NotificationCenter.default.removeObserver)
      observers = []
      owner = nil
      let session = AVAudioSession.sharedInstance()
      if let previous { try? session.setCategory(previous.0, mode: previous.1, options: previous.2) }
      previous = nil
      try? session.setActive(false, options: [.notifyOthersOnDeactivation])
      return true
    }
  }

  func snapshot() -> [String: Any] {
    lock.withLock {
      [
        "installed": T3RealtimeVoiceAudioDevice.installedInWebRTCModuleOptions,
        "adopted": device.adoptedByWebRTC,
        "owned": owner != nil,
        "armed": device.captureArmed,
        "epoch": Double(device.openEpoch),
      ]
    }
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
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }
        let session = AVAudioSession.sharedInstance()
        let stillVoice = session.category == .playAndRecord && session.mode == .voiceChat
        // A lost headset or someone else's category must not move speech to the phone.
        if reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory || !stillVoice {
          self?.revoke("route:\(reason.rawValue)")
        } else {
          self?.device.notifyRouteParametersChanged()
        }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.device.revokeCaptureAndResetUnit()
        self?.onRevoked?("mediaServicesReset")
      },
    ]
  }

  private func revoke(_ reason: String) {
    device.revokeCapture()
    onRevoked?(reason)
  }
}
