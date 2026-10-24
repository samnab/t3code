import ExpoModulesCore

/// JS control surface for the native voice audio owner. Every call follows an
/// explicit local user action; native observers revoke without waiting for JS.
public final class T3RealtimeVoiceAudioModule: Module {
  private let session = T3RealtimeVoiceSession.shared

  public func definition() -> ModuleDefinition {
    Name("T3RealtimeVoiceAudio")
    Events("onRevoked")

    OnCreate {
      session.onRevoked = { [weak self] reason in
        self?.sendEvent("onRevoked", ["reason": reason])
      }
    }

    AsyncFunction("prepare") { (owner: String) throws in
      do {
        try session.prepare(owner: owner)
      } catch let error as T3RealtimeVoiceSessionError {
        throw RealtimeVoiceAudioException(error.rawValue)
      }
    }

    Function("openGate") { (owner: String, leaseSeconds: Double) throws -> Double in
      do {
        return Double(try session.openGate(owner: owner, leaseSeconds: leaseSeconds))
      } catch let error as T3RealtimeVoiceSessionError {
        throw RealtimeVoiceAudioException(error.rawValue)
      }
    }

    Function("renewLease") { (epoch: Double, leaseSeconds: Double) -> Bool in
      guard let epoch = UInt64(exactly: epoch) else { return false }
      return session.renewLease(epoch: epoch, leaseSeconds: leaseSeconds)
    }

    Function("closeGate") { (epoch: Double) -> Bool in
      guard let epoch = UInt64(exactly: epoch) else { return false }
      return session.closeGate(epoch: epoch)
    }

    AsyncFunction("end") { (owner: String) -> Bool in
      session.end(owner: owner)
    }

    Function("snapshot") {
      session.snapshot()
    }
  }
}

final class RealtimeVoiceAudioException: GenericException<String> {
  override var code: String { "ERR_REALTIME_VOICE_\(param.uppercased())" }
  override var reason: String { "Realtime voice audio \(param)" }
}
