import Foundation

/// Statistics of the linear output values (after the space matrix,
/// calibration and exposure scale; before any clipping or encoding).
struct PixelStats: Equatable {
    /// The encoding's clip ceiling (1 for tiff16, 2 for png16-g18); nil =
    /// unclipped float output, `aboveCeilingPixelCount` is not counted.
    let ceiling: Float?
    var minimum = SIMD3<Float>(repeating: .infinity)
    var maximum = SIMD3<Float>(repeating: -.infinity)
    var sum = SIMD3<Double>(repeating: 0)
    var negativeCount = SIMD3<Int>(repeating: 0)
    var aboveOneCount = SIMD3<Int>(repeating: 0)
    /// Pixels with any channel < 0 (clipped to 0 by the 16-bit encodings).
    var negativePixelCount = 0
    /// Pixels with any channel > `ceiling` (clipped by the encoding).
    var aboveCeilingPixelCount = 0
    /// Pixels with any NaN / infinite channel (excluded from the others).
    var nonFinitePixelCount = 0
    var finitePixelCount = 0

    init(ceiling: Float? = nil) {
        self.ceiling = ceiling
    }

    @inline(__always)
    mutating func accumulate(_ value: SIMD3<Float>) {
        guard value.x.isFinite, value.y.isFinite, value.z.isFinite else {
            nonFinitePixelCount += 1
            return
        }
        finitePixelCount += 1
        minimum = pointwiseMin(minimum, value)
        maximum = pointwiseMax(maximum, value)
        sum += SIMD3<Double>(Double(value.x), Double(value.y), Double(value.z))
        negativeCount &+= SIMD3<Int>(value.x < 0 ? 1 : 0, value.y < 0 ? 1 : 0, value.z < 0 ? 1 : 0)
        aboveOneCount &+= SIMD3<Int>(value.x > 1 ? 1 : 0, value.y > 1 ? 1 : 0, value.z > 1 ? 1 : 0)
        if value.min() < 0 { negativePixelCount += 1 }
        if let ceiling, value.max() > ceiling { aboveCeilingPixelCount += 1 }
    }

    mutating func merge(_ other: PixelStats) {
        minimum = pointwiseMin(minimum, other.minimum)
        maximum = pointwiseMax(maximum, other.maximum)
        sum += other.sum
        negativeCount &+= other.negativeCount
        aboveOneCount &+= other.aboveOneCount
        negativePixelCount += other.negativePixelCount
        aboveCeilingPixelCount += other.aboveCeilingPixelCount
        nonFinitePixelCount += other.nonFinitePixelCount
        finitePixelCount += other.finitePixelCount
    }

    var mean: SIMD3<Double> {
        finitePixelCount > 0 ? sum / Double(finitePixelCount) : SIMD3(repeating: .nan)
    }

    /// Share of the finite pixels with any channel < 0.
    var negativePixelFraction: Double {
        finitePixelCount > 0 ? Double(negativePixelCount) / Double(finitePixelCount) : 0
    }

    /// Share of the finite pixels with any channel > `ceiling` (0 without one).
    var aboveCeilingPixelFraction: Double {
        finitePixelCount > 0 ? Double(aboveCeilingPixelCount) / Double(finitePixelCount) : 0
    }

    var json: [String: Any] {
        let mean = self.mean
        let hasValues = finitePixelCount > 0
        return [
            "definition": "linear output values after space matrix / calibration / exposure scale, before clipping or encoding",
            "finitePixelCount": finitePixelCount,
            "nonFinitePixelCount": nonFinitePixelCount,
            "mean": [mean.x, mean.y, mean.z].map { JSONOutput.number($0) },
            "min": hasValues ? [minimum.x, minimum.y, minimum.z].map { JSONOutput.number($0) } : [],
            "max": hasValues ? [maximum.x, maximum.y, maximum.z].map { JSONOutput.number($0) } : [],
            "negativeCount": [negativeCount.x, negativeCount.y, negativeCount.z],
            "aboveOneCount": [aboveOneCount.x, aboveOneCount.y, aboveOneCount.z],
            "negativePixelCount": negativePixelCount,
            "ceiling": ceiling.map { JSONOutput.number($0) } ?? NSNull(),
            "aboveCeilingPixelCount": ceiling == nil ? NSNull() : aboveCeilingPixelCount,
        ]
    }
}

/// Per-pixel work on the RGBA float buffer: `out = matrix · rgb`, then for
/// the 16-bit encodings `clip [0, ceiling]`, `/ ceiling` and optionally
/// `^exponent`, so the encoded value is in [0, 1].
struct PixelTransform: Sendable {
    let row0: SIMD3<Float>
    let row1: SIMD3<Float>
    let row2: SIMD3<Float>
    let isIdentity: Bool
    /// 1 for tiff16, 2 for png16-g18 (the working-copy ceiling); nil = keep
    /// the linear value unclipped (tiff32f).
    let ceiling: Float?
    /// `1 / 1.8` for png16-g18; nil = keep linear. Double on purpose:
    /// `Float(1 / 1.8)` is 2.6e-8 too large and biased the codes low.
    let encodeExponent: Double?

    init(matrix: Matrix3, ceiling: Float?, encodeExponent: Double?) {
        row0 = SIMD3<Float>(Float(matrix.r0.x), Float(matrix.r0.y), Float(matrix.r0.z))
        row1 = SIMD3<Float>(Float(matrix.r1.x), Float(matrix.r1.y), Float(matrix.r1.z))
        row2 = SIMD3<Float>(Float(matrix.r2.x), Float(matrix.r2.y), Float(matrix.r2.z))
        isIdentity = matrix == .identity
        precondition(ceiling.map { $0.isFinite && $0 > 0 } ?? true, "ceiling must be positive")
        self.ceiling = ceiling
        self.encodeExponent = encodeExponent
    }

    /// The transform of an output encoding (its ceiling and gamma).
    init(matrix: Matrix3, encoding: OutputEncoding) {
        self.init(
            matrix: matrix,
            ceiling: encoding.ceiling.map { Float($0) },
            encodeExponent: encoding.gamma.map { 1 / $0 }
        )
    }

    @inline(__always)
    func linear(_ rgb: SIMD3<Float>) -> SIMD3<Float> {
        if isIdentity { return rgb }
        return SIMD3<Float>((row0 * rgb).sum(), (row1 * rgb).sum(), (row2 * rgb).sum())
    }

    @inline(__always)
    func encode(_ value: Float) -> Float {
        guard let ceiling else { return value }
        // NaN → 0 (comparisons with NaN are false). Dividing by 1 or 2 is exact.
        let unit: Float = value > 0 ? (value < ceiling ? value / ceiling : 1) : 0
        guard let encodeExponent else { return unit }
        // pow in Double (the crate's encoder is f64); only the result is Float.
        return unit > 0 ? Float(Foundation.pow(Double(unit), encodeExponent)) : 0
    }
}

/// Mutable pointer wrapper for row-parallel work on disjoint ranges.
private struct SharedBuffer<Element>: @unchecked Sendable {
    let base: UnsafeMutablePointer<Element>
}

enum PixelPipeline {
    /// Applies `transform` in place (alpha untouched), parallel over row
    /// chunks, and returns the statistics of the linear values.
    static func apply(
        _ transform: PixelTransform,
        to rgba: UnsafeMutablePointer<Float>,
        width: Int,
        height: Int
    ) -> PixelStats {
        guard width > 0, height > 0 else { return PixelStats(ceiling: transform.ceiling) }
        let chunkCount = max(1, min(height, ProcessInfo.processInfo.activeProcessorCount * 4))
        let rowsPerChunk = (height + chunkCount - 1) / chunkCount
        let partials = UnsafeMutablePointer<PixelStats>.allocate(capacity: chunkCount)
        partials.initialize(repeating: PixelStats(ceiling: transform.ceiling), count: chunkCount)
        defer {
            partials.deinitialize(count: chunkCount)
            partials.deallocate()
        }
        let pixels = SharedBuffer(base: rgba)
        let results = SharedBuffer(base: partials)
        DispatchQueue.concurrentPerform(iterations: chunkCount) { chunk in
            let startRow = chunk * rowsPerChunk
            let endRow = min(height, startRow + rowsPerChunk)
            guard startRow < endRow else { return }
            var stats = PixelStats(ceiling: transform.ceiling)
            let start = pixels.base + startRow * width * 4
            for index in 0 ..< (endRow - startRow) * width {
                let pixel = start + index * 4
                let value = transform.linear(SIMD3<Float>(pixel[0], pixel[1], pixel[2]))
                stats.accumulate(value)
                pixel[0] = transform.encode(value.x)
                pixel[1] = transform.encode(value.y)
                pixel[2] = transform.encode(value.z)
            }
            results.base[chunk] = stats
        }
        var total = PixelStats(ceiling: transform.ceiling)
        for chunk in 0 ..< chunkCount {
            total.merge(partials[chunk])
        }
        return total
    }

    /// RGBA float → packed RGB float in the same buffer. Sequential on
    /// purpose: pixel i is written to [3i, 3i+3), which never passes the
    /// unread source [4j, 4j+4) of any later pixel j > i.
    static func compactRGBAToRGB(_ rgba: UnsafeMutablePointer<Float>, pixelCount: Int) {
        for index in 0 ..< pixelCount {
            let source = rgba + index * 4
            let r = source[0]
            let g = source[1]
            let b = source[2]
            let destination = rgba + index * 3
            destination[0] = r
            destination[1] = g
            destination[2] = b
        }
    }

    /// Encoded RGBA float in [0, 1] → packed RGB UInt16 (`round(x · 65535)`).
    static func quantizeToUInt16RGB(
        _ rgba: UnsafeMutablePointer<Float>,
        width: Int,
        height: Int,
        into output: UnsafeMutablePointer<UInt16>
    ) {
        guard width > 0, height > 0 else { return }
        let chunkCount = max(1, min(height, ProcessInfo.processInfo.activeProcessorCount * 4))
        let rowsPerChunk = (height + chunkCount - 1) / chunkCount
        let source = SharedBuffer(base: rgba)
        let destination = SharedBuffer(base: output)
        DispatchQueue.concurrentPerform(iterations: chunkCount) { chunk in
            let startRow = chunk * rowsPerChunk
            let endRow = min(height, startRow + rowsPerChunk)
            guard startRow < endRow else { return }
            for index in startRow * width ..< endRow * width {
                let pixel = source.base + index * 4
                let out = destination.base + index * 3
                out[0] = quantize16(pixel[0])
                out[1] = quantize16(pixel[1])
                out[2] = quantize16(pixel[2])
            }
        }
    }

    /// `round(clip(x) · 65535)`, computed in Double so a Float product that
    /// lands on .5 cannot round the wrong way (0.7 → 45874, not 45875).
    @inline(__always)
    static func quantize16(_ value: Float) -> UInt16 {
        let clipped: Double = value > 0 ? (value < 1 ? Double(value) : 1) : 0
        return UInt16((clipped * 65535).rounded())
    }
}
