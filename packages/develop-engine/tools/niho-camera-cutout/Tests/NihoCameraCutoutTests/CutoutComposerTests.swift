import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import NihoCameraCutout
import Testing

struct CutoutComposerTests {
    @Test func float32PixelBufferClampsAndQuantizesMaskValues() throws {
        var optionalBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            3,
            1,
            kCVPixelFormatType_OneComponent32Float,
            nil,
            &optionalBuffer
        )
        #expect(status == kCVReturnSuccess)
        let buffer = try #require(optionalBuffer)
        CVPixelBufferLockBaseAddress(buffer, [])
        let values = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: Float.self)
        values[0] = 0
        values[1] = 0.5
        values[2] = 1
        CVPixelBufferUnlockBaseAddress(buffer, [])

        let raster = try MaskRaster(pixelBuffer: buffer)
        #expect(raster.pixels == Data([0, 128, 255]))
        #expect(try MaskRaster(pngData: raster.pngData()).pixels == Data([0, 128, 255]))
    }

    @Test func softMaskAndOriginalAlphaArePreserved() throws {
        let image = CIImage(color: CIColor(red: 1, green: 0, blue: 0, alpha: 0.5))
            .cropped(to: CGRect(x: 0, y: 0, width: 1, height: 1))
        let mask = try MaskRaster(width: 1, height: 1, pixels: Data([128])).pngData()
        let output = try CutoutComposer().compose(
            image: image,
            maskPNGData: mask,
            background: .transparent
        )
        let pixel = try rgba8(output)
        #expect(abs(Int(pixel[3]) - 64) <= 2)
    }

    @Test func transparentWhiteAndCustomBackgroundComposition() throws {
        let image = CIImage(color: CIColor(red: 1, green: 0, blue: 0, alpha: 1))
            .cropped(to: CGRect(x: 0, y: 0, width: 1, height: 1))
        let emptyMask = try MaskRaster(width: 1, height: 1, pixels: Data([0])).pngData()
        let composer = CutoutComposer()

        #expect(try rgba8(composer.compose(image: image, maskPNGData: emptyMask, background: .transparent))[3] == 0)
        let white = try rgba8(composer.compose(image: image, maskPNGData: emptyMask, background: .color(.white)))
        #expect(white[0] == 255 && white[1] == 255 && white[2] == 255 && white[3] == 255)
        let blue = try rgba8(composer.compose(
            image: image,
            maskPNGData: emptyMask,
            background: .color(CutoutRGBA(red: 0, green: 0, blue: 1))
        ))
        #expect(blue[0] == 0 && blue[1] == 0 && blue[2] == 255 && blue[3] == 255)
    }

    @Test func colorBackgroundFlattensSemiTransparentSourceToOpaque() throws {
        let image = CIImage(color: CIColor(red: 1, green: 0, blue: 0, alpha: 0.5))
            .cropped(to: CGRect(x: 0, y: 0, width: 1, height: 1))
        let mask = try MaskRaster(width: 1, height: 1, pixels: Data([255])).pngData()
        let output = try CutoutComposer().compose(
            image: image,
            maskPNGData: mask,
            background: .color(CutoutRGBA(red: 0, green: 0, blue: 1))
        )
        let pixel = try rgba8(output)
        #expect(pixel[3] == 255)
        #expect(pixel[0] > 120 && pixel[2] > 120)
    }

    @Test func eraseAndRestoreBrushUseTopLeftNormalizedCoordinates() throws {
        let original = try MaskRaster(width: 5, height: 5, pixels: Data(repeating: 255, count: 25))
        let erased = original.applying([CutoutBrushStroke(
            mode: .erase,
            radius: 0.2,
            points: [CutoutPoint(x: 0, y: 0)]
        )])
        #expect(erased.pixels[0] == 0)
        #expect(erased.pixels[24] == 255)
        let restored = erased.applying([CutoutBrushStroke(
            mode: .restore,
            radius: 0.2,
            points: [CutoutPoint(x: 0, y: 0)]
        )])
        #expect(restored.pixels[0] == 255)
    }

    @Test func brushCoordinatesOutsideImagePaintOnlyWhereIntersecting() throws {
        let original = try MaskRaster(width: 5, height: 5, pixels: Data(repeating: 255, count: 25))
        let erased = original.applying([CutoutBrushStroke(
            mode: .erase,
            radius: 0.2,
            points: [CutoutPoint(x: -4, y: 0.5), CutoutPoint(x: 5, y: 0.5)]
        )])

        #expect(erased.pixels[10] == 0)
        #expect(erased.pixels[14] == 0)
        #expect(erased.pixels[0] == 255)
    }

    @Test func maskPNGRoundTripKeepsRowsAndDimensions() throws {
        let original = try MaskRaster(width: 2, height: 3, pixels: Data([0, 32, 64, 128, 192, 255]))
        let decoded = try MaskRaster(pngData: original.pngData())
        #expect(decoded.width == 2)
        #expect(decoded.height == 3)
        #expect(decoded.pixels == original.pixels)
    }

    @Test func topLeftStrokeMakesTheComposedTopLeftCornerTransparent() throws {
        let image = CIImage(color: CIColor(red: 1, green: 0, blue: 0, alpha: 1))
            .cropped(to: CGRect(x: 0, y: 0, width: 3, height: 3))
        let mask = try MaskRaster(
            width: 3,
            height: 3,
            pixels: Data(repeating: 255, count: 9)
        ).pngData()
        let composed = try CutoutComposer().compose(
            image: image,
            maskPNGData: mask,
            background: .transparent,
            brushStrokes: [CutoutBrushStroke(
                mode: .erase,
                radius: 0.34,
                points: [CutoutPoint(x: 0, y: 0)]
            )]
        )
        let rendered = try CutoutComposer().renderCGImage(composed)
        let topLeft = try #require(rendered.cropping(to: CGRect(x: 0, y: 0, width: 1, height: 1)))
        let bottomLeft = try #require(rendered.cropping(to: CGRect(x: 0, y: 2, width: 1, height: 1)))
        #expect(try rgba8(topLeft)[3] == 0)
        #expect(try rgba8(bottomLeft)[3] == 255)
    }

    @Test func exportRefusesExistingDestination() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutExportTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let output = root.appendingPathComponent("existing.png")
        try Data("keep".utf8).write(to: output)
        let image = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 2, height: 2))
        let mask = try MaskRaster(width: 2, height: 2, pixels: Data(repeating: 255, count: 4)).pngData()

        #expect(throws: CutoutError.self) {
            try CutoutComposer().export(
                image: image,
                maskPNGData: mask,
                background: .transparent,
                destination: output,
                format: .png
            )
        }
        #expect(try Data(contentsOf: output) == Data("keep".utf8))
    }

    @Test func pngKeepsTransparencyAndJPEGFlattensItToWhite() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutFormatTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let image = CIImage(color: CIColor(red: 1, green: 0, blue: 0, alpha: 1))
            .cropped(to: CGRect(x: 0, y: 0, width: 1, height: 1))
        let mask = try MaskRaster(width: 1, height: 1, pixels: Data([0])).pngData()
        let composer = CutoutComposer()
        let png = root.appendingPathComponent("transparent.png")
        let jpeg = root.appendingPathComponent("white.jpg")
        try composer.export(
            image: image,
            maskPNGData: mask,
            background: .transparent,
            destination: png,
            format: .png
        )
        try composer.export(
            image: image,
            maskPNGData: mask,
            background: .transparent,
            destination: jpeg,
            format: .jpeg(quality: 1)
        )
        let pngPixel = try decodedRGBA(png)
        let jpegPixel = try decodedRGBA(jpeg)
        #expect(pngPixel[3] == 0)
        #expect(jpegPixel[0] > 245 && jpegPixel[1] > 245 && jpegPixel[2] > 245)
        #expect(jpegPixel[3] == 255)
    }

    @Test func pngAndJPEGPreserveCaptureTimeWithoutLocationMetadata() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutMetadataTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let image = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 2, height: 2))
        let mask = try MaskRaster(width: 2, height: 2, pixels: Data(repeating: 255, count: 4)).pngData()
        let captureDate = "2026:10:15 07:30:00"
        let composer = CutoutComposer()
        let outputFormats: [(String, CutoutOutputFormat)] = [
            ("cutout.png", .png),
            ("cutout.jpg", .jpeg(quality: 1)),
        ]

        for (name, format) in outputFormats {
            let output = root.appendingPathComponent(name)
            try composer.export(
                image: image,
                maskPNGData: mask,
                background: .transparent,
                destination: output,
                format: format,
                captureDateTimeOriginal: captureDate
            )

            let source = try #require(CGImageSourceCreateWithURL(output as CFURL, nil))
            let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
            #expect(exif?[kCGImagePropertyExifDateTimeOriginal] as? String == captureDate)
            #expect(properties[kCGImagePropertyGPSDictionary] == nil)
        }
    }

    private func rgba8(_ image: CIImage) throws -> [UInt8] {
        let extent = image.extent.integral
        var bytes = [UInt8](repeating: 0, count: Int(extent.width * extent.height) * 4)
        bytes.withUnsafeMutableBytes { buffer in
            CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any,
                .useSoftwareRenderer: true
            ]).render(
                image,
                toBitmap: buffer.baseAddress!,
                rowBytes: Int(extent.width) * 4,
                bounds: extent,
                format: .RGBA8,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
            )
        }
        return bytes
    }

    private func rgba8(_ image: CGImage) throws -> [UInt8] {
        var pixel = [UInt8](repeating: 0, count: 4)
        let rendered = pixel.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(
                data: bytes.baseAddress,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return true
        }
        try #require(rendered)
        return pixel
    }

    private func decodedRGBA(_ url: URL) throws -> [UInt8] {
        let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var pixel = [UInt8](repeating: 0, count: 4)
        let rendered = pixel.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(
                data: bytes.baseAddress,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return true
        }
        try #require(rendered)
        return pixel
    }
}
