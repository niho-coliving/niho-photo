import Foundation

/// OpenCV-compatible Lanczos4 downsampling for the signed RAW recipe.
///
/// Coordinates are half-pixel Float coordinates, each axis has eight taps,
/// weights are normalized in Float, and indices outside the image repeat the
/// nearest border pixel. This is deliberately separate from Core Image: the
/// RAW must first be decoded and lens-corrected at full resolution.
enum Lanczos4 {
    struct Dimensions: Equatable {
        let width: Int
        let height: Int
    }

    struct Image {
        /// `width * height * 4` RGBA Floats. Owned by the caller.
        let pixels: UnsafeMutablePointer<Float>
        let width: Int
        let height: Int
    }

    private struct Axis {
        let indices: [[Int]]
        let weights: [[Float]]

        init(input: Int, output: Int) {
            var allIndices: [[Int]] = []
            var allWeights: [[Float]] = []
            allIndices.reserveCapacity(output)
            allWeights.reserveCapacity(output)
            for destination in 0 ..< output {
                let coordinate = Float(
                    (Double(destination) + 0.5) * (Double(input) / Double(output)) - 0.5
                )
                let start = Int(floor(coordinate))
                let fraction = coordinate - Float(start)
                var taps: [Float] = []
                var sum: Float = 0
                taps.reserveCapacity(8)
                for tap in 0 ..< 8 {
                    let distance = Double(fraction + 3 - Float(tap))
                    let weight: Float
                    if distance == 0 {
                        weight = 1
                    } else {
                        weight = Float(
                            sin(.pi * distance) / (.pi * distance)
                                * sin(.pi * distance / 4) / (.pi * distance / 4)
                        )
                    }
                    taps.append(weight)
                    sum += weight
                }
                let inverse: Float = 1 / sum
                allWeights.append(taps.map { $0 * inverse })
                allIndices.append((0 ..< 8).map { max(0, min(input - 1, start - 3 + $0)) })
            }
            indices = allIndices
            weights = allWeights
        }
    }

    static func dimensions(width: Int, height: Int, longEdge: LongEdge) throws -> Dimensions {
        guard width > 0, height > 0 else {
            throw ToolError.encodeFailed("Lanczos4 needs positive source dimensions (got \(width)x\(height))")
        }
        guard case let .pixels(requested) = longEdge else {
            return Dimensions(width: width, height: height)
        }
        guard requested > 0 else {
            throw ToolError.encodeFailed("Lanczos4 needs a positive long edge (got \(requested))")
        }
        let sourceLong = max(width, height)
        guard requested < sourceLong else {
            return Dimensions(width: width, height: height)
        }
        if width >= height {
            return Dimensions(
                width: requested,
                height: max(1, Int(ceil(Double(height) * Double(requested) / Double(width))))
            )
        }
        return Dimensions(
            width: max(1, Int(ceil(Double(width) * Double(requested) / Double(height)))),
            height: requested
        )
    }

    /// Returns nil when no resize is needed. At most eight horizontally
    /// filtered RGBA rows are cached while the vertical pass is produced.
    static func resizeIfNeeded(
        _ source: UnsafeBufferPointer<Float>,
        width: Int,
        height: Int,
        longEdge: LongEdge
    ) throws -> Image? {
        let sourcePixels = try elementCount(width: width, height: height, channels: 4)
        guard source.count == sourcePixels else {
            throw ToolError.encodeFailed(
                "Lanczos4 RGBA length \(source.count) does not match \(width)x\(height)x4 (\(sourcePixels))"
            )
        }
        let target = try dimensions(width: width, height: height, longEdge: longEdge)
        guard target != Dimensions(width: width, height: height) else { return nil }

        let outputCount = try elementCount(width: target.width, height: target.height, channels: 4)
        let output = UnsafeMutablePointer<Float>.allocate(capacity: outputCount)
        output.initialize(repeating: 0, count: outputCount)
        let x = Axis(input: width, output: target.width)
        let y = Axis(input: height, output: target.height)
        var rows: [Int: [Float]] = [:]

        for destinationY in 0 ..< target.height {
            let required = Set(y.indices[destinationY])
            for key in Array(rows.keys) where !required.contains(key) {
                rows.removeValue(forKey: key)
            }
            for sourceY in y.indices[destinationY] where rows[sourceY] == nil {
                var row = [Float](repeating: 0, count: target.width * 4)
                for destinationX in 0 ..< target.width {
                    for channel in 0 ..< 4 {
                        var value: Float = 0
                        for tap in 0 ..< 8 {
                            let sourceX = x.indices[destinationX][tap]
                            value += source[(sourceY * width + sourceX) * 4 + channel]
                                * x.weights[destinationX][tap]
                        }
                        row[destinationX * 4 + channel] = value
                    }
                }
                rows[sourceY] = row
            }
            for tap in 0 ..< 8 {
                guard let row = rows[y.indices[destinationY][tap]] else {
                    output.deinitialize(count: outputCount)
                    output.deallocate()
                    throw ToolError.encodeFailed("Lanczos4 row cache lost a required source row")
                }
                let weight = y.weights[destinationY][tap]
                let destination = output + destinationY * target.width * 4
                for index in 0 ..< target.width * 4 {
                    destination[index] += row[index] * weight
                }
            }
        }
        return Image(pixels: output, width: target.width, height: target.height)
    }

    static func elementCount(width: Int, height: Int, channels: Int) throws -> Int {
        guard width > 0, height > 0, channels > 0 else {
            throw ToolError.encodeFailed("image dimensions and channel count must be positive")
        }
        let (pixels, pixelsOverflow) = width.multipliedReportingOverflow(by: height)
        let (elements, elementsOverflow) = pixels.multipliedReportingOverflow(by: channels)
        guard !pixelsOverflow, !elementsOverflow else {
            throw ToolError.encodeFailed("image dimensions overflow the addressable buffer length")
        }
        return elements
    }
}
