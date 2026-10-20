import CoreImage
import CryptoKit
import Darwin
import Foundation
import Metal

/// Where a render ran. Same facts as Photo Bench's
/// `RAWWhiteBalanceDecoder.environment()`: Core Image's RAW output can change
/// with the OS, so every metadata file carries them.
enum RuntimeEnvironment {
    static func snapshot() -> [String: Any] {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let coreImage = Bundle(identifier: "com.apple.CoreImage")
        return [
            "macOSVersion": macOSVersionString(os),
            "macOSBuild": macOSBuild(),
            "architecture": architecture,
            "hardwareModel": JSONOutput.optional(sysctlString("hw.model")),
            "cpu": JSONOutput.optional(sysctlString("machdep.cpu.brand_string")),
            "physicalMemoryBytes": JSONOutput.optional(sysctlUInt64("hw.memsize")),
            "metalDevice": JSONOutput.optional(MTLCreateSystemDefaultDevice()?.name),
            "coreImageVersion": JSONOutput.optional(
                coreImage?.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            ),
            "coreImageShortVersion": JSONOutput.optional(
                coreImage?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ),
        ]
    }

    /// "27.0" for 27.0.0 (matches `sw_vers -productVersion`), "27.0.1" otherwise.
    static func macOSVersionString(_ os: OperatingSystemVersion) -> String {
        os.patchVersion == 0
            ? "\(os.majorVersion).\(os.minorVersion)"
            : "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
    }

    static func macOSBuild() -> String {
        let description = ProcessInfo.processInfo.operatingSystemVersionString
        if let marker = description.range(of: "(Build "),
           let closing = description[marker.upperBound...].firstIndex(of: ")") {
            return String(description[marker.upperBound ..< closing])
        }
        return sysctlString("kern.osversion") ?? "unknown"
    }

    static var architecture: String {
        #if arch(arm64)
        "arm64"
        #elseif arch(x86_64)
        "x86_64"
        #else
        "unknown"
        #endif
    }

    static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    static func sysctlUInt64(_ name: String) -> UInt64? {
        var value: UInt64 = 0
        var size = MemoryLayout<UInt64>.size
        guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return nil }
        return value
    }

    /// `mach_task_basic_info.resident_size_max` of this process, in bytes.
    static func peakResidentBytes() -> UInt64? {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(
            MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), raw, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return UInt64(info.resident_size_max)
    }

    /// Sorted camera list, its count and SHA-256 (NUL-joined, like Photo Bench).
    static func supportedCameraModels() -> (models: [String], sha256: String) {
        let models = CIRAWFilter.supportedCameraModels.sorted()
        let payload = models.joined(separator: "\u{0}")
        let digest = SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
        return (models, digest)
    }
}

/// Wall-clock milliseconds between two `ContinuousClock` instants.
func milliseconds(from start: ContinuousClock.Instant, to end: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: end)
    return Double(duration.components.seconds) * 1_000
        + Double(duration.components.attoseconds) / 1_000_000_000_000_000
}
