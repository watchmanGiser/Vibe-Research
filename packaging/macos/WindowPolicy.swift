import Foundation

enum WindowPolicy {
    static let home = URL(string: "http://127.0.0.1:5938/")!
    static func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == 5938 && url.user == nil && url.password == nil
    }
    static func isLocalBlob(_ url: URL) -> Bool {
        guard url.scheme == "blob", let origin = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return isLocal(origin)
    }
    static func isExternal(_ url: URL) -> Bool {
        guard url.user == nil && url.password == nil else { return false }
        return (["https", "http"].contains(url.scheme ?? "") && url.host != nil) || url.scheme == "mailto"
    }
    static func safeFilename(_ name: String) -> String {
        let clean = (name as NSString).lastPathComponent.components(separatedBy: .controlCharacters).joined()
        return clean.isEmpty || clean == "." || clean == ".." ? "研究资料" : clean
    }
    // Stage on the destination volume; never load a whole report into process memory.
    static func saveDownload(_ source: URL, to destination: URL) throws {
        let fm = FileManager.default
        let folder = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: destination, create: true)
        defer { try? fm.removeItem(at: folder) }
        let staged = folder.appendingPathComponent("content")
        try fm.copyItem(at: source, to: staged)
        if fm.fileExists(atPath: destination.path) {
            _ = try fm.replaceItemAt(destination, withItemAt: staged)
        } else {
            try fm.moveItem(at: staged, to: destination)
        }
    }
}
