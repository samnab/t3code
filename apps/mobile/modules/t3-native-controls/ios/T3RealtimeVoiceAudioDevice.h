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
/// thread and are serialized by a mutex. `admit` runs on the real-time IO thread and
/// only touches atomics. Clocks are injected so tests drive them:
/// - capture ticks share the domain of `AudioTimeStamp.mHostTime` (mach_absolute_time);
/// - lease nanos come from a clock that keeps counting while the device sleeps.
///
/// This is an epoch/lease gate only. It is not per-block local detector authorization.
class SendGate {
 public:
  static constexpr uint64_t kClosed = 0;
  static constexpr uint64_t kMaxLeaseNanos = 30ull * 1000 * 1000 * 1000;

  /// The voice session owns an active audio session; opening becomes possible.
  void arm() {
    std::lock_guard<std::mutex> lock(control_);
    armed_.store(true, std::memory_order_release);
  }

  /// Interruption, route loss, media reset, capture end. Only a fresh `arm` re-enables `open`.
  void revoke() {
    std::lock_guard<std::mutex> lock(control_);
    armed_.store(false, std::memory_order_release);
    epoch_.store(kClosed, std::memory_order_release);
  }

  /// Starts a fresh epoch. Blocks captured before `cutoffTicks` are never admitted.
  /// Returns kClosed when disarmed or the lease is empty.
  uint64_t open(uint64_t cutoffTicks, uint64_t nowLeaseNanos, uint64_t leaseNanos) {
    std::lock_guard<std::mutex> lock(control_);
    epoch_.store(kClosed, std::memory_order_release);
    if (!armed_.load(std::memory_order_acquire) || leaseNanos == 0) return kClosed;
    uint64_t epoch = nextEpoch_++;
    cutoffTicks_.store(cutoffTicks, std::memory_order_release);
    leaseDeadline_.store(nowLeaseNanos + clamp(leaseNanos), std::memory_order_release);
    epoch_.store(epoch, std::memory_order_release);
    return epoch;
  }

  /// Extends a still-open, unexpired epoch. Never reopens a closed or expired one.
  bool renew(uint64_t epoch, uint64_t nowLeaseNanos, uint64_t leaseNanos) {
    std::lock_guard<std::mutex> lock(control_);
    if (epoch == kClosed || epoch_.load(std::memory_order_acquire) != epoch) return false;
    if (leaseNanos == 0 || nowLeaseNanos >= leaseDeadline_.load(std::memory_order_acquire)) {
      epoch_.store(kClosed, std::memory_order_release);
      return false;
    }
    leaseDeadline_.store(nowLeaseNanos + clamp(leaseNanos), std::memory_order_release);
    // The IO thread may have expired the epoch between the checks and the store.
    return epoch_.load(std::memory_order_acquire) == epoch;
  }

  /// Closes only the named epoch, so stale cleanup cannot close a newer one.
  bool close(uint64_t epoch) {
    std::lock_guard<std::mutex> lock(control_);
    if (epoch == kClosed || epoch_.load(std::memory_order_acquire) != epoch) return false;
    epoch_.store(kClosed, std::memory_order_release);
    return true;
  }

  /// IO thread. True when a block whose first sample was captured at `blockTicks`
  /// may carry real samples. Expired leases close the gate here without JS.
  bool admit(uint64_t blockTicks, uint64_t nowLeaseNanos) {
    uint64_t epoch = epoch_.load(std::memory_order_acquire);
    if (epoch == kClosed) return false;
    uint64_t deadline = leaseDeadline_.load(std::memory_order_acquire);
    uint64_t cutoff = cutoffTicks_.load(std::memory_order_acquire);
    if (epoch_.load(std::memory_order_acquire) != epoch) return false;
    if (nowLeaseNanos >= deadline) {
      epoch_.compare_exchange_strong(epoch, kClosed, std::memory_order_acq_rel);
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

  uint64_t epoch() const { return epoch_.load(std::memory_order_acquire); }
  bool armed() const { return armed_.load(std::memory_order_acquire); }

 private:
  static uint64_t clamp(uint64_t leaseNanos) {
    return leaseNanos < kMaxLeaseNanos ? leaseNanos : kMaxLeaseNanos;
  }

  std::mutex control_;
  std::atomic<bool> armed_{false};
  std::atomic<uint64_t> epoch_{kClosed};
  std::atomic<uint64_t> cutoffTicks_{UINT64_MAX};
  std::atomic<uint64_t> leaseDeadline_{0};
  uint64_t nextEpoch_ = 1;
};

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

/// Called by the voice session after it activated its own AVAudioSession.
- (void)armCapture;
/// Closes sending and silences playout immediately, from any thread.
- (void)revokeCapture;
/// Revokes and tells WebRTC the audio unit must be rebuilt (media services reset).
- (void)revokeCaptureAndResetUnit;
/// Tells WebRTC IO buffer/latency may have changed after a route change.
- (void)notifyRouteParametersChanged;

/// Fresh epoch for blocks captured after now plus input latency. 0 when disarmed
/// or not adopted by WebRTC.
- (uint64_t)openGateWithLeaseSeconds:(double)leaseSeconds;
- (BOOL)renewLeaseForEpoch:(uint64_t)epoch leaseSeconds:(double)leaseSeconds;
- (BOOL)closeGateForEpoch:(uint64_t)epoch;

@end

NS_ASSUME_NONNULL_END
#endif
