import ExpoModulesCore
import UIKit

/// Installs the gated voice audio device before JS can import react-native-webrtc.
/// Allocation only: no audio session, permission prompt or audio unit at launch.
public final class T3RealtimeVoiceAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if !T3RealtimeVoiceAudioDevice.installIntoWebRTCModuleOptions() {
      NSLog("T3 realtime voice: another WebRTC audio device is installed; voice stays unavailable")
    }
    return true
  }
}
