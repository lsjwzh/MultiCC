import Foundation
import ApplicationServices
import CoreGraphics

// TCC must see the request from the long-lived .app, not the CLI/web server.
// Queue the system prompt so a modal sheet never holds the socket response open.
func requestAgentPermissions(_ req: [String: Any]) -> [String: Any] {
  let permission = req["permission"] as? String
  if req["permission"] != nil && permission != "accessibility" && permission != "screenRecording" {
    return ["ok": false, "error": "unknown permission"]
  }
  DispatchQueue.main.async {
    if (permission == nil || permission == "accessibility") && !AXIsProcessTrusted() {
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(opts)
    }
    if (permission == nil || permission == "screenRecording") && !CGPreflightScreenCaptureAccess() {
      _ = CGRequestScreenCaptureAccess()
    }
    // Input Monitoring only supports the optional Esc shortcut; never request it here.
  }
  return ["ok": true, "status": "requested",
          "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
}
