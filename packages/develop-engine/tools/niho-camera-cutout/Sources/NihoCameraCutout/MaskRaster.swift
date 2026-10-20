import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct MaskRaster: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public var pixels: Data

    public init(width: Int, height: Int, pixels: Data) throws {
        guard width > 0, height > 0, pixels.count == width * height else {
            throw CutoutError.invalidImageDimensions
        }
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    /// Copies a Vision mask into the library's top-left, row-major UInt8
    /// representation. Foreground instance labels are already UInt8; scaled
    /// soft masks are Float32 and must stay numerical (not color managed).
    public init(pixelBuffer: CVPixelBuffer) throws {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw CutoutError.unsupportedMaskFormat
        }
        let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
        guard format == kCVPixelFormatType_OneComponent8
                || format == kCVPixelFormatType_OneComponent32Float
        else { throw CutoutError.unsupportedMaskFormat }

        let decodedWidth = CVPixelBufferGetWidth(pixelBuffer)
        let decodedHeight = CVPixelBufferGetHeight(pixelBuffer)
        let sourceRowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard decodedWidth > 0, decodedHeight > 0 else {
            throw CutoutError.invalidImageDimensions
        }
        var storage = Data(count: decodedWidth * decodedHeight)
        storage.withUnsafeMutableBytes { destination in
            guard let target = destination.baseAddress else { return }
            for y in 0..<decodedHeight {
                let output = target.advanced(by: y * decodedWidth).assumingMemoryBound(to: UInt8.self)
                if format == kCVPixelFormatType_OneComponent8 {
                    memcpy(output, base.advanced(by: y * sourceRowBytes), decodedWidth)
                } else {
                    let input = base.advanced(by: y * sourceRowBytes).assumingMemoryBound(to: Float.self)
                    for x in 0..<decodedWidth {
                        let value = input[x]
                        let normalized = value.isFinite ? max(0, min(1, value)) : 0
                        output[x] = UInt8((normalized * 255).rounded())
                    }
                }
            }
        }
        self.width = decodedWidth
        self.height = decodedHeight
        self.pixels = storage
    }

    public init(pngData: Data) throws {
        guard let source = CGImageSourceCreateWithData(pngData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width > 0, image.height > 0
        else { throw CutoutError.corruptMask("PNGをデコードできません。") }
        let decodedWidth = image.width
        let decodedHeight = image.height
        var storage = Data(count: decodedWidth * decodedHeight)
        let rendered: Bool
        if image.bitsPerComponent == 8,
           image.bitsPerPixel == 8,
           let providerData = image.dataProvider?.data as Data? {
            rendered = storage.withUnsafeMutableBytes { destination in
                providerData.withUnsafeBytes { source in
                    guard let target = destination.baseAddress,
                          let input = source.baseAddress
                    else { return false }
                    for y in 0..<decodedHeight {
                        memcpy(
                            target.advanced(by: y * decodedWidth),
                            input.advanced(by: y * image.bytesPerRow),
                            decodedWidth
                        )
                    }
                    return true
                }
            }
        } else {
            let colorSpace = CGColorSpaceCreateDeviceGray()
            rendered = storage.withUnsafeMutableBytes { bytes -> Bool in
                guard let base = bytes.baseAddress,
                  let context = CGContext(
                    data: base,
                    width: decodedWidth,
                    height: decodedHeight,
                    bitsPerComponent: 8,
                    bytesPerRow: decodedWidth,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.none.rawValue
                  )
                else { return false }
                context.interpolationQuality = .none
                context.draw(image, in: CGRect(x: 0, y: 0, width: decodedWidth, height: decodedHeight))
                return true
            }
        }
        guard rendered else { throw CutoutError.corruptMask("8-bitマスクへ変換できません。") }
        width = decodedWidth
        height = decodedHeight
        pixels = storage
    }

    public func applying(_ strokes: [CutoutBrushStroke]) -> MaskRaster {
        guard !strokes.isEmpty else { return self }
        var result = self
        result.pixels.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for stroke in strokes where !stroke.points.isEmpty {
                guard stroke.radius.isFinite,
                      stroke.points.allSatisfy({ $0.x.isFinite && $0.y.isFinite })
                else { continue }
                let imageDiagonal = hypot(Double(width), Double(height))
                let scaledRadius = stroke.radius * Double(min(width, height))
                let radius = scaledRadius.isFinite
                    ? max(0.5, min(scaledRadius, imageDiagonal))
                    : imageDiagonal
                let points = stroke.points
                var samples: [CutoutPoint] = []
                for (index, point) in points.enumerated() {
                    if index == 0 {
                        samples.append(point)
                        continue
                    }
                    let previous = points[index - 1]
                    let dx = (point.x - previous.x) * Double(width)
                    let dy = (point.y - previous.y) * Double(height)
                    let distance = hypot(dx, dy)
                    let steps = max(1, Int(ceil(distance / max(1, radius * 0.35))))
                    for step in 1...steps {
                        let t = Double(step) / Double(steps)
                        samples.append(CutoutPoint(
                            x: previous.x + (point.x - previous.x) * t,
                            y: previous.y + (point.y - previous.y) * t
                        ))
                    }
                }
                for point in samples {
                    Self.paint(
                        base: base,
                        width: width,
                        height: height,
                        centerX: point.x * Double(width - 1),
                        centerY: point.y * Double(height - 1),
                        radius: radius,
                        mode: stroke.mode
                    )
                }
            }
        }
        return result
    }

    public func pngData() throws -> Data {
        let provider = CGDataProvider(data: pixels as CFData)
        guard let provider,
              let image = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              )
        else { throw CutoutError.encodingFailed(URL(fileURLWithPath: "mask.png")) }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else { throw CutoutError.encodingFailed(URL(fileURLWithPath: "mask.png")) }
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 1] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw CutoutError.encodingFailed(URL(fileURLWithPath: "mask.png"))
        }
        return data as Data
    }

    public func cgImage() throws -> CGImage {
        guard let provider = CGDataProvider(data: pixels as CFData),
              let image = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              )
        else { throw CutoutError.corruptMask("Core Graphics画像を作成できません。") }
        return image
    }

    private static func paint(
        base: UnsafeMutablePointer<UInt8>,
        width: Int,
        height: Int,
        centerX: Double,
        centerY: Double,
        radius: Double,
        mode: CutoutBrushMode
    ) {
        guard centerX.isFinite, centerY.isFinite, radius.isFinite else { return }
        let right = centerX + radius
        let left = centerX - radius
        let bottom = centerY + radius
        let top = centerY - radius
        let imageMaxX = Double(width - 1)
        let imageMaxY = Double(height - 1)
        guard right >= 0, left <= imageMaxX, bottom >= 0, top <= imageMaxY else { return }
        let minX = Int(max(0, floor(left)))
        let maxX = Int(min(imageMaxX, ceil(right)))
        let minY = Int(max(0, floor(top)))
        let maxY = Int(min(imageMaxY, ceil(bottom)))
        guard minX <= maxX, minY <= maxY else { return }
        let featherStart = radius * 0.72
        for y in minY...maxY {
            for x in minX...maxX {
                let distance = hypot(Double(x) - centerX, Double(y) - centerY)
                guard distance <= radius else { continue }
                let coverage: Double
                if distance <= featherStart {
                    coverage = 1
                } else {
                    coverage = 1 - (distance - featherStart) / max(0.001, radius - featherStart)
                }
                let index = y * width + x
                let current = Double(base[index]) / 255
                let updated: Double
                switch mode {
                case .erase: updated = current * (1 - coverage)
                case .restore: updated = current + (1 - current) * coverage
                }
                base[index] = UInt8(max(0, min(255, Int((updated * 255).rounded()))))
            }
        }
    }
}
