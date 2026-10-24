// Host-run check of the realtime voice send gate with synthetic samples and
// injected clocks. Not part of the pod (see exclude_files):
//   xcrun clang++ -std=c++20 -Wall -Wextra -I.. T3RealtimeVoiceSendGateTest.cpp -o /tmp/gate && /tmp/gate
#include "T3RealtimeVoiceAudioDevice.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {
using t3voice::SendGate;
constexpr uint64_t kSecond = 1000ull * 1000 * 1000;
int failures = 0;

void check(bool ok, const char *what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    failures++;
  }
}

// Returns how many synthetic nonzero samples survived the gate.
size_t sent(SendGate &gate, uint64_t blockTicks, uint64_t now, bool hostTimeValid = true) {
  std::vector<int16_t> block(480, 1234);
  gate.filter(block.data(), block.size(), hostTimeValid, blockTicks, now);
  size_t nonzero = 0;
  for (int16_t sample : block) nonzero += sample != 0;
  return nonzero;
}
}  // namespace

int main() {
  {
    SendGate gate;
    check(sent(gate, 100, 0) == 0, "closed by default sends nothing");
    check(gate.open(0, 0, 10 * kSecond) == SendGate::kClosed, "open refused before arm");
    check(sent(gate, 100, 0) == 0, "still nothing after refused open");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t epoch = gate.open(/*cutoff*/ 1000, /*now*/ 0, 10 * kSecond);
    check(epoch != SendGate::kClosed, "armed open returns epoch");
    check(sent(gate, 999, 1) == 0, "block captured before cutoff is zeroed");
    check(sent(gate, 1000, 1) == 480, "block at cutoff is sent");
    check(sent(gate, 2000, 1, /*hostTimeValid*/ false) == 0, "block without host time is zeroed");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t epoch = gate.open(0, 0, 10 * kSecond);
    check(sent(gate, 5, 10 * kSecond) == 0, "nothing sent at lease deadline");
    check(gate.epoch() == SendGate::kClosed, "expiry closes the gate on the IO path");
    check(!gate.renew(epoch, 10 * kSecond, 10 * kSecond), "renew after expiry fails");
    check(sent(gate, 5, 10 * kSecond + 1) == 0, "renew after expiry does not reopen");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t epoch = gate.open(0, 0, 10 * kSecond);
    check(!gate.renew(epoch, 10 * kSecond, 10 * kSecond), "renew at deadline fails without IO");
    check(gate.epoch() == SendGate::kClosed, "late renew closes instead of extending");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t epoch = gate.open(0, 0, 10 * kSecond);
    check(gate.renew(epoch, 9 * kSecond, 10 * kSecond), "renew before deadline extends");
    check(sent(gate, 5, 18 * kSecond) == 480, "renewed lease still sends");
    check(gate.close(epoch), "matching close");
    check(!gate.renew(epoch, 18 * kSecond, 10 * kSecond), "renew after close fails");
    check(sent(gate, 5, 18 * kSecond) == 0, "renew after close does not reopen");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t epoch = gate.open(0, 0, 1000 * kSecond);
    check(sent(gate, 5, SendGate::kMaxLeaseNanos) == 0, "lease is clamped to the maximum");
    check(!gate.renew(epoch, SendGate::kMaxLeaseNanos, 1000 * kSecond), "clamped lease stays expired");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t stale = gate.open(100, 0, 10 * kSecond);
    uint64_t current = gate.open(500, 0, 10 * kSecond);
    check(current != stale, "fresh epoch differs");
    check(!gate.close(stale), "stale close is a no-op");
    check(!gate.renew(stale, 1, 10 * kSecond), "stale renew is a no-op");
    check(gate.epoch() == current, "current epoch survives stale cleanup");
    check(sent(gate, 300, 1) == 0, "frames queued between the two cutoffs are zeroed");
    check(sent(gate, 500, 1) == 480, "fresh frames after the new cutoff are sent");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t before = gate.open(0, 0, 10 * kSecond);
    gate.revoke();  // interruption, route loss, media reset
    check(sent(gate, 5, 1) == 0, "revoke stops sending");
    check(!gate.renew(before, 1, 10 * kSecond), "revoke cannot be undone by renew");
    check(gate.open(0, 1, 10 * kSecond) == SendGate::kClosed, "open refused until re-armed");
    gate.arm(gate.revocations());
    uint64_t after = gate.open(900, 2, 10 * kSecond);
    check(after > before, "re-armed open uses a new epoch");
    check(sent(gate, 899, 3) == 0, "pre-cutoff frames stay private after re-arm");
  }
  {
    // Review r1 F2: capture stop raced a concurrent open. Stop now revokes, which is
    // atomic against open, instead of reading the epoch and closing it separately.
    SendGate gate;
    gate.arm(gate.revocations());
    gate.open(10, 0, 10 * kSecond);
    gate.revoke();  // stopRecording / terminateDevice
    check(gate.open(20, 1, 10 * kSecond) == SendGate::kClosed, "open after capture stop is refused");
    check(sent(gate, 20, 2) == 0, "nothing sent after capture stop");
  }
  {
    // Review r1 F3: a revocation observed while preparing must not be undone by arming.
    SendGate gate;
    uint64_t since = gate.revocations();
    gate.revoke();  // interruption during activation
    check(!gate.arm(since), "arm refused after a revocation during prepare");
    check(gate.open(0, 0, 10 * kSecond) == SendGate::kClosed, "no epoch after a refused arm");
    check(gate.arm(gate.revocations()), "a fresh prepare can arm");
  }
  {
    // Review r1 F7: an IO fault latches closed until a fresh arm.
    SendGate gate;
    uint64_t since = gate.revocations();
    gate.arm(since);
    uint64_t epoch = gate.open(0, 0, 10 * kSecond);
    gate.fault();  // render or delivery error on the IO thread
    check(sent(gate, 5, 1) == 0, "fault stops sending");
    check(!gate.renew(epoch, 1, 10 * kSecond), "renew after fault fails");
    check(sent(gate, 6, 2) == 0, "later good callback still sends nothing");
    check(gate.open(0, 2, 10 * kSecond) == SendGate::kClosed, "open refused after fault");
    check(!gate.arm(since), "stale prepare cannot arm over a fault");
  }
  {
    // Review r2 R2-2: a failed IO stop must not let WebRTC replace buffers or restart.
    SendGate gate;
    gate.arm(gate.revocations());
    uint64_t epoch = gate.open(0, 0, 10 * kSecond);
    int notified = 0, started = 0;
    t3voice::RefreshIOParameters(
        true, gate, [] { return false; }, [&] { notified++; }, [&] { started++; return true; });
    check(notified == 0 && started == 0, "failed stop skips parameter updates and restart");
    check(!gate.armed() && gate.epoch() == SendGate::kClosed, "failed stop revokes");
    check(!gate.renew(epoch, 1, 10 * kSecond), "failed stop epoch cannot renew");
  }
  {
    SendGate gate;
    gate.arm(gate.revocations());
    int notified = 0, started = 0;
    t3voice::RefreshIOParameters(
        true, gate, [] { return true; }, [&] { notified++; }, [&] { started++; return true; });
    check(notified == 1 && started == 1 && gate.armed(), "stopped IO updates then restarts while armed");
    gate.revoke();
    t3voice::RefreshIOParameters(
        true, gate, [] { return true; }, [&] { notified++; }, [&] { started++; return true; });
    check(notified == 2 && started == 1, "revoked capture stays stopped after the update");
    gate.arm(gate.revocations());
    t3voice::RefreshIOParameters(
        true, gate, [] { return true; }, [] {}, [] { return false; });
    check(!gate.armed(), "failed restart revokes");
  }
  {
    // Ordering the session's prepare relies on: baseline = revocations() + 1 read at lock
    // entry, then exactly one deliberate revoke, then arm(baseline). Faults on either side
    // of that revoke fail the attempt; a fault before the baseline does not.
    auto attempt = [](SendGate &gate, bool faultBefore, bool faultAfter) {
      uint64_t baseline = gate.revocations() + 1;
      if (faultBefore) gate.fault();
      gate.revoke();
      if (faultAfter) gate.fault();
      return gate.arm(baseline);
    };
    SendGate gate;
    check(attempt(gate, false, false), "clean prepare arms");
    check(!attempt(gate, true, false), "fault before the deliberate revoke fails prepare");
    check(!attempt(gate, false, true), "fault after the deliberate revoke fails prepare");
    gate.fault();
    check(attempt(gate, false, false), "fault before lock entry does not block a fresh prepare");
  }
  if (failures == 0) std::puts("T3RealtimeVoiceSendGateTest: all checks passed");
  return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
