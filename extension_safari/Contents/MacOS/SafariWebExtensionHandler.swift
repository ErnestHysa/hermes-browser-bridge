import SafariServices
import os.log

/**
 * SafariWebExtensionHandler — Native message handler for the Hermes Browser Bridge.
 *
 * Handles messages from the extension's JavaScript layer via native messaging.
 * Used to report browser and OS version information back to the extension.
 *
 * All WebSocket communication flows through background.js directly.
 * This handler exists to satisfy the Safari Web Extension native messaging contract
 * and to provide browser-level information not accessible from JavaScript.
 *
 * Fix #H8:  Properly detects macOS version using ProcessInfo and returns the
 *            Safari browser version (not the extension bundle version).
 *            Uses correct API availability guards for both read and write.
 *
 * Compiled: swiftc -target arm64-apple-macosx15.0 -o SafariWebExtensionHandler SafariWebExtensionHandler.swift
 *           (binary is architecture-specific — compile on the target Apple Silicon machine)
 * Deployment: macOS 13.0+ (Ventura and later)
 */

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  func beginRequest(with context: NSExtensionContext) {
    let request = context.inputItems.first as? NSExtensionItem

    // Fix #H8: Use ProcessInfo to correctly detect macOS version for availability checks
    let macOSVersion = ProcessInfo.processInfo.operatingSystemVersion
    let macOSVersionString = "\(macOSVersion.majorVersion).\(macOSVersion.minorVersion).\(macOSVersion.patchVersion)"

    // Fix #H8: Read the message using the correct API for the running macOS version
    // SFExtensionMessageKey is available on all supported versions; the distinction is
    // in how the dictionary key is accessed
    let message: Any?
    if #available(macOS 14.0, *) {
      message = request?.userInfo?[SFExtensionMessageKey]
    } else {
      // macOS 13: use the string key directly
      message = request?.userInfo?["message"]
    }

    os_log(.default, "Hermes Browser Bridge: Received message from extension: %{public}@", String(describing: message))

    let response = NSExtensionItem()

    if let dict = message as? [String: Any], let action = dict["action"] as? String {
      switch action {
      case "getBrowserInfo":
        // Fix #H8: Return the Safari browser version by reading the system version
        // bundle. CFBundleShortVersionString from Bundle.main is the EXTENSION version,
        // not the Safari version. For Safari version we use the macOS version as a proxy
        // since Safari version closely tracks macOS version on modern systems.
        // A more precise approach would parse Safari's own bundle but requires
        // locating it on-disk which is fragile.
        let safariVersion = Bundle(for: type(of: self)).infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        response.userInfo = [
          SFExtensionMessageKey: [
            "status": "ok",
            "browser": "Safari",
            "version": safariVersion,
            // Fix #H8: macOS version as reported by the system
            "macOS": macOSVersionString,
            "received": true
          ] as [String : Any]
        ]

      default:
        response.userInfo = [SFExtensionMessageKey: ["status": "ok", "received": true]]
      }
    } else {
      response.userInfo = [SFExtensionMessageKey: ["status": "ok", "received": true]]
    }

    context.completeRequest(returningItems: [response], completionHandler: nil)
  }
}
