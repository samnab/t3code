#import "T3RealtimeVoiceAudioDevice.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <WebRTC/WebRTC.h>
#import <mach/mach_time.h>
#include <time.h>
#include <vector>

// Typed injection point from the react-native-webrtc pod (155.0.1):
// `+[WebRTCModuleOptions sharedInstance].audioDevice`, read once in `-[WebRTCModule init]`.
#if __has_include(<react-native-webrtc/WebRTCModuleOptions.h>)
#import <react-native-webrtc/WebRTCModuleOptions.h>
#elif __has_include(<react_native_webrtc/WebRTCModuleOptions.h>)
#import <react_native_webrtc/WebRTCModuleOptions.h>
#elif __has_include("WebRTCModuleOptions.h")
#import "WebRTCModuleOptions.h"
#else
#error "react-native-webrtc WebRTCModuleOptions.h is required for the realtime voice audio device"
#endif

namespace {
// Client-side format of the voice-processing unit. VPIO converts from whatever the
// route runs at (16 kHz HFP, 48 kHz built-in), so WebRTC always sees this rate.
constexpr double kSampleRate = 48000.0;
constexpr UInt32 kInputBus = 1;
constexpr UInt32 kOutputBus = 0;
constexpr UInt32 kMaxFramesPerSlice = 4096;

uint64_t LeaseNowNanos() { return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW); }

uint64_t LeaseNanos(double seconds) {
  if (!(seconds > 0)) return 0;
  double clamped = MIN(seconds, t3voice::SendGate::kMaxLeaseNanos / 1e9);
  return (uint64_t)(clamped * 1e9);
}

uint64_t SecondsToHostTicks(double seconds) {
  mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  return (uint64_t)(MAX(seconds, 0) * 1e9 * timebase.denom / timebase.numer);
}
}  // namespace

@interface T3RealtimeVoiceAudioDevice () <RTCAudioDevice>
@end

@implementation T3RealtimeVoiceAudioDevice {
  t3voice::SendGate _gate;
  // Everything below is touched only on the WebRTC ADM thread, except that the IO
  // callbacks read the unit, scratch buffer and the two delegate blocks.
  id<RTCAudioDeviceDelegate> _delegate;
  RTCAudioDeviceDeliverRecordedDataBlock _deliverRecordedData;
  RTCAudioDeviceGetPlayoutDataBlock _getPlayoutData;
  AudioUnit _unit;
  std::vector<int16_t> _inputScratch;
  BOOL _playoutInitialized, _recordingInitialized, _playing, _recording;
}

+ (instancetype)shared {
  static T3RealtimeVoiceAudioDevice *device;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ device = [[self alloc] init]; });
  return device;
}

+ (BOOL)installIntoWebRTCModuleOptions {
  WebRTCModuleOptions *options = [WebRTCModuleOptions sharedInstance];
  if (options.audioDevice != nil && options.audioDevice != [self shared]) return NO;
  options.audioDevice = [self shared];
  return YES;
}

+ (BOOL)installedInWebRTCModuleOptions {
  return [WebRTCModuleOptions sharedInstance].audioDevice == [self shared];
}

- (instancetype)init {
  if (self = [super init]) _inputScratch.resize(kMaxFramesPerSlice);
  return self;
}

#pragma mark - Gate

- (BOOL)adoptedByWebRTC { return _deliverRecordedData != nil; }
- (BOOL)captureArmed { return _gate.armed(); }
- (uint64_t)openEpoch { return _gate.epoch(); }

- (void)armCapture { _gate.arm(); }

- (void)revokeCapture {
  _gate.revoke();
  id<RTCAudioDeviceDelegate> delegate = _delegate;
  // Once interrupted, WebRTC accepts IO callbacks from a new thread after restart.
  [delegate dispatchAsync:^{
    [delegate notifyAudioInputInterrupted];
    [delegate notifyAudioOutputInterrupted];
  }];
}

- (void)revokeCaptureAndResetUnit {
  [self revokeCapture];
  id<RTCAudioDeviceDelegate> delegate = _delegate;
  [delegate dispatchAsync:^{ [self disposeUnit]; }];
}

- (void)notifyRouteParametersChanged {
  id<RTCAudioDeviceDelegate> delegate = _delegate;
  [delegate dispatchAsync:^{
    [delegate notifyAudioInputParametersChange];
    [delegate notifyAudioOutputParametersChange];
  }];
}

- (uint64_t)openGateWithLeaseSeconds:(double)leaseSeconds {
  if (!self.adoptedByWebRTC) return t3voice::SendGate::kClosed;
  // AVAudioSession latency is conservative padding: a block whose timestamp falls
  // inside it may hold sound captured before the user opened the gate.
  AVAudioSession *session = AVAudioSession.sharedInstance;
  uint64_t cutoff = mach_absolute_time() + SecondsToHostTicks(session.inputLatency + session.IOBufferDuration);
  return _gate.open(cutoff, LeaseNowNanos(), LeaseNanos(leaseSeconds));
}

- (BOOL)renewLeaseForEpoch:(uint64_t)epoch leaseSeconds:(double)leaseSeconds {
  return _gate.renew(epoch, LeaseNowNanos(), LeaseNanos(leaseSeconds));
}

- (BOOL)closeGateForEpoch:(uint64_t)epoch { return _gate.close(epoch); }

#pragma mark - IO callbacks (real-time thread: no locks, no allocation, no ObjC messaging)

static OSStatus T3RealtimeVoiceInput(void *refCon, AudioUnitRenderActionFlags *flags,
                                     const AudioTimeStamp *timestamp, UInt32 bus, UInt32 frames,
                                     AudioBufferList *unused) {
  T3RealtimeVoiceAudioDevice *self = (__bridge T3RealtimeVoiceAudioDevice *)refCon;
  if (frames > self->_inputScratch.size()) return kAudio_ParamError;
  AudioBufferList list;
  list.mNumberBuffers = 1;
  list.mBuffers[0].mNumberChannels = 1;
  list.mBuffers[0].mDataByteSize = frames * sizeof(int16_t);
  list.mBuffers[0].mData = self->_inputScratch.data();
  OSStatus status = AudioUnitRender(self->_unit, flags, timestamp, kInputBus, frames, &list);
  if (status != noErr) return status;
  self->_gate.filter(self->_inputScratch.data(), frames,
                     (timestamp->mFlags & kAudioTimeStampHostTimeValid) != 0,
                     timestamp->mHostTime, LeaseNowNanos());
  return self->_deliverRecordedData(flags, timestamp, bus, frames, &list, nullptr, nil);
}

static OSStatus T3RealtimeVoiceOutput(void *refCon, AudioUnitRenderActionFlags *flags,
                                      const AudioTimeStamp *timestamp, UInt32 bus, UInt32 frames,
                                      AudioBufferList *ioData) {
  T3RealtimeVoiceAudioDevice *self = (__bridge T3RealtimeVoiceAudioDevice *)refCon;
  OSStatus status = self->_getPlayoutData(flags, timestamp, bus, frames, ioData);
  // A revoked session (route loss, interruption) must not announce assistant
  // speech through an unexpected speaker.
  if (status == noErr && !self->_gate.armed()) {
    for (UInt32 i = 0; i < ioData->mNumberBuffers; i++) {
      memset(ioData->mBuffers[i].mData, 0, ioData->mBuffers[i].mDataByteSize);
    }
    *flags |= kAudioUnitRenderAction_OutputIsSilence;
  }
  return status;
}

#pragma mark - RTCAudioDevice (WebRTC ADM thread)

- (double)deviceInputSampleRate { return kSampleRate; }
- (NSTimeInterval)inputIOBufferDuration { return AVAudioSession.sharedInstance.IOBufferDuration; }
- (NSInteger)inputNumberOfChannels { return 1; }
- (NSTimeInterval)inputLatency { return AVAudioSession.sharedInstance.inputLatency; }
- (double)deviceOutputSampleRate { return kSampleRate; }
- (NSTimeInterval)outputIOBufferDuration { return AVAudioSession.sharedInstance.IOBufferDuration; }
- (NSInteger)outputNumberOfChannels { return 1; }
- (NSTimeInterval)outputLatency { return AVAudioSession.sharedInstance.outputLatency; }
- (BOOL)isInitialized { return _delegate != nil; }
- (BOOL)isPlayoutInitialized { return _playoutInitialized; }
- (BOOL)isPlaying { return _playing; }
- (BOOL)isRecordingInitialized { return _recordingInitialized; }
- (BOOL)isRecording { return _recording; }

// Runs when react-native-webrtc creates its factory. Must stay free of audio
// session or microphone side effects.
- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
  _delegate = delegate;
  _deliverRecordedData = delegate.deliverRecordedData;
  _getPlayoutData = delegate.getPlayoutData;
  return YES;
}

- (BOOL)terminateDevice {
  [self disposeUnit];
  _delegate = nil;
  _deliverRecordedData = nil;
  _getPlayoutData = nil;
  return YES;
}

// One voice-processing unit carries both directions, so its output bus is the
// echo reference for its own capture. WebRTC's iOS voice engine already leaves
// echo cancellation to VPIO.
- (BOOL)createUnitIfNeeded {
  if (_unit) return YES;
  // Inert until the voice session explicitly armed capture.
  if (!_gate.armed() || !_deliverRecordedData || !_getPlayoutData) return NO;
  AudioComponentDescription desc = {kAudioUnitType_Output, kAudioUnitSubType_VoiceProcessingIO,
                                    kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent component = AudioComponentFindNext(nullptr, &desc);
  if (!component || AudioComponentInstanceNew(component, &_unit) != noErr) {
    _unit = nullptr;
    return NO;
  }
  UInt32 one = 1;
  AudioStreamBasicDescription format = {};
  format.mSampleRate = kSampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  format.mBytesPerPacket = 2;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = 2;
  format.mChannelsPerFrame = 1;
  format.mBitsPerChannel = 16;
  UInt32 maxFrames = kMaxFramesPerSlice;
  AURenderCallbackStruct input = {T3RealtimeVoiceInput, (__bridge void *)self};
  AURenderCallbackStruct output = {T3RealtimeVoiceOutput, (__bridge void *)self};
  BOOL configured =
      AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, kInputBus, &one, sizeof(one)) == noErr &&
      AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, kOutputBus, &one, sizeof(one)) == noErr &&
      AudioUnitSetProperty(_unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, kInputBus, &format, sizeof(format)) == noErr &&
      AudioUnitSetProperty(_unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, kOutputBus, &format, sizeof(format)) == noErr &&
      AudioUnitSetProperty(_unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames)) == noErr &&
      AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, kInputBus, &input, sizeof(input)) == noErr &&
      AudioUnitSetProperty(_unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, kOutputBus, &output, sizeof(output)) == noErr &&
      AudioUnitInitialize(_unit) == noErr;
  if (!configured) [self disposeUnit];
  return configured;
}

- (void)disposeUnit {
  if (_unit) {
    AudioOutputUnitStop(_unit);
    AudioUnitUninitialize(_unit);
    AudioComponentInstanceDispose(_unit);
    _unit = nullptr;
  }
  _playoutInitialized = _recordingInitialized = _playing = _recording = NO;
}

- (BOOL)initializePlayout { return _playoutInitialized = [self createUnitIfNeeded]; }
- (BOOL)initializeRecording { return _recordingInitialized = [self createUnitIfNeeded]; }

- (BOOL)startUnitIfNeeded {
  if (!_unit || !_gate.armed()) return NO;
  if (_playing || _recording) return YES;
  return AudioOutputUnitStart(_unit) == noErr;
}

- (BOOL)startPlayout { return _playing = [self startUnitIfNeeded]; }
- (BOOL)startRecording { return _recording = [self startUnitIfNeeded]; }

- (BOOL)stopPlayout {
  _playing = NO;
  if (!_recording) [self disposeUnit];
  return YES;
}

- (BOOL)stopRecording {
  // Capture ended: the current epoch is over even if WebRTC restarts recording later.
  _gate.close(_gate.epoch());
  _recording = NO;
  if (!_playing) [self disposeUnit];
  return YES;
}

@end
