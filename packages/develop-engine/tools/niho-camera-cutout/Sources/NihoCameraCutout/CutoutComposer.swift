import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum CutoutOutputFormat: Sendable {
    case png
    case jpeg(quality: Double)

    public static func inferred(from url: URL, jpegQuality: Double = 0.92) throws -> Self {
        switch url.pathExtension.lowercased() {
        case "png": .png
        case "jpg", "jpeg": .jpeg(quality: jpegQuality)
        default: throw CutoutError.unsupportedOutput(url)
        }
    }
}

public struct CutoutComposer: Sendable {
    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    public init() {}

    public func compose(
        image: CIImage,
        maskPNGData: Data,
        background: CutoutBackground,
        brushStrokes: [CutoutBrushStroke] = []
    ) throws -> CIImage {
        let imageExtent = image.extent.integral
        guard imageExtent.width > 0, imageExtent.height > 0 else {
            throw CutoutError.invalidImageDimensions
        }
        let raster = try MaskRaster(pngData: maskPNGData).applying(brushStrokes)
        let maskCGImage = try raster.cgImage()
        // A mask is numerical data, not gray color. NSNull prevents Core Image
        // from applying a color-space transform to soft alpha values.
        var mask = CIImage(cgImage: maskCGImage, options: [.colorSpace: NSNull()])
        let maskExtent = mask.extent
        let scaleX = imageExtent.width / maskExtent.width
        let scaleY = imageExtent.height / maskExtent.height
        mask = mask.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
            .transformed(by: CGAffineTransform(
                translationX: imageExtent.minX,
                y: imageExtent.minY
            ))
            .cropped(to: imageExtent)

        // First form the actual cutout (source alpha × numerical mask). Only
        // then composite it over a color. This avoids letting transparent
        // source pixels punch holes through an otherwise opaque background.
        let clear = CIImage(color: .clear).cropped(to: imageExtent)
        let cutout = image.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: clear,
            kCIInputMaskImageKey: mask
        ]).cropped(to: imageExtent)
        switch background {
        case .transparent:
            return cutout
        case let .color(value):
            let opaqueBackground = CIImage(color: CIColor(
                red: CGFloat(clamp(value.red)),
                green: CGFloat(clamp(value.green)),
                blue: CGFloat(clamp(value.blue)),
                alpha: 1
            )).cropped(to: imageExtent)
            return cutout.composited(over: opaqueBackground).cropped(to: imageExtent)
        }
    }

    public func renderCGImage(_ image: CIImage) throws -> CGImage {
        let extent = image.extent.integral
        guard extent.width > 0, extent.height > 0 else { throw CutoutError.invalidImageDimensions }
        let context = CIContext(options: [
            .workingColorSpace: Self.sRGB,
            .outputColorSpace: Self.sRGB,
            .cacheIntermediates: false
        ])
        guard let result = context.createCGImage(
            image,
            from: extent,
            format: .RGBA8,
            colorSpace: Self.sRGB
        ) else { throw CutoutError.invalidImageDimensions }
        return result
    }

    @discardableResult
    public func export(
        image: CIImage,
        maskPNGData: Data,
        background: CutoutBackground,
        brushStrokes: [CutoutBrushStroke] = [],
        destination: URL,
        format: CutoutOutputFormat,
        captureDateTimeOriginal: String? = nil,
        protectedSourceURLs: [URL] = []
    ) throws -> CGSize {
        try Self.validateDestination(destination, protectedSourceURLs: protectedSourceURLs)
        var effectiveBackground = background
        if case .jpeg = format {
            switch background {
            case .transparent:
                effectiveBackground = .color(.white)
            case let .color(value):
                effectiveBackground = .color(CutoutRGBA(
                    red: value.red,
                    green: value.green,
                    blue: value.blue,
                    alpha: 1
                ))
            }
        }
        let composed = try compose(
            image: image,
            maskPNGData: maskPNGData,
            background: effectiveBackground,
            brushStrokes: brushStrokes
        )
        let cgImage = try renderCGImage(composed)
        try Self.write(
            cgImage,
            destination: destination,
            format: format,
            captureDateTimeOriginal: captureDateTimeOriginal
        )
        return CGSize(width: cgImage.width, height: cgImage.height)
    }

    private static func write(
        _ image: CGImage,
        destination: URL,
        format: CutoutOutputFormat,
        captureDateTimeOriginal: String?
    ) throws {
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // NSSavePanel grants access to the chosen file, not arbitrary siblings.
        // Foundation supplies an authorized replacement directory on the same
        // volume, retaining the atomic no-overwrite link into the chosen URL.
        let replacementDirectory = try FileManager.default.url(
            for: .itemReplacementDirectory,
            in: .userDomainMask,
            appropriateFor: destination,
            create: true
        )
        defer { try? FileManager.default.removeItem(at: replacementDirectory) }
        let temporary = replacementDirectory
            .appendingPathComponent(".\(UUID().uuidString)-\(destination.lastPathComponent)")
        let type: UTType
        var properties: [CFString: Any] = [kCGImagePropertyOrientation: 1]
        if let captureDateTimeOriginal {
            properties[kCGImagePropertyExifDictionary] = [
                kCGImagePropertyExifDateTimeOriginal: captureDateTimeOriginal
            ] as [CFString: Any]
        }
        switch format {
        case .png:
            type = .png
            properties[kCGImagePropertyPNGDictionary] = [
                kCGImagePropertyPNGInterlaceType: 0
            ]
        case let .jpeg(quality):
            type = .jpeg
            properties[kCGImageDestinationLossyCompressionQuality] = clamp(quality)
        }
        do {
            guard let output = CGImageDestinationCreateWithURL(
                temporary as CFURL,
                type.identifier as CFString,
                1,
                nil
            ) else { throw CutoutError.encodingFailed(destination) }
            CGImageDestinationAddImage(output, image, properties as CFDictionary)
            guard CGImageDestinationFinalize(output) else {
                throw CutoutError.encodingFailed(destination)
            }
            // link(2) provides a no-overwrite install. It also refuses an
            // existing symlink instead of following it.
            if Darwin.link(temporary.path, destination.path) != 0 {
                if errno == EEXIST { throw CutoutError.destinationExists(destination) }
                throw CocoaError(.fileWriteUnknown)
            }
            try? FileManager.default.removeItem(at: temporary)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    private static func validateDestination(
        _ destination: URL,
        protectedSourceURLs: [URL]
    ) throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory) {
            if isDirectory.boolValue { throw CutoutError.destinationIsDirectory(destination) }
            throw CutoutError.destinationExists(destination)
        }
        let resolvedDestination = destination.standardizedFileURL.resolvingSymlinksInPath()
        for source in protectedSourceURLs {
            let resolvedSource = source.standardizedFileURL.resolvingSymlinksInPath()
            if resolvedDestination == resolvedSource || sameFile(destination, source) {
                throw CutoutError.sourceOverwriteForbidden(destination)
            }
        }
    }

    private static func sameFile(_ lhs: URL, _ rhs: URL) -> Bool {
        guard let left = try? lhs.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier,
              let right = try? rhs.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
        else { return false }
        return String(describing: left) == String(describing: right)
    }
}

private func clamp(_ value: Double) -> Double {
    max(0, min(1, value))
}
