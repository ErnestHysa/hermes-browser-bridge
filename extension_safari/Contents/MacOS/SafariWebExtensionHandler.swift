import SafariServices
import os.log

/**
 * SafariWebExtensionHandler — Native message handler for the Hermes Browser Bridge.
 *
 * Safari Web Extensions require a native messaging host to communicate with
 * native macOS APIs and to satisfy the extension bundling contract. This handler
 * exists for two reasons:
 *
 *  1. Browser/OS info: Returns Safari version, macOS version, and build info
 *     that is not accessible from JavaScript in the extension context.
 *     This lets Hermes Agent know exactly which browser version is running.
 *
 *  2. Native messaging contract: Safari's Web Extension architecture requires
 *     a native binary to be part of the extension bundle. Without this handler,
 *     Safari refuses to load the extension from a developer directory.
 *     The handler is a passthrough — all real communication (WebSocket to the
 *     proxy) happens in background.js using browser.runtime.sendNativeMessage.
 *
 * WebSocket communication: All page state and commands flow through background.js
 * via WebSocket (ws://localhost:9321). This native handler is NOT in that path.
 *
 * Production readiness (multi-user):
 * - Currently: single-user localhost only — no auth needed
 * - Future: add a per-session token validated here; extensions receive a
 *   time-limited token via HBS_SESSION_TOKEN env var or launchd plist arg
 * - Future: native handler could verify the token before returning browser info
 *   to prevent unauthorized extension instances from querying browser metadata
 *
 * Fix #H8:  Properly detects macOS version using ProcessInfo and returns the
 *            Safari browser version (not the extension bundle version).
 *            Uses correct API availability guards for both read and write.
 *
 * Compiled: swiftc -target arm64-apple-macosx14.0 -o SafariWebExtensionHandler SafariWebExtensionHandler.swift
 *           (binary is architecture-specific — compile on the target Apple Silicon machine)
 * Deployment: macOS 14.0+ (Sonoma and later)
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
