#ifdef __cplusplus
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>

namespace t3voice {

/// Default-deny send gate for raw microphone blocks.
///
/// Control calls (arm, revoke, open, renew, close) may come from any non-real-time
/// thread and are serialized by a mutex. `admit`, `filter` and `fault` run on the
/// real-time IO thread and only touch atomics. Clocks are injected so tests drive them:
/// - capture ticks share the domain of `AudioTimeStamp.mHostTime` (mach_absolute_time);
/// - lease nanos come from a clock that keeps counting while the device sleeps.
///
/// Every revocation (control `revoke` or `fault`) bumps a counter. `arm` takes the
/// counter read before the caller started preparing, so a revocation observed during
/// preparation can never be overwritten by that preparation. Only genuine faults (IO,
/// unit setup or restart, interruption, route loss, media reset) also bump `faults`;
/// deliberate ends and WebRTC stops do not.
///
/// This is an epoch/lease gate only. It is not per-block local detector authorization.
class SendGate {
 public:
  static constexpr uint64_t kClosed = 0;
  static constexpr uint64_t kMaxLeaseNanos = 30ull * 1000 * 1000 * 1000;

  /// Read before preparing a capture lifetime; pass to `arm`.
  uint64_t revocations() const { return revocations_.load(); }

  /// Enables `open` unless anything revoked since `sinceRevocations` was read.
  bool arm(uint64_t sinceRevocations) {
    std::lock_guard<std::mutex> lock(control_);
    if (revocations_.load() != sinceRevocations) return false;
    armed_.store(true);
    // A concurrent IO fault bumps the counter before disarming, so one of the two
    // always observes the other.
    if (revocations_.load() == sinceRevocations) return true;
    armed_.store(false);
    return false;
  }

  /// Interruption, route loss, media reset, capture end, device termination.
  /// Atomic against `open`; only a fresh `arm` re-enables it.
  void revoke() {
    std::lock_guard<std::mutex> lock(control_);
    revocations_.fetch_add(1);
    armed_.store(false);
    epoch_.store(kClosed);
  }

  /// Any thread, including IO. Latches an audio fault without locking: same effect as
  /// `revoke`. The fault count moves last, so a thread that sees it also sees the gate disarmed.
  void fault() {
    revocations_.fetch_add(1);
    armed_.store(false);
    epoch_.store(kClosed);
    faults_.fetch_add(1);
  }

  /// Read by the control-side fault watch; never written outside `fault`.
  uint64_t faults() const { return faults_.load(); }

  /// Starts a fresh epoch. Blocks captured before `cutoffTicks` are never admitted.
  /// Returns kClosed when disarmed or the lease is empty.
  uint64_t open(uint64_t cutoffTicks, uint64_t nowLeaseNanos, uint64_t leaseNanos) {
    std::lock_guard<std::mutex> lock(control_);
    epoch_.store(kClosed);
    if (!armed_.load() || leaseNanos == 0) return kClosed;
    uint64_t epoch = nextEpoch_++;
    cutoffTicks_.store(cutoffTicks);
    leaseDeadline_.store(nowLeaseNanos + clamp(leaseNanos));
    epoch_.store(epoch);
    // An IO fault may have disarmed between the check and the publish.
    if (armed_.load()) return epoch;
    epoch_.store(kClosed);
    return kClosed;
  }

  /// Extends a still-open, unexpired epoch. Never reopens a closed or expired one.
  bool renew(uint64_t epoch, uint64_t nowLeaseNanos, uint64_t leaseNanos) {
    std::lock_guard<std::mutex> lock(control_);
    if (epoch == kClosed || epoch_.load() != epoch || !armed_.load()) return false;
    if (leaseNanos == 0 || nowLeaseNanos >= leaseDeadline_.load()) {
      epoch_.store(kClosed);
      return false;
    }
    leaseDeadline_.store(nowLeaseNanos + clamp(leaseNanos));
    // The IO thread may have expired or faulted the epoch between the checks and the store.
    return epoch_.load() == epoch && armed_.load();
  }

  /// Closes only the named epoch, so stale cleanup cannot close a newer one.
  bool close(uint64_t epoch) {
    std::lock_guard<std::mutex> lock(control_);
    if (epoch == kClosed || epoch_.load() != epoch) return false;
    epoch_.store(kClosed);
    return true;
  }

  /// IO thread. True when a block whose first sample was captured at `blockTicks`
  /// may carry real samples. Expired leases close the gate here without JS.
  bool admit(uint64_t blockTicks, uint64_t nowLeaseNanos) {
    uint64_t epoch = epoch_.load();
    if (epoch == kClosed || !armed_.load()) return false;
    uint64_t deadline = leaseDeadline_.load();
    uint64_t cutoff = cutoffTicks_.load();
    if (epoch_.load() != epoch) return false;
    if (nowLeaseNanos >= deadline) {
      epoch_.compare_exchange_strong(epoch, kClosed);
      return false;
    }
    return blockTicks >= cutoff;
  }

  /// IO thread. Zeroes a captured block unless it is admitted; returns whether it was.
  bool filter(int16_t *_Nonnull samples, size_t count, bool hostTimeValid, uint64_t blockTicks,
              uint64_t nowLeaseNanos) {
    bool admitted = hostTimeValid && admit(blockTicks, nowLeaseNanos);
    if (!admitted) std::memset(samples, 0, count * sizeof(int16_t));
    return admitted;
  }

  uint64_t epoch() const { return epoch_.load(); }
  bool armed() const { return armed_.load(); }

 private:
  static uint64_t clamp(uint64_t leaseNanos) {
    return leaseNanos < kMaxLeaseNanos ? leaseNanos : kMaxLeaseNanos;
  }

  std::mutex control_;
  std::atomic<uint64_t> revocations_{0};
  std::atomic<uint64_t> faults_{0};
  std::atomic<bool> armed_{false};
  std::atomic<uint64_t> epoch_{kClosed};
  std::atomic<uint64_t> cutoffTicks_{UINT64_MAX};
  std::atomic<uint64_t> leaseDeadline_{0};
  uint64_t nextEpoch_ = 1;
};

/// ADM thread, after an accepted route change. WebRTC replaces the buffers its IO callbacks
/// use when parameters change, so `notify` may run only once `stop` reported IO stopped.
/// A failed stop leaves the buffers alone and faults; restart happens only while armed.
template <class Stop, class Notify, class Start>
void RefreshIOParameters(bool running, SendGate &gate, Stop stop, Notify notify, Start start) {
  if (running && !stop()) {
    gate.fault();
    return;
  }
  notify();
  if (running && gate.armed() && !start()) gate.fault();
}

}  // namespace t3voice
#endif

#ifdef __OBJC__
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The single capture/playout owner for realtime voice, installed into
/// react-native-webrtc before its peer connection factory exists. Raw microphone
/// blocks reach WebRTC only through the send gate; everything else is zeros.
/// The audio unit is created only after the voice session arms capture.
@interface T3RealtimeVoiceAudioDevice : NSObject

+ (instancetype)shared;
/// Call before any JS imports react-native-webrtc. Returns NO when another
/// device is already installed.
+ (BOOL)installIntoWebRTCModuleOptions;

/// YES while react-native-webrtc's options still point at this device.
@property(class, nonatomic, readonly) BOOL installedInWebRTCModuleOptions;
/// YES once WebRTC's factory adopted this device. Until then a peer connection could
/// be using another audio device, so callers must not attach audio tracks.
@property(nonatomic, readonly) BOOL adoptedByWebRTC;
@property(nonatomic, readonly) BOOL captureArmed;
@property(nonatomic, readonly) uint64_t openEpoch;
/// Read before preparing; any revocation after this read makes `armCaptureSince:` fail.
@property(nonatomic, readonly) uint64_t revocationCount;
/// Genuine faults latched since launch. A change means the gate was already closed by it.
@property(nonatomic, readonly) uint64_t faultCount;

/// Called by the voice session after it activated its own AVAudioSession. Returns NO,
/// leaving capture disarmed, if anything revoked since `revocationCount` was read.
- (BOOL)armCaptureSince:(uint64_t)revocationCount NS_SWIFT_NAME(armCapture(since:));
/// Closes sending and silences playout immediately, from any thread. Deliberate, not a fault.
- (void)revokeCapture;
/// A genuine fault seen outside IO (interruption, route loss, media reset). Closes now and
/// moves `faultCount`, exactly as an IO fault does. Atomics only.
- (void)faultCapture;
/// Closes sending now, then on the ADM thread stops and disposes the audio unit and clears
/// its running state. `completion` runs exactly once, after the unit is gone, on an
/// arbitrary thread and possibly before this returns, so it must not take caller locks.
- (void)endCaptureWithCompletion:(dispatch_block_t)completion NS_SWIFT_NAME(endCapture(completion:));
/// After an accepted route change: stops IO, lets WebRTC rebuild its buffers for the
/// new IO parameters, then restarts IO only if capture is still armed.
- (void)notifyRouteParametersChanged;

/// Fresh epoch for blocks captured after now plus input latency. 0 when disarmed
/// or not adopted by WebRTC.
- (uint64_t)openGateWithLeaseSeconds:(double)leaseSeconds;
- (BOOL)renewLeaseForEpoch:(uint64_t)epoch leaseSeconds:(double)leaseSeconds;
- (BOOL)closeGateForEpoch:(uint64_t)epoch;

@end

NS_ASSUME_NONNULL_END
#endif
