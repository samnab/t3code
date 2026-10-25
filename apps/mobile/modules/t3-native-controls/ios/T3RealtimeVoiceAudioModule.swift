import ExpoModulesCore

/// JS control surface for the native voice audio owner. Every call follows an
/// explicit local user action; native observers revoke without waiting for JS.
/// Destroying the module (bridge reload, app context teardown) ends its owner.
public final class T3RealtimeVoiceAudioModule: Module {
  private let session = T3RealtimeVoiceSession.shared

  public func definition() -> ModuleDefinition {
    Name("T3RealtimeVoiceAudio")
    Events("onRevoked")

    OnCreate {
      session.setRevokedListener(module: self) { [weak self] reason, owner in
        self?.sendEvent(
          "onRevoked",
          ["reason": reason, "owner": owner.token, "generation": Double(owner.generation)]
        )
      }
    }

    OnDestroy {
      session.clearRevokedListener(module: self)
      _ = session.end(module: self)
    }

    AsyncFunction("prepare") { (owner: String) throws -> Double in
      do {
        return Double(try session.prepare(owner: owner, module: self).generation)
      } catch let error as T3RealtimeVoiceSessionError {
        throw RealtimeVoiceAudioException(error.rawValue)
      }
    }

    Function("openGate") { (owner: String, leaseSeconds: Double) throws -> Double in
      do {
        return Double(try session.openGate(owner: owner, module: self, leaseSeconds: leaseSeconds))
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
      session.end(module: self, owner: owner)
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
