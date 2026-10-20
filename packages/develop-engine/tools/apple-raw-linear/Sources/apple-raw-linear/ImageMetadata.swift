import Foundation
import ImageIO

/// Camera identity and a few shooting parameters from ImageIO. ISO is kept
/// because Core Image's noise-reduction / sharpening defaults depend on it.
struct ImageMetadata {
    let make: String?
    let model: String?
    let iso: Double?
    let exposureTime: Double?
    let fNumber: Double?
    let focalLength: Double?
    let lensModel: String?

    static func read(url: URL) -> ImageMetadata {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        else {
            return ImageMetadata(
                make: nil, model: nil, iso: nil, exposureTime: nil,
                fNumber: nil, focalLength: nil, lensModel: nil
            )
        }
        let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any]
        let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any]
        let exifAux = properties[kCGImagePropertyExifAuxDictionary as String] as? [String: Any]
        func text(_ value: Any?) -> String? {
            guard let string = value as? String else { return nil }
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        func number(_ value: Any?) -> Double? {
            if let array = value as? [Any] { return number(array.first) }
            if let number = value as? NSNumber { return number.doubleValue }
            return nil
        }
        return ImageMetadata(
            make: text(tiff?[kCGImagePropertyTIFFMake as String]),
            model: text(tiff?[kCGImagePropertyTIFFModel as String]),
            iso: number(exif?[kCGImagePropertyExifISOSpeedRatings as String]),
            exposureTime: number(exif?[kCGImagePropertyExifExposureTime as String]),
            fNumber: number(exif?[kCGImagePropertyExifFNumber as String]),
            focalLength: number(exif?[kCGImagePropertyExifFocalLength as String]),
            lensModel: text(exif?[kCGImagePropertyExifLensModel as String])
                ?? text(exifAux?[kCGImagePropertyExifAuxLensModel as String])
        )
    }

    var cameraJSON: [String: Any] {
        ["make": JSONOutput.optional(make), "model": JSONOutput.optional(model)]
    }

    var shootingJSON: [String: Any] {
        [
            "iso": iso.map { JSONOutput.number($0) } ?? NSNull(),
            "exposureTime": exposureTime.map { JSONOutput.number($0) } ?? NSNull(),
            "fNumber": fNumber.map { JSONOutput.number($0) } ?? NSNull(),
            "focalLength": focalLength.map { JSONOutput.number($0) } ?? NSNull(),
            "lensModel": JSONOutput.optional(lensModel),
        ]
    }
}
