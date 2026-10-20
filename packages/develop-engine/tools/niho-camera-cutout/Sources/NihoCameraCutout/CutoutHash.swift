import CryptoKit
import Foundation

public enum CutoutHash {
    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256(fileURL: URL) throws -> String {
        guard let stream = InputStream(url: fileURL) else {
            throw CutoutError.unreadableInput(fileURL)
        }
        stream.open()
        defer { stream.close() }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 1 << 20)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw CutoutError.unreadableInput(fileURL) }
            if count == 0 { break }
            hasher.update(data: Data(buffer[0..<count]))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
