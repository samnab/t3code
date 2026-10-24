// Minimal AVFoundation stand-in so the real T3RealtimeVoiceSession.swift runs on the host.
@_exported import Foundation

public final class AVAudioApplication {
  public enum Permission { case granted, denied }
  public static let shared = AVAudioApplication()
  public var recordPermission: Permission = .granted
}

public final class AVAudioSessionPortDescription {
  public let uid: String
  public init(uid: String) { self.uid = uid }
}

public final class AVAudioSessionRouteDescription {
  public let inputs: [AVAudioSessionPortDescription]
  public let outputs: [AVAudioSessionPortDescription]
  public init(inputs: [String], outputs: [String]) {
    self.inputs = inputs.map(AVAudioSessionPortDescription.init(uid:))
    self.outputs = outputs.map(AVAudioSessionPortDescription.init(uid:))
  }
}

public final class AVAudioSession {
  public struct Category: Equatable {
    public let raw: Int
    public static let playAndRecord = Category(raw: 1)
    public static let playback = Category(raw: 2)
  }
  public struct Mode: Equatable {
    public let raw: Int
    public static let voiceChat = Mode(raw: 1)
    public static let `default` = Mode(raw: 2)
  }
  public struct CategoryOptions: OptionSet {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let allowBluetoothHFP = CategoryOptions(rawValue: 1)
  }
  public struct SetActiveOptions: OptionSet {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let notifyOthersOnDeactivation = SetActiveOptions(rawValue: 1)
  }
  public enum InterruptionType: UInt { case began = 1, ended = 0 }
  // Raw values match Apple's AVAudioSessionRouteChangeReason.
  public enum RouteChangeReason: UInt {
    case unknown = 0, newDeviceAvailable = 1, oldDeviceUnavailable = 2, categoryChange = 3
    case override = 4, wakeFromSleep = 6, noSuitableRouteForCategory = 7, routeConfigurationChange = 8
  }
  public static let interruptionNotification = Notification.Name("mockInterruption")
  public static let routeChangeNotification = Notification.Name("mockRoute")
  public static let mediaServicesWereResetNotification = Notification.Name("mockReset")
  public static let singleton = AVAudioSession()
  /// Lets a harness pause a specific thread when it reaches the shared session.
  public static var onSharedInstance: (() -> Void)?
  /// Scheduling hook named after the API being entered; not a claim about Apple's timing.
  public static var onPoint: ((String) -> Void)?
  public static func sharedInstance() -> AVAudioSession {
    onSharedInstance?()
    onPoint?("sharedInstance")
    return singleton
  }
  public var category: Category = .playback
  public var mode: Mode = .default
  public var categoryOptions: CategoryOptions = []
  private var route = AVAudioSessionRouteDescription(inputs: ["headset-mic"], outputs: ["headset"])
  public var currentRoute: AVAudioSessionRouteDescription {
    get {
      AVAudioSession.onPoint?("currentRoute")
      return route
    }
    set { route = newValue }
  }
  public var onActivate: (() -> Void)?
  public func setCategory(_ category: Category, mode: Mode, options: CategoryOptions) throws {
    AVAudioSession.onPoint?("setCategory")
    self.category = category; self.mode = mode; self.categoryOptions = options
  }
  public func setActive(_ active: Bool, options: SetActiveOptions = []) throws {
    if active { AVAudioSession.onPoint?("setActive") }
    if active { onActivate?() }
  }
}
public let AVAudioSessionInterruptionTypeKey = "mockType"
public let AVAudioSessionRouteChangeReasonKey = "mockReason"
