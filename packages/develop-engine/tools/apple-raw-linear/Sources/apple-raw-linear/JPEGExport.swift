import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The full-size export's JPEG metadata (W2b-1 #17145): **the capture date
/// and time only** (Epic #17114 Decision 10, the same rule as the crate's
/// `exif.rs`, F7a #17143). Without it the iPhone Photos library sorts an
/// export by the day it was saved; the location and the camera are not
/// carried (a location can give away a spot or someone's home).
///
/// - EXIF: `DateTimeOriginal`, and the original's `OffsetTimeOriginal` /
///   `SubsecTimeOriginal` when it has them; `PixelXDimension` /
///   `PixelYDimension` (the written size) and `ColorSpace` 1 (sRGB). TIFF
///   (IFD0): `Orientation` 1 (the pixels are upright).
/// - Nothing else: no GPS; no TIFF Make / Model / Software / Artist /
///   Copyright / DateTime; no ExifAux (lens), IPTC, XMP or maker notes; no
///   embedded thumbnail.
/// - No capture date (the original is unreadable, has none or a blank one):
///   no EXIF at all.
///
/// `encode-jpeg` writes it when it encodes; `retag-jpeg` puts it on a JPEG
/// that is already encoded (NIHO Desktop's Photo Bench export, W2b-2)
/// without re-encoding the image. ImageIO adds segments of its own (an EXIF
/// with the size and ColorSpace even when given none, IPTC, the source's
/// thumbnail), so both keep only JFIF, the one EXIF, ICC and Adobe segments
/// and read the result back (`ruleViolations`): a JPEG that would carry
/// anything else is not written.
enum JPEGExport {
    static let defaultQuality = 0.92

    /// The original's capture time, as its EXIF writes it.
    struct CaptureTime: Equatable {
        /// `YYYY:MM:DD HH:MM:SS` (the camera's clock).
        var dateTimeOriginal: String
        /// `+HH:MM` / `-HH:MM`; nil when the original has none.
        var offsetTimeOriginal: String?
        /// Fractions of the second (1 to 9 digits); nil when the original has none.
        var subsecTimeOriginal: String?
    }

    static let exifKey = kCGImagePropertyExifDictionary as String
    static let tiffKey = kCGImagePropertyTIFFDictionary as String

    /// The dictionaries ImageIO may report for an export (`{JFIF}` is JFIF's
    /// density). Any other (`{GPS}`, `{ExifAux}`, `{IPTC}`, maker notes, ...)
    /// is a violation.
    static let allowedDictionaries: Set<String> = [
        exifKey, tiffKey, kCGImagePropertyJFIFDictionary as String,
    ]

    /// The rule's EXIF keys and the structural ones EXIF 2.32 asks of a
    /// compressed JPEG (the crate writes them; ImageIO may).
    static let allowedExifKeys: Set<String> = [
        kCGImagePropertyExifDateTimeOriginal as String,
        kCGImagePropertyExifOffsetTimeOriginal as String,
        kCGImagePropertyExifSubsecTimeOriginal as String,
        kCGImagePropertyExifPixelXDimension as String,
        kCGImagePropertyExifPixelYDimension as String,
        kCGImagePropertyExifColorSpace as String,
        kCGImagePropertyExifVersion as String,
        kCGImagePropertyExifFlashPixVersion as String,
        kCGImagePropertyExifComponentsConfiguration as String,
    ]

    /// IFD0: the orientation and the image's structure (never the camera).
    static let allowedTIFFKeys: Set<String> = [
        kCGImagePropertyTIFFOrientation as String,
        kCGImagePropertyTIFFXResolution as String,
        kCGImagePropertyTIFFYResolution as String,
        kCGImagePropertyTIFFResolutionUnit as String,
        "YCbCrPositioning", // no ImageIO constant
    ]

    static let xmpSignature = Array("http://ns.adobe.com/xap/1.0/".utf8) + [0]

    // MARK: the rule

    /// The original's capture time (EXIF `DateTimeOriginal`); nil without
    /// one or with a blank / malformed one (`    :  :     :  :  `,
    /// `0000:00:00 00:00:00`). A malformed offset or sub-second is dropped.
    static func captureTime(from properties: [String: Any]) -> CaptureTime? {
        guard let exif = properties[exifKey] as? [String: Any],
              let date = trimmed(exif[kCGImagePropertyExifDateTimeOriginal as String]),
              isDateTime(date)
        else { return nil }
        return CaptureTime(
            dateTimeOriginal: date,
            offsetTimeOriginal: trimmed(exif[kCGImagePropertyExifOffsetTimeOriginal as String]).flatMap { isOffset($0) ? $0 : nil },
            subsecTimeOriginal: trimmed(exif[kCGImagePropertyExifSubsecTimeOriginal as String]).flatMap { isSubsec($0) ? $0 : nil }
        )
    }

    private static func trimmed(_ value: Any?) -> String? {
        (value as? String)?.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\0")))
    }

    private static func number(_ characters: [UInt8], _ range: Range<Int>) -> Int? {
        guard characters[range].allSatisfy({ (0x30 ... 0x39).contains($0) }) else { return nil }
        return Int(String(decoding: characters[range], as: UTF8.self))
    }

    /// A real Gregorian calendar date/time in `YYYY:MM:DD HH:MM:SS`, year 1...9999.
    static func isDateTime(_ value: String) -> Bool {
        let c = Array(value.utf8)
        guard c.count == 19, c[4] == 0x3A, c[7] == 0x3A, c[10] == 0x20, c[13] == 0x3A, c[16] == 0x3A,
              let year = number(c, 0 ..< 4), let month = number(c, 5 ..< 7), let day = number(c, 8 ..< 10),
              let hour = number(c, 11 ..< 13), let minute = number(c, 14 ..< 16), let second = number(c, 17 ..< 19)
        else { return false }
        guard year >= 1, (1 ... 12).contains(month), hour <= 23, minute <= 59, second <= 60 else {
            return false
        }
        let leapYear = year.isMultiple(of: 4) && (!year.isMultiple(of: 100) || year.isMultiple(of: 400))
        let daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return (1 ... daysInMonth[month - 1]).contains(day)
    }

    /// `+HH:MM` / `-HH:MM` within ±14:00.
    static func isOffset(_ value: String) -> Bool {
        let c = Array(value.utf8)
        guard c.count == 6, c[0] == 0x2B || c[0] == 0x2D, c[3] == 0x3A,
              let hours = number(c, 1 ..< 3), let minutes = number(c, 4 ..< 6)
        else { return false }
        return minutes <= 59 && hours * 60 + minutes <= 14 * 60
    }

    static func isSubsec(_ value: String) -> Bool {
        let c = Array(value.utf8)
        return (1 ... 9).contains(c.count) && number(c, 0 ..< c.count) != nil
    }

    /// The EXIF and TIFF dictionaries of the rule. `colorSpace` is 1 (sRGB)
    /// except for `retag-jpeg` on a JPEG whose ICC is not sRGB (65535).
    static func exifProperties(
        capture: CaptureTime,
        pixelWidth: Int,
        pixelHeight: Int,
        colorSpace: Int = 1
    ) -> [String: Any] {
        var exif: [String: Any] = [
            kCGImagePropertyExifDateTimeOriginal as String: capture.dateTimeOriginal,
            kCGImagePropertyExifPixelXDimension as String: pixelWidth,
            kCGImagePropertyExifPixelYDimension as String: pixelHeight,
            kCGImagePropertyExifColorSpace as String: colorSpace,
        ]
        if let offset = capture.offsetTimeOriginal {
            exif[kCGImagePropertyExifOffsetTimeOriginal as String] = offset
        }
        if let subsec = capture.subsecTimeOriginal {
            exif[kCGImagePropertyExifSubsecTimeOriginal as String] = subsec
        }
        return [exifKey: exif, tiffKey: [kCGImagePropertyTIFFOrientation as String: 1]]
    }

    /// What `CGImageDestinationAddImage` gets for `encode-jpeg`: the rule
    /// (nothing without a capture time), quality and orientation 1. No
    /// thumbnail.
    static func destinationProperties(
        capture: CaptureTime?,
        pixelWidth: Int,
        pixelHeight: Int,
        quality: Double
    ) -> [String: Any] {
        var properties = capture.map {
            exifProperties(capture: $0, pixelWidth: pixelWidth, pixelHeight: pixelHeight)
        } ?? [:]
        properties[kCGImageDestinationLossyCompressionQuality as String] = min(max(quality, 0), 1)
        properties[kCGImagePropertyOrientation as String] = 1
        return properties
    }

    /// The original's properties (Photo Bench `CoreImageDecoder.readMetadata`);
    /// nil when ImageIO cannot read the file.
    static func readMetadata(url: URL) -> [String: Any]? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        else { return nil }
        return properties
    }

    // MARK: writing

    /// `jpeg` with `properties` (the rule's EXIF / TIFF dictionaries) as its
    /// only metadata, the image copied without re-encoding
    /// (`CGImageDestinationCopyImageSource`, no merge; GPS and the XMP packet
    /// excluded). Hand it a JPEG without metadata segments: the copy keeps a
    /// source's EXIF thumbnail (IFD1) even without merging.
    static func rewritingMetadata(_ jpeg: Data, properties: [String: Any]) throws -> Data {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil) else {
            throw ToolError.readFailed("ImageIO cannot read the JPEG")
        }
        let metadata = CGImageMetadataCreateMutable()
        for (dictionary, values) in properties {
            for (key, value) in values as? [String: Any] ?? [:] {
                guard CGImageMetadataSetValueMatchingImageProperty(
                    metadata, dictionary as CFString, key as CFString, value as AnyObject
                ) else {
                    throw ToolError.writeFailed("ImageIO cannot set \(dictionary) \(key)")
                }
            }
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ToolError.writeFailed("ImageIO cannot create a JPEG")
        }
        let options: [String: Any] = [
            kCGImageDestinationMetadata as String: metadata,
            kCGImageDestinationMergeMetadata as String: false,
            kCGImageMetadataShouldExcludeGPS as String: true,
            kCGImageMetadataShouldExcludeXMP as String: true,
        ]
        var error: Unmanaged<CFError>?
        guard CGImageDestinationCopyImageSource(destination, source, options as CFDictionary, &error) else {
            let reason = error.map { "\($0.takeRetainedValue())" } ?? "no reason given"
            throw ToolError.writeFailed("ImageIO cannot rewrite the metadata: \(reason)")
        }
        return output as Data
    }

    /// ImageIO's JPEG with only JFIF, the EXIF (with a capture time), ICC and
    /// Adobe segments, checked against the rule; `write_failed` (nothing
    /// written) when it still carries anything else.
    static func keepingTheRule(_ jpeg: Data, capture: CaptureTime?, path: String) throws -> Data {
        let kept = try JPEGSegments.strippingMetadata(jpeg, keepICC: true, keepExif: capture != nil)
        let violations = ruleViolations(in: kept, capture: capture)
        guard violations.isEmpty else {
            throw ToolError.writeFailed(
                "\(path) not written: the JPEG would carry \(violations.joined(separator: ", ")) (the export carries the capture time only)"
            )
        }
        return kept
    }

    // MARK: checking

    /// How a written JPEG departs from the rule, read back from its segments
    /// and through ImageIO; empty = the rule. A GPS, the camera, ExifAux,
    /// IPTC, XMP, maker notes, a thumbnail (EXIF IFD1 or JFIF), an EXIF
    /// without `capture`, or `capture` not written as given.
    static func ruleViolations(in data: Data, capture: CaptureTime?) -> [String] {
        let bytes = [UInt8](data)
        guard let (segments, _) = try? JPEGSegments.parse(bytes) else { return ["not a JPEG"] }
        var violations: [String] = []
        var exifSegments = 0
        for segment in segments {
            switch segment.marker {
            case 0xE0:
                if !JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.jfifSignature) {
                    violations.append("APP0 (JFXX)")
                } else if segment.payload.count > 14 {
                    violations.append("JFIF thumbnail")
                }
            case 0xE1:
                if JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.exifSignature) {
                    exifSegments += 1
                    switch linksSecondIFD(bytes, segment) {
                    case true?: violations.append("EXIF thumbnail (IFD1)")
                    case false?: break
                    case nil: violations.append("unreadable EXIF")
                    }
                } else if JPEGSegments.payload(bytes, segment, startsWith: xmpSignature) {
                    violations.append("XMP")
                } else {
                    violations.append("APP1")
                }
            case 0xE2:
                if !JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.iccSignature) {
                    violations.append("APP2 (MPF)")
                }
            case 0xED:
                violations.append("IPTC (APP13)")
            case 0xEE:
                if !JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.adobeSignature) {
                    violations.append("APP14")
                }
            case 0xE3 ... 0xEF:
                violations.append("APP\(Int(segment.marker) - 0xE0)")
            case 0xFE:
                violations.append("comment")
            default:
                break
            }
        }
        if exifSegments > 1 {
            violations.append("\(exifSegments) EXIF segments")
        }
        if capture == nil, exifSegments > 0 {
            violations.append("EXIF without a capture time")
        }

        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        else { return violations + ["unreadable by ImageIO"] }
        for (key, value) in properties.sorted(by: { $0.key < $1.key })
            where value is [String: Any] && !allowedDictionaries.contains(key)
        {
            violations.append(key)
        }
        let exif = properties[exifKey] as? [String: Any] ?? [:]
        let tiff = properties[tiffKey] as? [String: Any] ?? [:]
        violations += exif.keys.filter { !allowedExifKeys.contains($0) }.sorted().map { "\(exifKey) \($0)" }
        violations += tiff.keys.filter { !allowedTIFFKeys.contains($0) }.sorted().map { "\(tiffKey) \($0)" }
        let orientation = properties[kCGImagePropertyOrientation as String] as? Int ?? 1
        if orientation != 1 {
            violations.append("orientation \(orientation)")
        }
        if let capture {
            let written: [(String, String?)] = [
                (kCGImagePropertyExifDateTimeOriginal as String, capture.dateTimeOriginal),
                (kCGImagePropertyExifOffsetTimeOriginal as String, capture.offsetTimeOriginal),
                (kCGImagePropertyExifSubsecTimeOriginal as String, capture.subsecTimeOriginal),
            ]
            for (key, expected) in written where trimmed(exif[key]) != expected {
                violations.append("\(key) \(trimmed(exif[key]) ?? "missing") instead of \(expected ?? "none")")
            }
        }
        return violations
    }

    /// Whether an Exif APP1 links a second IFD (IFD1: the thumbnail's); nil
    /// when its TIFF structure cannot be read.
    static func linksSecondIFD(_ bytes: [UInt8], _ segment: JPEGSegments.Segment) -> Bool? {
        let tiff = segment.payload.lowerBound + JPEGSegments.exifSignature.count
        let end = segment.payload.upperBound
        guard tiff + 8 <= end else { return nil }
        let bigEndian: Bool
        switch (bytes[tiff], bytes[tiff + 1]) {
        case (0x4D, 0x4D): bigEndian = true
        case (0x49, 0x49): bigEndian = false
        default: return nil
        }
        func read(_ offset: Int, _ count: Int) -> Int? {
            guard offset >= 0, tiff + offset + count <= end else { return nil }
            let slice = Array(bytes[(tiff + offset) ..< (tiff + offset + count)])
            return (bigEndian ? slice : slice.reversed()).reduce(0) { $0 << 8 | Int($1) }
        }
        guard let ifd0 = read(4, 4), let entries = read(ifd0, 2), let next = read(ifd0 + 2 + 12 * entries, 4) else {
            return nil
        }
        return next != 0
    }
}

extension JPEGSegments {
    /// The image itself: all non-metadata segments and entropy-coded bytes,
    /// in order, with APPn / COM segments omitted wherever they occur. A
    /// lossless metadata rewrite keeps this byte for byte.
    static func imageData(_ data: Data) -> Data? {
        let bytes = [UInt8](data)
        guard let (segments, scanStart) = try? parse(bytes) else { return nil }
        var image = Data()
        for segment in segments where segment.range.lowerBound < scanStart && !isMetadata(segment.marker) {
            image.append(contentsOf: bytes[segment.range])
        }

        var copiedThrough = scanStart
        for segment in segments where segment.range.lowerBound >= scanStart && isMetadata(segment.marker) {
            image.append(contentsOf: bytes[copiedThrough ..< segment.range.lowerBound])
            copiedThrough = segment.range.upperBound
        }
        image.append(contentsOf: bytes[copiedThrough...])
        return image
    }
}

// MARK: - encode-jpeg

enum EncodeJPEGCommand {
    static func run(_ options: EncodeJPEGOptions) throws -> [String: Any] {
        let started = ContinuousClock.now
        var warnings: [String] = []

        let pixelsURL = try InputFile.existing(options.pixels)
        let metadataURL = URL(fileURLWithPath: options.metadataFrom).standardizedFileURL
        let outURL = URL(fileURLWithPath: options.out).standardizedFileURL
        guard outURL.path != pixelsURL.path, outURL.path != metadataURL.path else {
            throw ToolError.invalidArguments("--out must not overwrite --pixels or --metadata-from")
        }

        guard let pixelsSource = CGImageSourceCreateWithURL(pixelsURL as CFURL, nil),
              let decoded = CGImageSourceCreateImageAtIndex(pixelsSource, 0, nil)
        else {
            throw ToolError.readFailed("cannot decode the pixels \(pixelsURL.path)")
        }
        let pixelProperties = CGImageSourceCopyPropertiesAtIndex(pixelsSource, 0, nil) as? [String: Any]
        if let profile = pixelProperties?[kCGImagePropertyProfileName as String] as? String,
           !profile.localizedCaseInsensitiveContains("srgb")
        {
            warnings.append("the pixels carry the ICC profile '\(profile)'; they are written as sRGB without conversion")
        }
        // The pixels are sRGB by contract (niho-develop-render writes an
        // untagged sRGB PNG): tag them as sRGB without converting, like
        // Photo Bench's `createCGImage(..., colorSpace: sRGB)`.
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let image = decoded.copy(colorSpace: srgb)
        else {
            throw ToolError.readFailed("the pixels \(pixelsURL.path) are not an RGB image")
        }

        let original = JPEGExport.readMetadata(url: metadataURL)
        let capture = original.flatMap(JPEGExport.captureTime(from:))
        if original == nil {
            warnings.append("cannot read metadata from \(metadataURL.path); the JPEG carries no EXIF")
        } else if capture == nil {
            warnings.append("\(metadataURL.path) has no capture time (EXIF DateTimeOriginal); the JPEG carries no EXIF")
        }
        let properties = JPEGExport.destinationProperties(
            capture: capture,
            pixelWidth: image.width,
            pixelHeight: image.height,
            quality: options.quality
        )
        let encodeStarted = ContinuousClock.now
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ToolError.writeFailed("ImageIO cannot create a JPEG for \(outURL.path)")
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ToolError.writeFailed("ImageIO failed to encode \(outURL.path)")
        }
        let jpeg = try JPEGExport.keepingTheRule(encoded as Data, capture: capture, path: outURL.path)
        try FileWriting.write(jpeg, to: outURL)
        let finished = ContinuousClock.now

        for warning in warnings {
            FileHandle.standardError.write(Data("warning: \(warning)\n".utf8))
        }
        return [
            "ok": true,
            "out": outURL.path,
            "width": image.width,
            "height": image.height,
            "bytes": FileWriting.fileSize(outURL).map { $0 as Any } ?? NSNull(),
            "quality": JSONOutput.number(min(max(options.quality, 0), 1)),
            // The capture time was written (W2b-1; 0.4.1-0.4.3 before it:
            // the original's metadata could be read).
            "metadata": capture != nil,
            "encodeMs": JSONOutput.number(milliseconds(from: encodeStarted, to: finished)),
            "totalMs": JSONOutput.number(milliseconds(from: started, to: finished)),
            "peakRSSBytes": RuntimeEnvironment.peakResidentBytes().map { $0 as Any } ?? NSNull(),
            "warnings": warnings.count,
        ]
    }
}

// MARK: - retag-jpeg

/// Puts the rule on an encoded JPEG without re-encoding it (NIHO Desktop
/// retags Photo Bench's full-size export, W2b-2): every metadata segment of
/// the input goes first (EXIF with its thumbnail, maker notes and GPS, XMP,
/// IPTC and comments, including between scans; JFIF, ICC and Adobe stay.
/// ImageIO then copies the image with the capture time read from the input.
/// Tables, scan headers and entropy-coded bytes remain the input's bytes; the
/// result is checked and written through a temporary file (`--in` may be `--out`).
enum RetagJPEGCommand {
    static func run(_ options: RetagJPEGOptions) throws -> [String: Any] {
        let started = ContinuousClock.now
        var warnings: [String] = []

        let inURL = try InputFile.existing(options.input)
        let outURL = URL(fileURLWithPath: options.out).standardizedFileURL
        let input: Data
        do {
            input = try Data(contentsOf: inURL)
        } catch {
            throw ToolError.readFailed("cannot read \(inURL.path): \(error.localizedDescription)")
        }
        guard let source = CGImageSourceCreateWithData(input as CFData, nil),
              CGImageSourceGetType(source) as String? == UTType.jpeg.identifier,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
              let height = properties[kCGImagePropertyPixelHeight as String] as? Int
        else {
            throw ToolError.readFailed("\(inURL.path) is not a JPEG")
        }
        let orientation = properties[kCGImagePropertyOrientation as String] as? Int ?? 1
        guard orientation == 1 else {
            throw ToolError.readFailed(
                "\(inURL.path) has orientation \(orientation); retag-jpeg writes orientation 1 and takes upright pixels only"
            )
        }
        let bare: Data
        do {
            bare = try JPEGSegments.strippingMetadata(input, keepICC: true)
        } catch let error as ToolError {
            throw ToolError.readFailed("\(inURL.path): \(error.message)")
        }

        let capture = JPEGExport.captureTime(from: properties)
        if capture == nil {
            warnings.append("\(inURL.path) has no capture time (EXIF DateTimeOriginal); the JPEG carries no EXIF")
        }
        var colorSpace = 1
        if let profile = properties[kCGImagePropertyProfileName as String] as? String,
           !profile.localizedCaseInsensitiveContains("srgb")
        {
            colorSpace = 65535 // uncalibrated: the ICC says what the pixels are
            warnings.append("\(inURL.path) carries the ICC profile '\(profile)'; EXIF ColorSpace is 65535 (uncalibrated)")
        }
        let tagged = try capture.map {
            try JPEGExport.rewritingMetadata(bare, properties: JPEGExport.exifProperties(
                capture: $0, pixelWidth: width, pixelHeight: height, colorSpace: colorSpace
            ))
        } ?? bare
        let output = try JPEGExport.keepingTheRule(tagged, capture: capture, path: outURL.path)
        guard let image = JPEGSegments.imageData(output), image == JPEGSegments.imageData(input) else {
            throw ToolError.writeFailed("\(outURL.path) not written: the image data would change (retag-jpeg never re-encodes)")
        }
        try FileWriting.write(output, to: outURL)
        let finished = ContinuousClock.now

        for warning in warnings {
            FileHandle.standardError.write(Data("warning: \(warning)\n".utf8))
        }
        return [
            "ok": true,
            "out": outURL.path,
            "width": width,
            "height": height,
            "bytes": FileWriting.fileSize(outURL).map { $0 as Any } ?? NSNull(),
            "metadata": capture != nil,
            "totalMs": JSONOutput.number(milliseconds(from: started, to: finished)),
            "peakRSSBytes": RuntimeEnvironment.peakResidentBytes().map { $0 as Any } ?? NSNull(),
            "warnings": warnings.count,
        ]
    }
}
