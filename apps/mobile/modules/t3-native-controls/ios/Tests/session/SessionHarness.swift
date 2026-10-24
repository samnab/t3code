// Host-run checks of the real T3RealtimeVoiceSession.swift against a fake device that
// models the SendGate's revocation counter. Not part of the pod. Run: ./run.sh
import AVFoundation

final class T3RealtimeVoiceAudioDevice {
  static let instance = T3RealtimeVoiceAudioDevice()
  static func shared() -> T3RealtimeVoiceAudioDevice { instance }
  static var installedInWebRTCModuleOptions: Bool { true }
  var adoptedByWebRTC = true
  var captureArmed = false
  var openEpoch: UInt64 = 0
  var revocationCount: UInt64 = 0
  var parameterChanges = 0
  func armCapture(since: UInt64) -> Bool {
    guard revocationCount == since else { return false }
    captureArmed = true
    return true
  }
  func revokeCapture() { revocationCount += 1; captureArmed = false; openEpoch = 0 }
  func revokeCaptureAndResetUnit() { revokeCapture() }
  func notifyRouteParametersChanged() { parameterChanges += 1 }
  func openGate(withLeaseSeconds seconds: Double) -> UInt64 {
    guard captureArmed else { return 0 }
    openEpoch += 1
    return openEpoch
  }
  func renewLease(forEpoch epoch: UInt64, leaseSeconds: Double) -> Bool { captureArmed && epoch == openEpoch }
  func closeGate(forEpoch epoch: UInt64) -> Bool { openEpoch = 0; return true }
}

final class FakeModule {}

var failures = 0
func check(_ ok: Bool, _ what: String) {
  if !ok { print("FAIL: \(what)"); failures += 1 }
}

@main struct SessionHarness {
  static func main() throws {
    let session = T3RealtimeVoiceSession.shared
    let audio = AVAudioSession.sharedInstance()
    let device = T3RealtimeVoiceAudioDevice.shared()
    let center = NotificationCenter.default
    func interrupt() {
      center.post(name: AVAudioSession.interruptionNotification, object: nil,
        userInfo: [AVAudioSessionInterruptionTypeKey: UInt(1)])
    }
    func routeChange(_ reason: AVAudioSession.RouteChangeReason) {
      center.post(name: AVAudioSession.routeChangeNotification, object: nil,
        userInfo: [AVAudioSessionRouteChangeReasonKey: reason.rawValue])
    }
    let headset = AVAudioSessionRouteDescription(inputs: ["headset-mic"], outputs: ["headset"])

    // F3: interruption during a first prepare's activation.
    let a = FakeModule()
    audio.onActivate = interrupt
    do {
      _ = try session.prepare(owner: "a", module: a)
      check(false, "first prepare interrupted during activation must throw")
    } catch {
      check(error as? T3RealtimeVoiceSessionError == .interrupted, "first prepare reports interrupted")
    }
    check(!device.captureArmed && !session.ownsAudioSession, "interrupted first prepare leaves nothing owned or armed")

    // F3: interruption during a same-owner re-prepare (the reviewer's reproduction).
    audio.onActivate = nil
    let owner = try session.prepare(owner: "a", module: a)
    var events: [(String, T3RealtimeVoiceSession.Owner)] = []
    session.setRevokedListener(module: a) { events.append(($0, $1)) }
    audio.onActivate = interrupt
    do {
      _ = try session.prepare(owner: "a", module: a)
      check(false, "re-prepare interrupted during activation must throw")
    } catch {}
    audio.onActivate = nil
    check(!device.captureArmed, "interrupted re-prepare stays disarmed")
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) == 0, "no epoch after interrupted re-prepare")
    check(events.last?.1 == owner, "revocation event carries owner and generation")

    // F6: speaker override and a newly connected device both revoke; same route does not.
    _ = try session.prepare(owner: "a", module: a)
    check(try session.openGate(owner: "a", module: a, leaseSeconds: 30) != 0, "re-prepared owner opens")
    routeChange(.routeConfigurationChange)
    check(device.captureArmed && device.parameterChanges == 1, "same route keeps capture and refreshes parameters")
    audio.currentRoute = AVAudioSessionRouteDescription(inputs: ["headset-mic"], outputs: ["speaker"])
    routeChange(.override)
    check(!device.captureArmed, "speaker override revokes")
    audio.currentRoute = headset
    _ = try session.prepare(owner: "a", module: a)
    audio.currentRoute = AVAudioSessionRouteDescription(inputs: ["airpods-mic"], outputs: ["airpods"])
    routeChange(.newDeviceAvailable)
    check(!device.captureArmed, "a new headset is not resume consent")
    audio.currentRoute = headset

    // F5: a destroyed module's cleanup ends only its own owner.
    let b = FakeModule()
    check((try? session.prepare(owner: "b", module: b)) == nil, "second module is busy while the first owns")
    session.clearRevokedListener(module: b)
    check(!session.end(module: b), "other module cannot end the owner")
    check(session.end(module: a), "destroying the owning module ends its owner")
    let ownerB = try session.prepare(owner: "a", module: b)
    check(ownerB.generation != owner.generation, "replacement owner has a new generation")
    check(!session.end(module: a), "late cleanup from the old module is a no-op")
    check(session.ownsAudioSession, "replacement owner survives old cleanup")
    _ = session.end(module: b)

    if failures == 0 { print("T3RealtimeVoiceSession harness: all checks passed") }
    exit(failures == 0 ? 0 : 1)
  }
}
