import Foundation
var count = 0
func check(_ condition: @autoclosure () -> Bool) { precondition(condition()); count += 1 }
check(WindowPolicy.isLocal(URL(string: "http://127.0.0.1:5938/my-reports?page=1")!))
for value in ["https://127.0.0.1:5938/", "http://localhost:5938/", "http://127.0.0.1:8765/", "http://127.0.0.1.evil.test:5938/", "http://user:pass@127.0.0.1:5938/", "file:///etc/passwd", "javascript:alert(1)"] {
    check(!WindowPolicy.isLocal(URL(string: value)!))
}
check(WindowPolicy.isLocalBlob(URL(string: "blob:http://127.0.0.1:5938/uuid")!))
check(!WindowPolicy.isLocalBlob(URL(string: "blob:https://evil.test/id")!))
check(WindowPolicy.isExternal(URL(string: "https://phoenixtree.ai/")!))
check(WindowPolicy.isExternal(URL(string: "mailto:public@example.com")!))
for value in ["file:///tmp/test", "javascript:alert(1)", "data:text/html,test", "https://name:secret@example.com/"] {
    check(!WindowPolicy.isExternal(URL(string: value)!))
}
check(WindowPolicy.safeFilename("../../报告.md") == "报告.md")
check(WindowPolicy.safeFilename("..") == "研究资料")
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("vra-window-test-" + UUID().uuidString)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: folder) }
let source = folder.appendingPathComponent("source"), destination = folder.appendingPathComponent("报告.txt")
try Data("new report".utf8).write(to: source)
try WindowPolicy.saveDownload(source, to: destination)
let first = try String(contentsOf: destination, encoding: .utf8)
check(first == "new report")
try Data("updated report".utf8).write(to: source)
try WindowPolicy.saveDownload(source, to: destination)
let second = try String(contentsOf: destination, encoding: .utf8)
check(second == "updated report")
check(FileManager.default.fileExists(atPath: source.path))
print("Native window policy: \(count) checks passed")
