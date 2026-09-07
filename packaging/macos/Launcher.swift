import Cocoa
import WebKit

// Native window hosting the existing local UI. No JavaScript-to-shell bridge.
final class Launcher: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var child: Process?
    private var window: NSWindow!
    private var web: WKWebView!
    private var loading: NSStackView!
    private let label = NSTextField(wrappingLabelWithString: "正在启动本地工作台…")
    private var ready = false
    private var stopping = false
    private var output = Data()
    private var timer: Timer?
    private var downloads: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    private var activeDownloads = Set<ObjectIdentifier>()
    private var savingDownloads = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenus()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Vibe Research"
        window.minSize = NSSize(width: 820, height: 600)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("VibeResearchWorkspace")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // App-owned persistent storage, independent of Chrome/Safari.
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(web)
        NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: content.leadingAnchor), web.trailingAnchor.constraint(equalTo: content.trailingAnchor), web.topAnchor.constraint(equalTo: content.topAnchor), web.bottomAnchor.constraint(equalTo: content.bottomAnchor)])
        let title = NSTextField(labelWithString: "Vibe Research")
        title.font = .boldSystemFont(ofSize: 26); title.textColor = .systemOrange
        let icon = NSImageView()
        if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns") { icon.image = NSImage(contentsOf: url) }
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 72).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 72).isActive = true
        label.font = .systemFont(ofSize: 14)
        let retry = NSButton(title: "重新打开工作台", target: self, action: #selector(recover))
        let note = NSTextField(wrappingLabelWithString: "首次进入 App 需重新接入 AI；不读取浏览器里的账号和聊天。原有本地研报与台账保留。")
        note.textColor = .secondaryLabelColor
        loading = NSStackView(views: [icon, title, label, retry, note])
        loading.orientation = .vertical; loading.spacing = 18
        loading.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(loading)
        NSLayoutConstraint.activate([loading.centerXAnchor.constraint(equalTo: content.centerXAnchor), loading.centerYAnchor.constraint(equalTo: content.centerYAnchor), loading.widthAnchor.constraint(equalToConstant: 440)])
        web.isHidden = true
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        launch()
    }

    private func installMenus() {
        let menu = NSMenu()
        func add(_ title: String, _ items: [(String, Selector, String)]) {
            let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let sub = NSMenu(title: title)
            for (name, action, key) in items { sub.addItem(withTitle: name, action: action, keyEquivalent: key) }
            root.submenu = sub; menu.addItem(root)
        }
        add("Vibe Research", [("关于 Vibe Research", #selector(about), ""), ("隐藏 Vibe Research", #selector(NSApplication.hide(_:)), "h"), ("退出 Vibe Research", #selector(NSApplication.terminate(_:)), "q")])
        add("编辑", [("撤销", Selector(("undo:")), "z"), ("剪切", #selector(NSText.cut(_:)), "x"), ("复制", #selector(NSText.copy(_:)), "c"), ("粘贴", #selector(NSText.paste(_:)), "v"), ("全选", #selector(NSText.selectAll(_:)), "a")])
        add("显示", [("首页", #selector(home), "1"), ("重新载入", #selector(reload), "r"), ("后退", #selector(back), "["), ("前进", #selector(forward), "]")])
        add("窗口", [("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"), ("关闭窗口", #selector(NSWindow.performClose(_:)), "w")])
        NSApp.mainMenu = menu
    }

    private func showStatus(_ message: String) { label.stringValue = message; loading.isHidden = false; web.isHidden = true }
    @objc private func about() { message("Vibe Research · 本地测试版", "独立 App 窗口 · Phoenix Tree\n关闭窗口保留服务；退出会停止对话。后台研究请先在研究页单独取消。") }
    @objc private func home() { if ready { web.load(URLRequest(url: WindowPolicy.home)) } }
    @objc private func reload() { if ready { web.reload() } else { recover() } }
    @objc private func back() { if ready && web.canGoBack { web.goBack() } }
    @objc private func forward() { if ready && web.canGoForward { web.goForward() } }
    @objc private func recover() {
        if ready { home() }
        else if child?.isRunning != true { launch() }
    }

    private func launch() {
        guard let resources = Bundle.main.resourceURL else { showStatus("安装包不完整，请重新安装。"); return }
        output.removeAll(); ready = false; showStatus("正在启动本地工作台…")
        let p = Process()
        p.executableURL = resources.appendingPathComponent("node/bin/node")
        p.arguments = [resources.appendingPathComponent("app/orchestrator/src/packaged.ts").path]
        p.currentDirectoryURL = resources.appendingPathComponent("app")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        p.environment = ["HOME": home, "USER": NSUserName(), "TMPDIR": NSTemporaryDirectory(), "LANG": "en_US.UTF-8",
                         "PATH": "\(resources.path)/node/bin:\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONDONTWRITEBYTECODE": "1"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self, weak p] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self = self, self.child === p, !self.stopping else { return }
                self.output.append(data)
                if self.output.count > 16384 { self.output.removeFirst(self.output.count - 16384) }
                if !self.ready && String(decoding: self.output, as: UTF8.self).contains("READY http://127.0.0.1:5938/") {
                    self.ready = true; self.timer?.invalidate(); self.home()
                }
            }
        }
        p.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self, self.child === process else { return }
                self.timer?.invalidate()
                if self.stopping { NSApp.reply(toApplicationShouldTerminate: true); return }
                self.ready = false; self.web.stopLoading()
                self.showStatus("本地服务已停止（\(process.terminationStatus)）。请确认没有另一个 Vibe Research 正在运行、用户数据目录可写，再点击重新打开。")
            }
        }
        do {
            child = p; try p.run()
            timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in
                guard let self = self, !self.ready else { return }
                self.showStatus("启动超时，请退出并重新打开应用。"); self.child?.terminate()
            }
        } catch { showStatus("无法运行随包服务。请重新安装，勿删除应用内部文件。") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard ready, let url = action.request.url else { decisionHandler(.cancel); return }
        if WindowPolicy.isLocal(url) || WindowPolicy.isLocalBlob(url) {
            if action.shouldPerformDownload { decisionHandler(.download) }
            else if action.targetFrame == nil { decisionHandler(.cancel); webView.load(action.request) }
            else { decisionHandler(.allow) }
            return
        }
        if url.absoluteString == "about:blank" && action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        // External pages never replace the app. Only local UI can open external browser links.
        if WindowPolicy.isExternal(url), let source = action.sourceFrame.request.url, WindowPolicy.isLocal(source),
           action.navigationType == .linkActivated || action.targetFrame == nil { NSWorkspace.shared.open(url) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = response.response.url, WindowPolicy.isLocal(url) || WindowPolicy.isLocalBlob(url) else { decisionHandler(.cancel); return }
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ready else { return }
        loading.isHidden = true; web.isHidden = false; window.makeFirstResponder(web)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    private func navigationFailed(_ error: Error) {
        let code = (error as NSError).code
        if code != NSURLErrorCancelled && code != 102 { showStatus("页面未能加载。请点击重新打开工作台；本地资料不会被清除。") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showStatus("页面进程已停止。请重新打开工作台；已保存的资料仍在。") }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let url = frame.request.url, WindowPolicy.isLocal(url) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    private func message(_ title: String, _ detail: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.beginSheetModal(for: window)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage text: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "工作台提示"; alert.informativeText = String(text.prefix(2000))
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage text: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "请确认"; alert.informativeText = String(text.prefix(2000)); alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    private func startDownload(_ download: WKDownload) { activeDownloads.insert(ObjectIdentifier(download)); download.delegate = self }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { startDownload(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { startDownload(download) }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = WindowPolicy.safeFilename(suggestedFilename)
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self else { completionHandler(nil); return }
            guard result == .OK, let destination = panel.url else { self.activeDownloads.remove(ObjectIdentifier(download)); completionHandler(nil); return }
            do {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("vra-download-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let temporary = folder.appendingPathComponent("content")
                self.downloads[ObjectIdentifier(download)] = (temporary, destination)
                completionHandler(temporary)
            } catch { self.activeDownloads.remove(ObjectIdentifier(download)); self.message("无法开始下载", "请选择其他保存位置后重试。"); completionHandler(nil) }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        activeDownloads.remove(ObjectIdentifier(download))
        guard let entry = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        savingDownloads += 1
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            defer { DispatchQueue.main.async { self?.savingDownloads -= 1 } }
            do {
                // NSSavePanel owns overwrite consent; copy/replace off the UI thread.
                try WindowPolicy.saveDownload(entry.temporary, to: entry.destination)
                try? FileManager.default.removeItem(at: entry.temporary.deletingLastPathComponent())
            } catch {
                DispatchQueue.main.async { self?.message("保存未完成", "下载内容仍保留在临时目录。请重新下载并选择可写的位置。") }
            }
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        activeDownloads.remove(ObjectIdentifier(download))
        if let entry = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: entry.temporary.deletingLastPathComponent()) }
        if (error as NSError).code != NSURLErrorCancelled { message("下载未完成", "请检查本地服务后重试，原资料不会被删除。") }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map(WindowPolicy.isLocal) == true ? .allow : .cancel)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true // Keep current conversation/draft, do not navigate.
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if !activeDownloads.isEmpty || savingDownloads > 0 {
            message("资料正在下载或保存", "请等待保存结束再退出，避免中断下载。")
            return .terminateCancel
        }
        guard let child = child, child.isRunning else { return .terminateNow }
        if stopping { return .terminateLater }
        stopping = true; timer?.invalidate(); child.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let child = self?.child, child.isRunning else { return }
            kill(child.processIdentifier, SIGKILL)
        }
        return .terminateLater
    }
}

@main enum VibeResearchApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = Launcher(); app.delegate = delegate
        app.setActivationPolicy(.regular); withExtendedLifetime(delegate) { app.run() }
    }
}
