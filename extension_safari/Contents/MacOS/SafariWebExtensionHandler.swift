import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(macOS 14.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Hermes Browser Bridge: Received message from extension: %{public}@", String(describing: message))

        // Handle messages from the extension if needed.
        // Currently the extension connects directly via WebSocket,
        // so this handler is a pass-through for future native features.
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["status": "ok", "received": true]]

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
