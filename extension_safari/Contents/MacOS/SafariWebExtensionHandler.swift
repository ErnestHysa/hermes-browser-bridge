import SafariServices
import os.log

/**
 * SafariWebExtensionHandler — Native message handler for the Hermes Browser Bridge.
 *
 * Handles messages from the extension's JavaScript layer.
 * Currently serves as a pass-through; all actual communication happens via
 * WebSocket (background.js → proxy server). This handler exists to satisfy
 * the Safari Web Extension native messaging contract and for future use
 * (e.g., reading Safari settings, managing multiple profiles).
 *
 * Compiled: swiftc -target arm64-apple-macosx14.0 ...
 * Deployment: macOS 13.0+ (Ventura and later)
 */

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  func beginRequest(with context: NSExtensionContext) {
    let request = context.inputItems.first as? NSExtensionItem

    // Safely extract the message — compatible with macOS 13 and 14+
    let message: Any?
    if #available(macOS 14.0, *) {
      message = request?.userInfo?[SFExtensionMessageKey]
    } else {
      message = request?.userInfo?["message"]
    }

    os_log(.default, "Hermes Browser Bridge: Received message from extension: %{public}@", String(describing: message))

    // Build response — currently a simple acknowledgment.
    // All real bridge communication flows through the WebSocket in background.js.
    let response = NSExtensionItem()
    response.userInfo = [SFExtensionMessageKey: ["status": "ok", "received": true]]

    context.completeRequest(returningItems: [response], completionHandler: nil)
  }
}
