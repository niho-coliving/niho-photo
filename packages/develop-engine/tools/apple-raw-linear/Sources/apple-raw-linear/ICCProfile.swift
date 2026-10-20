import Foundation

/// Whether stage 2 can read an ICC profile as it is (`raster`, K5-c1 #17153).
///
/// The crate (`niho-develop` `decode.rs` `conversion_for`, moxcms) reads an
/// RGB matrix / TRC profile (`is_matrix_shaper`: rXYZ, gXYZ, bXYZ and rTRC,
/// gTRC, bTRC) or gray; anything else (LUT-only, PQ / HLG) is
/// `unsupported_profile` and the working copy could not be opened. An 8-bit
/// JPEG under a (nearly) linear TRC would also band in the shadows. So a
/// working copy keeps the source's ICC only when it is RGB with the six
/// matrix / TRC tags and no TRC is nearly linear; `raster` converts every
/// other RGB source to Display P3.
///
/// Read from the tag table: the 128-byte header (data color space at 16),
/// the tag count at 128 and 12-byte entries (signature, offset, size).
enum ICCProfile {
    enum Verdict: Equatable {
        case readable
        case unreadable(String)
    }

    /// A TRC is nearly linear below this gamma.
    static let linearGammaLimit = 1.3

    static let matrixTags = ["rXYZ", "gXYZ", "bXYZ"]
    static let trcTags = ["rTRC", "gTRC", "bTRC"]

    static func stage2Verdict(_ icc: Data) -> Verdict {
        let bytes = [UInt8](icc)
        guard bytes.count >= 132 else {
            return .unreadable("the ICC profile is shorter than its header")
        }
        guard signature(bytes, at: 16) == "RGB " else {
            return .unreadable("the ICC profile is not RGB (\(signature(bytes, at: 16) ?? "?"))")
        }
        let count = Int(uint32(bytes, at: 128))
        guard count <= (bytes.count - 132) / 12 else {
            return .unreadable("the ICC tag table is truncated")
        }
        var tags: [String: Range<Int>] = [:]
        for index in 0 ..< count {
            let entry = 132 + index * 12
            guard let name = signature(bytes, at: entry) else { continue }
            let offset = Int(uint32(bytes, at: entry + 4))
            let size = Int(uint32(bytes, at: entry + 8))
            guard offset >= 0, size >= 0, offset <= bytes.count, size <= bytes.count - offset else {
                return .unreadable("the ICC tag \(name) lies outside the profile")
            }
            if tags[name] == nil {
                tags[name] = offset ..< offset + size
            }
        }
        for name in matrixTags + trcTags where tags[name] == nil {
            return .unreadable("the ICC profile has no \(name) (not a matrix / TRC profile)")
        }
        for name in matrixTags {
            guard let range = tags[name] else { continue }
            guard range.count >= 20, signature(bytes, at: range.lowerBound) == "XYZ " else {
                return .unreadable("the ICC tag \(name) is not an XYZ value")
            }
            let values = (0 ..< 3).map { uint32(bytes, at: range.lowerBound + 8 + $0 * 4) }
            guard values.contains(where: { $0 != 0 }) else {
                return .unreadable("the ICC colorant \(name) is zero")
            }
        }
        for name in trcTags {
            guard let range = tags[name] else { continue }
            switch trcGamma(bytes, range) {
            case let .failure(reason):
                return .unreadable("the ICC tag \(name): \(reason)")
            case let .success(gamma):
                if let gamma, gamma < linearGammaLimit {
                    return .unreadable("the ICC tag \(name) is nearly linear (gamma \(gamma))")
                }
            }
        }
        return .readable
    }

    private struct TRCError: Error {
        let reason: String
    }

    /// The gamma of a `curv` (0 points = identity = 1.0, 1 point = u8Fixed8
    /// gamma) or `para` (its first parameter) TRC; nil for a `curv` table of
    /// two or more points (not judged nearly linear); a failure for other or
    /// malformed types.
    private static func trcGamma(_ bytes: [UInt8], _ range: Range<Int>) -> Result<Double?, TRCError> {
        let start = range.lowerBound
        guard range.count >= 12 else { return .failure(TRCError(reason: "too short")) }
        switch signature(bytes, at: start) {
        case "curv":
            let points = Int(uint32(bytes, at: start + 8))
            guard points <= (range.count - 12) / 2 else { return .failure(TRCError(reason: "truncated curv")) }
            switch points {
            case 0: return .success(1)
            case 1: return .success(Double(uint16(bytes, at: start + 12)) / 256)
            default: return .success(nil)
            }
        case "para":
            let function = Int(uint16(bytes, at: start + 8))
            let parameters = [1, 3, 4, 5, 7]
            guard function < parameters.count else {
                return .failure(TRCError(reason: "unknown para function \(function)"))
            }
            guard range.count >= 12 + parameters[function] * 4 else {
                return .failure(TRCError(reason: "truncated para"))
            }
            return .success(Double(Int32(bitPattern: uint32(bytes, at: start + 12))) / 65536)
        default:
            return .failure(TRCError(reason: "type \(signature(bytes, at: start) ?? "?") is neither curv nor para"))
        }
    }

    private static func uint32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16 | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3])
    }

    private static func uint16(_ bytes: [UInt8], at offset: Int) -> UInt16 {
        UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1])
    }

    /// A 4-byte ASCII signature; nil when out of range.
    private static func signature(_ bytes: [UInt8], at offset: Int) -> String? {
        guard offset >= 0, offset + 4 <= bytes.count else { return nil }
        return String(decoding: bytes[offset ..< offset + 4], as: UTF8.self)
    }
}
