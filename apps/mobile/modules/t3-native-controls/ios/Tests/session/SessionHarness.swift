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
  var faultCount: UInt64 = 0
  var afterRevoke: (() -> Void)?
  var parameterChanges = 0
  func armCapture(since: UInt64) -> Bool {
    AVAudioSession.onPoint?("beforeArm")
    defer { AVAudioSession.onPoint?("afterArm") }
    guard revocationCount == since else { return false }
    captureArmed = true
    return true
  }
  /// Models SendGate::fault(): the IO thread disarms and bumps the counter, no observer runs.
  func fault() {
    revocationCount += 1
    captureArmed = false
    openEpoch = 0
    faultCount += 1
  }
  func revokeCapture() {
    revocationCount += 1
    captureArmed = false
    openEpoch = 0
    let hook = afterRevoke
    afterRevoke = nil
    hook?()
    AVAudioSession.onPoint?("afterRevoke")
  }
  func faultCapture() { fault() }
  /// Models a running audio unit that only the ADM thread may stop.
  var unitLive = false
  /// Blocks posted to the fake ADM thread; `runADM` runs them.
  var adm: [() -> Void] = []
  func endCapture(completion: @escaping () -> Void) {
    revocationCount += 1
    captureArmed = false
    openEpoch = 0
    adm.append { [self] in
      unitLive = false
      completion()
    }
  }
  func runADM() {
    let work = adm
    adm = []
    work.forEach { $0() }
  }
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

/// Stands in for the session's control-queue timer: ticks run only when the test drains them.
final class ManualFaultWatches {
  struct Watch {
    let tick: () -> Void
    var cancelled = false
  }
  var watches: [Watch] = []
  func start(_ tick: @escaping () -> Void) -> () -> Void {
    let index = watches.count
    watches.append(Watch(tick: tick))
    return { [self] in watches[index].cancelled = true }
  }
  /// Runs one watch's tick even if cancelled, as a tick queued before the cancel would.
  func tick(_ index: Int) {
    if watches.indices.contains(index) { watches[index].tick() }
  }
  func cancelled(_ index: Int) -> Bool {
    watches.indices.contains(index) && watches[index].cancelled
  }
  /// Runs every live watch once, as one timer period would.
  func drainLive() {
    for watch in watches where !watch.cancelled { watch.tick() }
  }
}

var failures = 0
func check(_ ok: Bool, _ what: String) {
  if !ok { print("FAIL: \(what)"); failures += 1 }
}

@main struct SessionHarness {
  static func main() throws {
    let session = T3RealtimeVoiceSession.shared
    let faultWatches = ManualFaultWatches()
    session.startFaultWatch = faultWatches.start
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
    /// Lets the ADM thread finish any teardown, then waits for the release it schedules.
    func settle() {
      device.runADM()
      T3RealtimeVoiceSession.controlQueue.sync {}
    }

    // F3: interruption during a first prepare's activation.
    let a = FakeModule()
    audio.onActivate = interrupt
    do {
      _ = try session.prepare(owner: "a", module: a)
      check(false, "first prepare interrupted during activation must throw")
    } catch {
      check(error as? T3RealtimeVoiceSessionError == .interrupted, "first prepare reports interrupted")
    }
    settle()
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
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) ?? 0 == 0, "no epoch after interrupted re-prepare")
    settle()
    check(events.last?.0 == "interruption" && events.last?.1 == owner, "revocation event carries reason, owner and generation")

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
    settle()
    let ownerB = try session.prepare(owner: "a", module: b)
    check(ownerB.generation != owner.generation, "replacement owner has a new generation")
    check(!session.end(module: a), "late cleanup from the old module is a no-op")
    check(session.ownsAudioSession, "replacement owner survives old cleanup")
    _ = session.end(module: b)
    settle()

    // Review r2 R2-1: an interruption after prepare's own revoke but before it reads the
    // device counter must still fail that prepare.
    _ = try session.prepare(owner: "a", module: a)
    device.afterRevoke = interrupt
    check((try? session.prepare(owner: "a", module: a)) == nil, "prepare interrupted before its counter read throws")
    check(!device.captureArmed, "interruption before counter read stays disarmed")
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) ?? 0 == 0, "no epoch after early interruption")
    _ = session.end(module: a)
    settle()

    // Review r2 R2-3: foreign category during activation, unknown reason, empty route.
    audio.onActivate = {
      try! audio.setCategory(.playback, mode: .default, options: [])
      routeChange(.categoryChange)
    }
    check((try? session.prepare(owner: "a", module: a)) == nil, "foreign category during activation fails prepare")
    settle()
    check(!device.captureArmed && !session.ownsAudioSession, "foreign category leaves nothing armed or owned")
    audio.onActivate = nil
    _ = try session.prepare(owner: "a", module: a)
    _ = try session.openGate(owner: "a", module: a, leaseSeconds: 30)
    center.post(name: AVAudioSession.routeChangeNotification, object: nil,
      userInfo: [AVAudioSessionRouteChangeReasonKey: UInt(9999)])
    check(!device.captureArmed && device.openEpoch == 0, "unrecognized route reason revokes")
    _ = session.end(module: a)
    settle()
    audio.currentRoute = AVAudioSessionRouteDescription(inputs: [], outputs: [])
    do {
      _ = try session.prepare(owner: "a", module: a)
      check(false, "empty route must not authorize")
    } catch {
      check(error as? T3RealtimeVoiceSessionError == .invalidRoute, "empty route reports invalidRoute")
    }
    settle()
    check(!device.captureArmed && !session.ownsAudioSession, "empty route leaves nothing armed or owned")
    audio.currentRoute = AVAudioSessionRouteDescription(inputs: ["old-mic"], outputs: [])
    check((try? session.prepare(owner: "a", module: a)) == nil, "input-only route must not authorize")
    settle()
    audio.currentRoute = headset

    // Review r2 R2-4: an observer already running for an ended owner must not revoke, or
    // speak for, the replacement. Semaphores order the threads; nothing sleeps.
    let old = try session.prepare(owner: "a", module: a)
    var staleEvents: [T3RealtimeVoiceSession.Owner] = []
    session.setRevokedListener(module: a) { _, owner in staleEvents.append(owner) }
    let entered = DispatchSemaphore(value: 0)
    let resume = DispatchSemaphore(value: 0)
    let done = DispatchSemaphore(value: 0)
    AVAudioSession.onSharedInstance = {
      if Thread.current.name == "old-route" {
        entered.signal()
        resume.wait()
      }
    }
    let thread = Thread {
      Thread.current.name = "old-route"
      routeChange(.oldDeviceUnavailable)
      done.signal()
    }
    thread.start()
    entered.wait()
    _ = session.end(module: a)
    settle()
    let replacement = try session.prepare(owner: "b", module: b)
    var replacementEvents: [T3RealtimeVoiceSession.Owner] = []
    session.setRevokedListener(module: b) { _, owner in replacementEvents.append(owner) }
    let fresh = try session.openGate(owner: "b", module: b, leaseSeconds: 30)
    resume.signal()
    done.wait()
    AVAudioSession.onSharedInstance = nil
    check(replacement.generation != old.generation, "replacement has its own generation")
    check(device.captureArmed && device.openEpoch == fresh, "stale observer does not revoke the replacement")
    check(replacementEvents.isEmpty && staleEvents.isEmpty, "stale observer emits no event")
    _ = session.end(module: b)
    settle()

    // Council repair: every point inside prepare, after its native lock entry, must fail the
    // attempt for both an IO fault (no observer) and an interruption (observer), and a fresh
    // prepare afterwards must succeed. Each injection fires once, at the named occurrence.
    let points = [
      ("sharedInstance", 1), ("afterRevoke", 1), ("setCategory", 1), ("setActive", 1),
      ("currentRoute", 1), ("beforeArm", 1), ("afterArm", 1), ("currentRoute", 2),
    ]
    for (point, occurrence) in points {
      for kind in ["fault", "interruption"] {
        let name = "\(kind) at \(point)#\(occurrence)"
        _ = try session.prepare(owner: "a", module: a)
        var seen = 0
        AVAudioSession.onPoint = { hit in
          guard hit == point else { return }
          seen += 1
          guard seen == occurrence else { return }
          AVAudioSession.onPoint = nil
          if kind == "fault" { device.fault() } else { interrupt() }
        }
        let rejected = (try? session.prepare(owner: "a", module: a)) == nil
        AVAudioSession.onPoint = nil
        check(seen >= occurrence, "\(name): injection point reached")
        check(rejected, "\(name): prepare fails")
        check(!device.captureArmed, "\(name): stays disarmed")
        check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) ?? 0 == 0, "\(name): no epoch")
        settle()
        _ = try? session.prepare(owner: "a", module: a)
        check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) ?? 0 != 0, "\(name): fresh retry opens")
        _ = session.end(module: a)
        settle()
      }
    }
    // A fault before the attempt's lock entry belongs to the old lifetime.
    device.fault()
    _ = try session.prepare(owner: "a", module: a)
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) ?? 0 != 0, "old fault does not block a new prepare")
    _ = session.end(module: a)
    settle()

    // F7: a fault in the current incarnation is cleaned up natively and reported once.
    var faultEvents: [(String, T3RealtimeVoiceSession.Owner)] = []
    session.setRevokedListener(module: a) { faultEvents.append(($0, $1)) }
    let faulted = try session.prepare(owner: "a", module: a)
    let faultedEpoch = try session.openGate(owner: "a", module: a, leaseSeconds: 30)
    check(faultedEpoch != 0, "fault case opens first")
    device.fault()
    check(!device.captureArmed && !device.renewLease(forEpoch: faultedEpoch, leaseSeconds: 30),
      "IO fault closes before any control work")
    check(session.ownsAudioSession && faultEvents.isEmpty, "nothing is published before the control drain")
    let faultedWatch = faultWatches.watches.count - 1
    device.unitLive = true
    faultWatches.drainLive()
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) == nil, "control drain ends the faulted owner")
    // F1: the session is released only once the ADM thread stopped and disposed the unit.
    check(device.adm.count == 1, "control drain asks the ADM thread to tear the unit down")
    check(session.ownsAudioSession && audio.active && audio.category == .playAndRecord && faultEvents.isEmpty,
      "nothing is released or published while the unit may still run")
    check((try? session.prepare(owner: "a", module: a)) == nil, "nothing prepares before teardown finishes")
    settle()
    check(!device.unitLive, "teardown disposes the audio unit")
    check(!session.ownsAudioSession && !audio.active, "release deactivates after teardown")
    check(audio.category == .playback, "control drain restores the previous audio session")
    check(faultEvents.count == 1 && faultEvents.first?.0 == "audioFault" && faultEvents.first?.1 == faulted,
      "one audioFault event with the faulted owner and generation")
    check(faultWatches.cancelled(faultedWatch), "control drain stops its own watch")
    faultWatches.tick(faultedWatch)  // a tick already queued before the cancel
    faultWatches.drainLive()
    check(faultEvents.count == 1, "the fault is reported once")
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) == nil, "faulted owner cannot open")

    // No fault: ticks do nothing.
    _ = try session.prepare(owner: "a", module: a)
    faultWatches.drainLive()
    check(session.ownsAudioSession && device.captureArmed && faultEvents.count == 1, "ticks without a fault are inert")

    // Explicit retry after an undrained old fault: the same owner prepares again, and the old
    // incarnation's delayed tick neither ends it nor reports.
    let oldWatch = faultWatches.watches.count - 1
    device.fault()
    let retried = try session.prepare(owner: "a", module: a)
    check(faultWatches.cancelled(oldWatch), "re-prepare stops the old watch")
    faultWatches.tick(oldWatch)
    faultWatches.drainLive()
    check(session.ownsAudioSession && device.captureArmed, "old fault tick does not end the retried owner")
    check((try? session.openGate(owner: "a", module: a, leaseSeconds: 30)) ?? 0 != 0, "retried owner opens")
    check(faultEvents.count == 1, "old fault tick does not report")
    _ = retried

    // Replacement: A's tick, delayed past A's end and B's prepare, must not revoke B or report
    // under B's generation, and B's own watch ignores the old fault.
    let watchA = faultWatches.watches.count - 1
    device.fault()
    check(session.end(module: a), "JS ends A after its fault")
    settle()
    var eventsB: [(String, T3RealtimeVoiceSession.Owner)] = []
    _ = try session.prepare(owner: "b", module: b)
    session.setRevokedListener(module: b) { eventsB.append(($0, $1)) }
    let epochB = try session.openGate(owner: "b", module: b, leaseSeconds: 30)
    faultWatches.tick(watchA)
    faultWatches.drainLive()
    check(device.captureArmed && device.openEpoch == epochB, "stale fault tick leaves the replacement open")
    check(eventsB.isEmpty && faultEvents.count == 1, "stale fault tick emits nothing")

    // Destroy: module end stops the watch; a later fault and tick do nothing for that owner.
    let watchB = faultWatches.watches.count - 1
    check(session.end(module: b), "module destroy ends B")
    check(faultWatches.cancelled(watchB), "module end stops the fault watch")
    device.fault()
    faultWatches.tick(watchB)
    settle()
    check(eventsB.isEmpty && !session.ownsAudioSession, "fault after destroy emits nothing")

    // F2: a fault inside a re-prepare fails it, leaves no watch, and ends the retained owner
    // natively before anyone calls end.
    session.setRevokedListener(module: a) { faultEvents.append(($0, $1)) }
    let reprepared = try session.prepare(owner: "a", module: a)
    let eventsBefore = faultEvents.count
    device.afterRevoke = { device.fault() }
    check((try? session.prepare(owner: "a", module: a)) == nil, "fault inside prepare still fails it")
    check(faultWatches.watches.allSatisfy(\.cancelled), "failed prepare starts no fault watch")
    settle()
    check(!session.ownsAudioSession && !audio.active && audio.category == .playback,
      "failed re-prepare releases the owner and audio session without end")
    check(faultEvents.count == eventsBefore + 1 && faultEvents.last?.0 == "audioFault" && faultEvents.last?.1 == reprepared,
      "failed re-prepare reports its fault once")
    check(!session.end(module: a), "nothing is left for an explicit end")

    // Interruption, route loss and media reset are faults too: the gate closes at once, and
    // the watch ends the owner natively and reports the specific reason after teardown.
    let observerFaults: [(String, () -> Void)] = [
      ("interruption", interrupt),
      ("route:2", { routeChange(.oldDeviceUnavailable) }),
      ("mediaServicesReset", { center.post(name: AVAudioSession.mediaServicesWereResetNotification, object: nil) }),
    ]
    for (reason, post) in observerFaults {
      let faultedOwner = try session.prepare(owner: "a", module: a)
      let epoch = try session.openGate(owner: "a", module: a, leaseSeconds: 30)
      let before = faultEvents.count
      post()
      check(!device.captureArmed && !device.renewLease(forEpoch: epoch, leaseSeconds: 30), "\(reason): closes synchronously")
      check(faultEvents.count == before, "\(reason): nothing is published before cleanup")
      faultWatches.drainLive()
      settle()
      check(!session.ownsAudioSession && !audio.active, "\(reason): owner and audio session released without JS")
      check(faultEvents.count == before + 1 && faultEvents.last?.0 == reason && faultEvents.last?.1 == faultedOwner,
        "\(reason): reported once with its reason")
    }

    if failures == 0 { print("T3RealtimeVoiceSession harness: all checks passed") }
    exit(failures == 0 ? 0 : 1)
  }
}
