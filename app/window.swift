// phone-lab.app: ein Programm für den Mac mit den iPhones. Richtet beim Start die Dienste ein (launcher.sh: Server und
// Warmup-Dienst unter launchd, Tailscale-Freigabe) und zeigt das Dashboard in einem eigenen Fenster mit Dock-Symbol.
// Die Dienste laufen weiter, wenn das Fenster zu ist; ein Klick aufs Symbol öffnet es wieder.
// Gebaut von make-app.sh (swiftc, nur Entwicklungs-Mac). Kein Browser, keine Zusatzpakete.
import Cocoa
import WebKit

let dashboardURL = URL(string: "http://127.0.0.1:3000/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let status = NSTextField(labelWithString: "Starting phone-lab…")

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()                      // Anmeldung bleibt erhalten
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = NSColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1)   // dunkel wie das Dashboard

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "phone-lab"
        window.backgroundColor = NSColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1)
        window.minSize = NSSize(width: 380, height: 500)
        window.contentView = web
        status.textColor = NSColor(white: 0.7, alpha: 1)
        status.font = NSFont.systemFont(ofSize: 15)
        status.translatesAutoresizingMaskIntoConstraints = false
        web.addSubview(status)
        NSLayoutConstraint.activate([status.centerXAnchor.constraint(equalTo: web.centerXAnchor), status.centerYAnchor.constraint(equalTo: web.centerYAnchor)])
        window.center()
        window.setFrameAutosaveName("phone-lab main window")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Dienste einrichten (launcher.sh liegt neben dieser Datei in Contents/Resources), dann auf den Server warten
        DispatchQueue.global().async {
            if let launcher = Bundle.main.path(forResource: "launcher", ofType: "sh") {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/zsh")
                p.arguments = [launcher]
                var env = ProcessInfo.processInfo.environment
                env["PHONELAB_FROM_WINDOW"] = "1"                   // launcher öffnet dann keinen Browser
                p.environment = env
                try? p.run()
                p.waitUntilExit()
            }
            self.waitForServer(tries: 60)
        }
    }

    func waitForServer(tries: Int) {
        var req = URLRequest(url: dashboardURL.appendingPathComponent("login"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async {
                if (resp as? HTTPURLResponse) != nil {
                    self.status.isHidden = true
                    self.web.load(URLRequest(url: dashboardURL))
                } else if tries > 0 {
                    self.status.stringValue = "Waiting for the phone-lab server…"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitForServer(tries: tries - 1) }
                } else {
                    self.status.stringValue = "The phone-lab server does not answer. See ~/Library/Application Support/phone-lab/logs/server.log"
                }
            }
        }.resume()
    }

    // Fenster zu: App beenden, die Dienste laufen unter launchd weiter
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // ---------- Navigation: im Fenster nur das Dashboard, alles andere im Standardbrowser; Downloads in den Download-Ordner
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", url.scheme != "data", url.scheme != "blob" {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var target = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            let base = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
            target = dir.appendingPathComponent("\(base)-\(n).\(ext)"); n += 1
        }
        completionHandler(target)
    }
    func downloadDidFinish(_ download: WKDownload) { NSSound(named: "Glass")?.play() }

    // Links mit target=_blank: im Standardbrowser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // ---------- alert(), confirm(), prompt() des Dashboards als Mac-Dialoge
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // ---------- Menü: Kopieren/Einfügen in Textfeldern braucht das Bearbeiten-Menü
    @objc func reload() { if web.url == nil { web.load(URLRequest(url: dashboardURL)) } else { web.reload() } }
    @objc func openLogs() {
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/phone-lab/logs")
        NSWorkspace.shared.open(logs)
    }
    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) { let m = NSMenuItem(); m.submenu = NSMenu(title: title); items.forEach { m.submenu!.addItem($0) }; main.addItem(m) }
        func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i }
        add("phone-lab", [item("Hide phone-lab", #selector(NSApplication.hide(_:)), "h"), .separator(), item("Quit phone-lab", #selector(NSApplication.terminate(_:)), "q")])
        add("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "Z"), .separator(),
                     item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
                     item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a")])
        let r = item("Reload", #selector(reload), "r"); r.target = self
        let l = item("Open logs folder", #selector(openLogs), "l", [.command, .shift]); l.target = self
        add("View", [r, l, .separator(), item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
        add("Window", [item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"), item("Close", #selector(NSWindow.performClose(_:)), "w")])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
