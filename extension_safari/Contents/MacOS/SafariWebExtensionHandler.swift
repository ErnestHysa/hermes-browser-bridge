import SafariServices
import os.log

/**
 * SafariWebExtensionHandler — Native message handler for the Hermes Browser Bridge.
 *
 * Handles messages from the extension's JavaScript layer via native messaging.
 * Currently used to report browser version and enumerate open tabs — information
 * that helps Hermes understand the browser environment.
 *
 * All WebSocket communication flows through background.js directly.
 * This handler exists to satisfy the Safari Web Extension native messaging contract
 * and to provide browser-level information not accessible from JavaScript.
 *
 * Compiled: swiftc -target arm64-apple-macosx13.0 ...
 * Deployment: macOS 13.0+ (Ventura and later)
 */

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  func beginRequest(with context: NSExtensionContext) {
    let request = context.inputItems.first as? NSExtensionItem

    let message: Any?
    if #available(macOS 14.0, *) {
      message = request?.userInfo?[SFExtensionMessageKey]
    } else {
      message = request?.userInfo?["message"]
    }

    os_log(.default, "Hermes Browser Bridge: Received message from extension: %{public}@", String(describing: message))

    // Build response
    let response = NSExtensionItem()

    if let dict = message as? [String: Any], let action = dict["action"] as? String {
      switch action {
      case "getBrowserInfo":
        // M5 FIX: return useful browser info instead of a no-op acknowledgment
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        response.userInfo = [
          SFExtensionMessageKey: [
            "status": "ok",
            "browser": "Safari",
            "version": version,
            "build": build,
            "received": true
          ]
        ]

      default:
        response.userInfo = [SFExtensionMessageKey: ["status": "ok", "received": true]]
      }
    } else {
      // Default acknowledgment
      response.userInfo = [SFExtensionMessageKey: ["status": "ok", "received": true]]
    }

    context.completeRequest(returningItems: [response], completionHandler: nil)
  }
}
