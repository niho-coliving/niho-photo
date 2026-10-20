import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The color space attached to the written file. The pixel values are never
/// converted by ImageIO; the ICC only helps viewers. The metadata JSON
/// `space` is the contract.
struct OutputColorSpace {
    let colorSpace: CGColorSpace
    let description: String

    /// Linear ProPhoto (ROMM primaries, D50 white, gamma 1.0) as a calibrated
    /// RGB space built from the same matrix as `ColorMath`.
    static func linearProPhoto() -> CGColorSpace? {
        let m = ColorMath.linearProPhotoToXYZD50
        let white = m.rowSums
        let whitePoint: [CGFloat] = [white.x, white.y, white.z]
        let blackPoint: [CGFloat] = [0, 0, 0]
        let gamma: [CGFloat] = [1, 1, 1]
        // [Xr Yr Zr Xg Yg Zg Xb Yb Zb]: the columns of the RGB → XYZ matrix.
        let matrix: [CGFloat] = [m.r0.x, m.r1.x, m.r2.x, m.r0.y, m.r1.y, m.r2.y, m.r0.z, m.r1.z, m.r2.z]
        return CGColorSpace(
            calibratedRGBWhitePoint: whitePoint,
            blackPoint: blackPoint,
            gamma: gamma,
            matrix: matrix
        )
    }

    static func select(space: OutputSpace, encoding: OutputEncoding) -> OutputColorSpace {
        switch (space, encoding) {
        case (.linearProPhoto, .png16g18), (.linearProPhoto, .png16SignedG18):
            if let romm = CGColorSpace(name: CGColorSpace.rommrgb) {
                return OutputColorSpace(colorSpace: romm, description: "ROMM RGB (CGColorSpace.rommrgb, gamma 1.8, D50)")
            }
        case (.linearProPhoto, _):
            if let linear = linearProPhoto() {
                return OutputColorSpace(
                    colorSpace: linear,
                    description: "linear ProPhoto (calibrated RGB: ROMM primaries, D50 white, gamma 1.0)"
                )
            }
        case (.linearSRGB, .tiff32f):
            if let extended = CGColorSpace(name: CGColorSpace.extendedLinearSRGB) {
                return OutputColorSpace(colorSpace: extended, description: "extended linear sRGB (CGColorSpace.extendedLinearSRGB)")
            }
        case (.linearSRGB, _):
            if let linear = CGColorSpace(name: CGColorSpace.linearSRGB) {
                return OutputColorSpace(colorSpace: linear, description: "linear sRGB (CGColorSpace.linearSRGB)")
            }
        }
        // Allowed by the spec as a label only; the metadata names the real space.
        guard let fallback = CGColorSpace(name: CGColorSpace.genericRGBLinear) else {
            preconditionFailure("genericRGBLinear is unavailable")
        }
        return OutputColorSpace(colorSpace: fallback, description: "generic linear RGB (label only; see metadata space)")
    }
}

enum ImageWriter {
    enum Container {
        case tiff
        case png

        var type: UTType {
            switch self {
            case .tiff: .tiff
            case .png: .png
            }
        }
    }

    /// Packed RGB float32 (3 × 32 bit, no alpha, host little-endian) as TIFF.
    static func writeFloat32RGB(
        _ pixels: UnsafeRawPointer,
        width: Int,
        height: Int,
        colorSpace: CGColorSpace,
        to url: URL
    ) throws {
        let bitmapInfo = CGBitmapInfo(rawValue:
            CGImageAlphaInfo.none.rawValue
                | CGBitmapInfo.floatComponents.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue
        )
        try write(
            pixels,
            width: width,
            height: height,
            bitsPerComponent: 32,
            bitsPerPixel: 96,
            bytesPerRow: width * 12,
            bitmapInfo: bitmapInfo,
            colorSpace: colorSpace,
            container: .tiff,
            to: url
        )
    }

    /// Packed RGB UInt16 (3 × 16 bit, no alpha, host little-endian).
    static func writeUInt16RGB(
        _ pixels: UnsafeRawPointer,
        width: Int,
        height: Int,
        colorSpace: CGColorSpace,
        container: Container,
        to url: URL
    ) throws {
        let bitmapInfo = CGBitmapInfo(rawValue:
            CGImageAlphaInfo.none.rawValue | CGBitmapInfo.byteOrder16Little.rawValue
        )
        try write(
            pixels,
            width: width,
            height: height,
            bitsPerComponent: 16,
            bitsPerPixel: 48,
            bytesPerRow: width * 6,
            bitmapInfo: bitmapInfo,
            colorSpace: colorSpace,
            container: container,
            to: url
        )
    }

    // swiftlint:disable:next function_parameter_count
    private static func write(
        _ pixels: UnsafeRawPointer,
        width: Int,
        height: Int,
        bitsPerComponent: Int,
        bitsPerPixel: Int,
        bytesPerRow: Int,
        bitmapInfo: CGBitmapInfo,
        colorSpace: CGColorSpace,
        container: Container,
        to url: URL
    ) throws {
        // No copy: the caller keeps `pixels` alive until this returns.
        guard let provider = CGDataProvider(
            dataInfo: nil,
            data: pixels,
            size: bytesPerRow * height,
            releaseData: { _, _, _ in }
        ) else {
            throw ToolError.writeFailed("cannot wrap \(width)x\(height) pixels in a CGDataProvider")
        }
        guard let image = CGImage(
            width: width,
            height: height,
            bitsPerComponent: bitsPerComponent,
            bitsPerPixel: bitsPerPixel,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ) else {
            throw ToolError.writeFailed(
                "CGImage rejected \(bitsPerComponent)-bit x3 RGB (\(bitsPerPixel) bpp) pixels"
            )
        }
        var properties: [CFString: Any] = [:]
        if container == .tiff {
            properties[kCGImagePropertyTIFFDictionary] = [
                kCGImagePropertyTIFFSoftware: "\(Tool.name) \(Tool.version)",
                kCGImagePropertyTIFFCompression: 1,
            ] as [CFString: Any]
        }
        try FileWriting.atomically(to: url) { temporary in
            guard let destination = CGImageDestinationCreateWithURL(
                temporary as CFURL,
                container.type.identifier as CFString,
                1,
                nil
            ) else {
                throw ToolError.writeFailed("ImageIO cannot create a \(container.type.identifier) file at \(url.path)")
            }
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
            guard CGImageDestinationFinalize(destination) else {
                throw ToolError.writeFailed("ImageIO failed to write \(url.path)")
            }
        }
    }
}

enum FileWriting {
    /// Writes through a hidden temporary file in the destination directory and
    /// renames it into place, so an interrupted run never leaves a partial
    /// file that a batch script would later skip as "already rendered".
    static func atomically(to url: URL, _ body: (URL) throws -> Void) throws {
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw ToolError.writeFailed("cannot create \(directory.path): \(error.localizedDescription)")
        }
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).partial-\(getpid())")
        try? FileManager.default.removeItem(at: temporary)
        do {
            try body(temporary)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
        guard rename(temporary.path, url.path) == 0 else {
            let reason = String(cString: strerror(errno))
            try? FileManager.default.removeItem(at: temporary)
            throw ToolError.writeFailed("cannot move the finished file to \(url.path): \(reason)")
        }
    }

    static func write(_ data: Data, to url: URL) throws {
        try atomically(to: url) { temporary in
            do {
                try data.write(to: temporary)
            } catch {
                throw ToolError.writeFailed("cannot write \(url.path): \(error.localizedDescription)")
            }
        }
    }

    static func fileSize(_ url: URL) -> Int64? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.int64Value
    }
}
