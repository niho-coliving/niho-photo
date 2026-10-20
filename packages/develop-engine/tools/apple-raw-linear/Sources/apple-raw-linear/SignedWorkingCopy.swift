import Foundation

/// Signed, headroom-preserving 16-bit representation used only by the p3/e4
/// RAW recipe. It is an internal transport encoding, not a display encoding.
enum SignedWorkingCopy {
    static let gamma = 1.8
    static let maximumCeiling = 65_536.0
    static let kind = "signed-gamma18-v1"
    static let recipe = "apple-raw-linear-p3-e4-v1"
    static let displayNote = "Signed gamma 1.8 codes are an internal working-copy representation centered at 32768; the PNG ICC is descriptive and viewers are expected to display it incorrectly."

    struct Encoding: Equatable {
        let ceiling: Double

        var json: [String: Any] {
            ["kind": kind, "ceiling": JSONOutput.number(ceiling)]
        }
    }

    /// `ceilPower2(max(1, maxAbs))`, capped at 65536. Non-finite and values
    /// outside the cap are errors; signed values are never clipped.
    static func encoding(forRGBA rgba: UnsafeBufferPointer<Float>, width: Int, height: Int) throws -> Encoding {
        let expected = try Lanczos4.elementCount(width: width, height: height, channels: 4)
        guard rgba.count == expected else {
            throw ToolError.encodeFailed(
                "signed PNG RGBA length \(rgba.count) does not match \(width)x\(height)x4 (\(expected))"
            )
        }
        var maximum = 0.0
        for pixel in 0 ..< width * height {
            let base = pixel * 4
            for channel in 0 ..< 3 {
                let value = Double(rgba[base + channel])
                guard value.isFinite else {
                    throw ToolError.encodeFailed("signed PNG contains a non-finite RGB value at pixel \(pixel), channel \(channel)")
                }
                maximum = max(maximum, abs(value))
            }
        }
        guard maximum <= maximumCeiling else {
            throw ToolError.encodeFailed(
                "signed PNG maxAbs \(maximum) exceeds the supported ceiling \(Int(maximumCeiling))"
            )
        }
        var ceiling = 1.0
        while ceiling < maximum { ceiling *= 2 }
        return Encoding(ceiling: ceiling)
    }

    /// Encodes RGBA Float RGB into packed UInt16 RGB. Gamma is computed in
    /// Double after the f32 pipeline and the final code uses IEEE nearest-even
    /// rounding (`.toNearestOrEven`), matching NumPy ties-to-even.
    static func encode(
        _ rgba: UnsafeBufferPointer<Float>,
        width: Int,
        height: Int,
        into output: UnsafeMutableBufferPointer<UInt16>
    ) throws -> Encoding {
        let encoding = try encoding(forRGBA: rgba, width: width, height: height)
        let expectedOutput = try Lanczos4.elementCount(width: width, height: height, channels: 3)
        guard output.count == expectedOutput else {
            throw ToolError.encodeFailed(
                "signed PNG RGB length \(output.count) does not match \(width)x\(height)x3 (\(expectedOutput))"
            )
        }
        for pixel in 0 ..< width * height {
            for channel in 0 ..< 3 {
                output[pixel * 3 + channel] = encode(rgba[pixel * 4 + channel], ceiling: encoding.ceiling)
            }
        }
        return encoding
    }

    @inline(__always)
    static func encode(_ value: Float, ceiling: Double) -> UInt16 {
        if value == 0 { return 32_768 }
        let magnitude = pow(abs(Double(value)) / ceiling, 1 / gamma) * 32_767
        let signed = value.sign == .minus ? -magnitude : magnitude
        return quantize(32_768 + signed)
    }

    /// Kept as a named operation so tests pin the tie rule independently of
    /// whether a particular Float input happens to land exactly on a tie.
    @inline(__always)
    static func quantize(_ unroundedCode: Double) -> UInt16 {
        UInt16(unroundedCode.rounded(.toNearestOrEven))
    }
}
