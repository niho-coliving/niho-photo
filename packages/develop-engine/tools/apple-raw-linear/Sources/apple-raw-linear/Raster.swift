import CoreGraphics
import CoreImage
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The raster working copy (`raster`, 0.4.3, K5-c1 #17153): a HEIC / HEIF,
/// TIFF, PNG or JPEG original as an 8-bit JPEG that stage 2 reads on the same
/// path as a JPEG original (embedded ICC → linear, the non-RAW exposure).
///
/// - The primary image (`CGImageSourceGetPrimaryImageIndex`), SDR only (no
///   gain map; on macOS 15 and later an HDR primary is read as SDR with
///   `kCGImageSourceDecodeToSDR`), its EXIF / HEIF orientation applied (the
///   pixels are upright).
/// - Color: an RGB source whose ICC stage 2 reads (`ICCProfile`: matrix /
///   TRC, no nearly linear TRC) keeps its color space and the JPEG carries
///   the same ICC; sRGB (tagged or not) and RGB without an ICC are written as
///   sRGB without an ICC; every other RGB source (LUT-only or linear ICC,
///   ITU-R 2100 PQ / HLG, extended range, an HDR original) is converted to
///   Display P3 with its ICC; gray, CMYK, Lab and indexed sources are
///   converted to sRGB (no ICC).
/// - Downscaled to the long edge in linear light (Core Image's working space
///   is extended linear sRGB; `CILanczosScaleTransform`), never enlarged.
/// - Metadata: the ICC only (no EXIF, GPS, TIFF, IPTC, XMP, maker notes or
///   thumbnail); the same input and arguments give the same bytes.
/// - The preview: long edge 1024, sRGB, no metadata, at most 1 MiB.
enum RasterWorkingCopy {
    static let defaultLongEdge = 2560
    static let defaultQuality = 0.94
    static let encoding = "jpeg8"

    static let previewLongEdge = 1024
    static let previewMaxBytes = 1 << 20
    /// Tried in order until the preview fits in `previewMaxBytes`.
    static let previewQualities: [Double] = [0.85, 0.72, 0.6, 0.45]

    /// `(width, height)` with the long edge at most `longEdge` (never
    /// enlarged); the other edge rounded, at least 1.
    static func targetSize(width: Int, height: Int, longEdge: Int) -> (width: Int, height: Int) {
        let long = max(width, height)
        guard long > longEdge, long > 0 else { return (width, height) }
        let scale = Double(longEdge) / Double(long)
        func scaled(_ edge: Int) -> Int { max(1, Int((Double(edge) * scale).rounded())) }
        return width >= height ? (longEdge, scaled(height)) : (scaled(width), longEdge)
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The first quality whose encoding fits in `maxBytes`, else `encode_failed`.
    static func fitting(
        qualities: [Double],
        maxBytes: Int,
        _ encode: (Double) throws -> Data
    ) throws -> (data: Data, quality: Double) {
        var smallest: Int?
        for quality in qualities {
            let data = try encode(quality)
            if data.count <= maxBytes {
                return (data, quality)
            }
            smallest = min(smallest ?? data.count, data.count)
        }
        throw ToolError.encodeFailed(
            "the preview does not fit in \(maxBytes) bytes at quality \(qualities.map { "\($0)" }.joined(separator: ", "))"
                + (smallest.map { " (smallest \($0) bytes)" } ?? "")
        )
    }
}

// MARK: - JPEG segments

/// JPEG marker segments across the whole image, including markers between
/// progressive scans. Entropy-coded scan bytes are not segments.
enum JPEGSegments {
    struct Segment {
        let marker: UInt8
        /// The whole marker segment (or the marker bytes for a stand-alone marker).
        let range: Range<Int>
        /// The payload (after the 2-byte length).
        let payload: Range<Int>
    }

    static let iccSignature = Array("ICC_PROFILE".utf8) + [0]
    static let jfifSignature = Array("JFIF".utf8) + [0]
    static let adobeSignature = Array("Adobe".utf8)
    static let exifSignature = Array("Exif".utf8) + [0, 0]

    /// Every marker segment through EOI and the offset of the first SOS.
    /// APPn / COM markers between scans are included so metadata checks and
    /// stripping cover the complete JPEG rather than only its first header.
    static func parse(_ bytes: [UInt8]) throws -> (segments: [Segment], scanStart: Int) {
        guard bytes.count >= 4, bytes[0] == 0xFF, bytes[1] == 0xD8 else {
            throw ToolError.encodeFailed("the encoded data is not a JPEG (no SOI)")
        }
        var segments: [Segment] = []
        var index = 2
        var scanStart: Int?
        var inScan = false
        var resumeScanAfterStandaloneMarker = false

        while index < bytes.count {
            if inScan {
                var foundMarker = false
                while index < bytes.count {
                    guard bytes[index] == 0xFF else {
                        index += 1
                        continue
                    }
                    let markerStart = index
                    var markerIndex = index + 1
                    while markerIndex < bytes.count, bytes[markerIndex] == 0xFF {
                        markerIndex += 1 // fill bytes
                    }
                    guard markerIndex < bytes.count else {
                        throw ToolError.encodeFailed("malformed JPEG: truncated scan marker")
                    }
                    let marker = bytes[markerIndex]
                    if marker == 0x00 || (0xD0 ... 0xD7).contains(marker) {
                        // A stuffed FF byte and restart markers belong to the
                        // entropy-coded data, not the marker stream.
                        index = markerIndex + 1
                        continue
                    }
                    index = markerStart
                    inScan = false
                    resumeScanAfterStandaloneMarker = true
                    foundMarker = true
                    break
                }
                guard foundMarker else {
                    throw ToolError.encodeFailed("malformed JPEG: ends before EOI")
                }
                continue
            }

            guard index < bytes.count, bytes[index] == 0xFF else {
                throw ToolError.encodeFailed("malformed JPEG: no marker at offset \(index)")
            }
            let markerStart = index
            var markerIndex = index + 1
            while markerIndex < bytes.count, bytes[markerIndex] == 0xFF {
                markerIndex += 1 // fill bytes
            }
            guard markerIndex < bytes.count else {
                throw ToolError.encodeFailed("malformed JPEG: truncated marker")
            }
            let marker = bytes[markerIndex]
            if marker == 0xD9 {
                let end = markerIndex + 1
                guard end == bytes.count else {
                    throw ToolError.encodeFailed("malformed JPEG: data after EOI")
                }
                segments.append(Segment(marker: marker, range: markerStart ..< end, payload: end ..< end))
                guard let scanStart else {
                    throw ToolError.encodeFailed("malformed JPEG: ends before the first scan")
                }
                return (segments, scanStart)
            }
            guard marker != 0xD8, !(0xD0 ... 0xD7).contains(marker) else {
                throw ToolError.encodeFailed(String(format: "malformed JPEG: unexpected stand-alone marker %02X", marker))
            }
            if marker == 0x01 {
                let end = markerIndex + 1
                segments.append(Segment(marker: marker, range: markerStart ..< end, payload: end ..< end))
                index = end
                inScan = resumeScanAfterStandaloneMarker
                resumeScanAfterStandaloneMarker = false
                continue
            }
            guard markerIndex + 2 < bytes.count else {
                throw ToolError.encodeFailed("malformed JPEG: truncated segment length")
            }
            let length = Int(bytes[markerIndex + 1]) << 8 | Int(bytes[markerIndex + 2])
            let end = markerIndex + 1 + length
            guard length >= 2, end <= bytes.count else {
                throw ToolError.encodeFailed("malformed JPEG: segment length \(length) at offset \(index)")
            }
            segments.append(Segment(
                marker: marker,
                range: markerStart ..< end,
                payload: (markerIndex + 3) ..< end
            ))
            index = end
            if marker == 0xDA {
                if scanStart == nil { scanStart = markerStart }
                inScan = true
                resumeScanAfterStandaloneMarker = false
            } else if marker == 0xDC {
                // DNL is allowed within an entropy-coded scan and does not
                // begin a new scan.
                inScan = true
                resumeScanAfterStandaloneMarker = false
            } else {
                resumeScanAfterStandaloneMarker = false
            }
        }
        throw ToolError.encodeFailed("malformed JPEG: ends before EOI")
    }

    static func payload(_ bytes: [UInt8], _ segment: Segment, startsWith signature: [UInt8]) -> Bool {
        segment.payload.count >= signature.count
            && bytes[segment.payload.lowerBound ..< segment.payload.lowerBound + signature.count].elementsEqual(signature)
    }

    /// Kept before the scan: JFIF APP0, ICC APP2 (when `keepICC`), Exif APP1
    /// (when `keepExif`; `encode-jpeg` / `retag-jpeg`), Adobe APP14 and every
    /// non-APP / non-COM segment (tables, frame header, restart interval).
    /// Dropped: every other APPn (Exif / XMP APP1, IPTC APP13, ...) and
    /// comments, including segments between progressive scans.
    static func strippingMetadata(_ data: Data, keepICC: Bool, keepExif: Bool = false) throws -> Data {
        let bytes = [UInt8](data)
        let (segments, _) = try parse(bytes)
        var output = Data()
        output.reserveCapacity(bytes.count)
        var copiedThrough = 0
        for segment in segments where isMetadata(segment.marker)
            && !keeps(segment, in: bytes, keepICC: keepICC, keepExif: keepExif)
        {
            output.append(contentsOf: bytes[copiedThrough ..< segment.range.lowerBound])
            copiedThrough = segment.range.upperBound
        }
        output.append(contentsOf: bytes[copiedThrough...])
        return output
    }

    static func isMetadata(_ marker: UInt8) -> Bool {
        (0xE0 ... 0xEF).contains(marker) || marker == 0xFE
    }

    private static func keeps(_ segment: Segment, in bytes: [UInt8], keepICC: Bool, keepExif: Bool) -> Bool {
        switch segment.marker {
        case 0xE0: payload(bytes, segment, startsWith: jfifSignature)
        case 0xE1: keepExif && payload(bytes, segment, startsWith: exifSignature)
        case 0xE2: keepICC && payload(bytes, segment, startsWith: iccSignature)
        case 0xEE: payload(bytes, segment, startsWith: adobeSignature)
        case 0xE3 ... 0xED, 0xEF, 0xFE: false
        default: true
        }
    }

    /// The ICC profile of the APP2 `ICC_PROFILE` chunks, in sequence order;
    /// nil without one (or when the chunks are inconsistent).
    static func iccProfile(in data: Data) -> Data? {
        let bytes = [UInt8](data)
        guard let (segments, _) = try? parse(bytes) else { return nil }
        var chunks: [Int: Data] = [:]
        var count: Int?
        for segment in segments where segment.marker == 0xE2 && payload(bytes, segment, startsWith: iccSignature) {
            let header = segment.payload.lowerBound + iccSignature.count
            guard header + 2 <= segment.payload.upperBound else { return nil }
            let sequence = Int(bytes[header])
            let total = Int(bytes[header + 1])
            guard count == nil || count == total, chunks[sequence] == nil else { return nil }
            count = total
            chunks[sequence] = Data(bytes[(header + 2) ..< segment.payload.upperBound])
        }
        guard let count, count > 0, chunks.count == count else { return nil }
        var profile = Data()
        for sequence in 1 ... count {
            guard let chunk = chunks[sequence] else { return nil }
            profile.append(chunk)
        }
        return profile
    }

    /// The parsed markers (tests and diagnostics).
    static func markers(in data: Data) -> [UInt8] {
        (try? parse([UInt8](data)))?.segments.map(\.marker) ?? []
    }
}

// MARK: - raster

enum RasterCommand {
    static let maxDecodePixels: UInt64 = 40_000_000
    /// `--long-edge full` keeps every pixel, so a 48MP+ photo is ordinary input
    /// and the decode cap is wider. It is still a cap (a decompression-bomb PNG
    /// must not allocate without bound): above it the command fails with
    /// `decode_failed` and never shrinks silently.
    static let maxFullSizeDecodePixels: UInt64 = 200_000_000
    static let maxJPEGDimension = Int(UInt16.max)

    /// The total-pixel cap for the requested long edge.
    static func decodePixelLimit(for longEdge: LongEdge) -> UInt64 {
        switch longEdge {
        case .full: maxFullSizeDecodePixels
        case .pixels: maxDecodePixels
        }
    }

    static func exceedsJPEGDimensionLimit(width: Int, height: Int) -> Bool {
        width > maxJPEGDimension || height > maxJPEGDimension
    }

    /// ImageIO properties are available without materializing the image. Keep
    /// this check separate from `decode` so the overflow/limit contract is
    /// testable without allocating a large image.
    static func exceedsDecodePixelLimit(width: UInt64, height: UInt64, limit: UInt64 = maxDecodePixels) -> Bool {
        let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
        return overflow || pixels > limit
    }

    static func exceedsDecodePixelLimit(_ properties: [String: Any], limit: UInt64 = maxDecodePixels) -> Bool {
        guard let width = (properties[kCGImagePropertyPixelWidth as String] as? NSNumber)?.uint64Value,
              let height = (properties[kCGImagePropertyPixelHeight as String] as? NSNumber)?.uint64Value
        else {
            return false
        }
        return exceedsDecodePixelLimit(width: width, height: height, limit: limit)
    }

    /// The written pixels' color space and the ICC the JPEG carries.
    struct OutputColor {
        let space: CGColorSpace
        /// nil = no ICC (sRGB).
        let icc: Data?
        /// `displayP3` / `srgb`: what the source was converted to; nil when
        /// its own color is kept (its ICC as it is, or sRGB / RGB without an
        /// ICC written as sRGB).
        let converted: String?
        /// Why the source was converted to Display P3 (a stderr note).
        let reason: String?

        static let displayP3Name = "displayP3"
        static let sRGBName = "srgb"
    }

    struct Source {
        /// Upright (orientation applied), extent origin (0, 0).
        let image: CIImage
        let width: Int
        let height: Int
        /// The stored pixel size (before orientation), ImageIO's PixelWidth / PixelHeight.
        let sourceWidth: Int
        let sourceHeight: Int
        let orientation: CGImagePropertyOrientation
        let color: OutputColor
        /// The ICC description ImageIO reports (`ProfileName`), if any.
        let profileName: String?
    }

    static var sRGB: CGColorSpace {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else {
            preconditionFailure("sRGB is unavailable")
        }
        return space
    }

    static var displayP3: CGColorSpace {
        guard let space = CGColorSpace(name: CGColorSpace.displayP3) else {
            preconditionFailure("Display P3 is unavailable")
        }
        return space
    }

    /// Display P3 with its ICC (`copyICCData`), for the sources whose own
    /// color stage 2 cannot read or would band in 8 bits.
    static func convertedToDisplayP3(_ reason: String) throws -> OutputColor {
        guard let icc = displayP3.copyICCData() as Data?, !icc.isEmpty else {
            throw ToolError.unsupportedProfile("the Display P3 ICC profile is unavailable")
        }
        return OutputColor(space: displayP3, icc: icc, converted: OutputColor.displayP3Name, reason: reason)
    }

    static func run(_ options: RasterOptions) throws -> [String: Any] {
        let inputURL = try InputFile.existing(options.input)
        let outURL = URL(fileURLWithPath: options.out).standardizedFileURL
        let previewURL = options.previewOut.map { URL(fileURLWithPath: $0).standardizedFileURL }
        let metaURL = options.meta.map { URL(fileURLWithPath: $0).standardizedFileURL }
        let outputPaths = [outURL.path] + [previewURL, metaURL].compactMap { $0?.path }
        guard Set(outputPaths).count == outputPaths.count else {
            throw ToolError.invalidArguments("--out, --preview-out and --meta must be different files")
        }
        guard !outputPaths.contains(inputURL.path) else {
            throw ToolError.invalidArguments("--out / --preview-out / --meta must not overwrite the input")
        }

        let source = try decode(inputURL, maxPixels: decodePixelLimit(for: options.longEdge))
        let context = CIContext(options: [
            .workingColorSpace: RawRenderer.workingColorSpace,
            .workingFormat: NSNumber(value: CIFormat.RGBAf.rawValue),
            .cacheIntermediates: false,
            .name: "apple-raw-linear raster",
        ])
        var warnings: [String] = []

        // The working copy.
        let requestedLongEdge: Int
        switch options.longEdge {
        case let .pixels(pixels): requestedLongEdge = pixels
        case .full: requestedLongEdge = max(source.width, source.height)
        }
        let size = RasterWorkingCopy.targetSize(width: source.width, height: source.height, longEdge: requestedLongEdge)
        guard !exceedsJPEGDimensionLimit(width: size.width, height: size.height) else {
            throw ToolError.unsupportedDimensions(
                "the raster is larger than JPEG's \(maxJPEGDimension)-pixel edge limit"
            )
        }
        let outputSpace = source.color.space
        let expectedICC = source.color.icc
        let working = try render8(
            context: context,
            image: resized(source.image, from: (source.width, source.height), to: size),
            width: size.width,
            height: size.height,
            colorSpace: outputSpace
        )
        let workingData = try JPEGSegments.strippingMetadata(
            try encodeJPEG(working, quality: options.quality),
            keepICC: expectedICC != nil
        )
        let embeddedICC = JPEGSegments.iccProfile(in: workingData)
        let iccSha256: String?
        if let expectedICC {
            guard let embeddedICC else {
                throw ToolError.encodeFailed("ImageIO did not embed the source's ICC profile in the JPEG")
            }
            if embeddedICC != expectedICC {
                warnings.append("the embedded ICC profile differs from the source color space's ICC data")
            }
            iccSha256 = RasterWorkingCopy.sha256Hex(embeddedICC)
        } else {
            guard embeddedICC == nil else {
                throw ToolError.encodeFailed("the sRGB working copy carries an ICC profile")
            }
            iccSha256 = nil
        }

        // The preview (sRGB, no metadata, at most 1 MiB).
        var previewJSON: Any = NSNull()
        var previewData: Data?
        if previewURL != nil {
            let previewSize = RasterWorkingCopy.targetSize(
                width: source.width,
                height: source.height,
                longEdge: RasterWorkingCopy.previewLongEdge
            )
            let preview = try render8(
                context: context,
                image: resized(source.image, from: (source.width, source.height), to: previewSize),
                width: previewSize.width,
                height: previewSize.height,
                colorSpace: sRGB
            )
            let fitted = try RasterWorkingCopy.fitting(
                qualities: RasterWorkingCopy.previewQualities,
                maxBytes: RasterWorkingCopy.previewMaxBytes
            ) { quality in
                try JPEGSegments.strippingMetadata(try encodeJPEG(preview, quality: quality), keepICC: false)
            }
            previewData = fitted.data
            previewJSON = [
                "width": previewSize.width,
                "height": previewSize.height,
                "bytes": fitted.data.count,
            ]
        }

        // The written pixels' color space: its name, else the ICC description.
        let colorSpace: String? = source.color.icc == nil
            ? CGColorSpace.sRGB as String
            : (outputSpace.name as String?) ?? (source.color.converted == nil ? source.profileName : nil)
        let json: [String: Any] = [
            "kind": "raster",
            "encoding": RasterWorkingCopy.encoding,
            "width": size.width,
            "height": size.height,
            "iccSha256": JSONOutput.optional(iccSha256),
            "colorSpace": JSONOutput.optional(colorSpace),
            "converted": JSONOutput.optional(source.color.converted),
            "sourceWidth": source.sourceWidth,
            "sourceHeight": source.sourceHeight,
            "orientationApplied": source.orientation != .up,
            "bytes": workingData.count,
            "preview": previewJSON,
            "tool": Tool.metadata,
        ]

        // Everything is encoded before the first file appears; a later
        // failure removes what this run wrote.
        var written: [URL] = []
        do {
            try FileWriting.write(workingData, to: outURL)
            written.append(outURL)
            if let previewURL, let previewData {
                try FileWriting.write(previewData, to: previewURL)
                written.append(previewURL)
            }
            if let metaURL {
                try FileWriting.write(try JSONOutput.pretty(json), to: metaURL)
            }
        } catch {
            for url in written {
                try? FileManager.default.removeItem(at: url)
            }
            throw error
        }
        if let reason = source.color.reason {
            FileHandle.standardError.write(Data("note: converted to Display P3: \(reason)\n".utf8))
        }
        for warning in warnings {
            FileHandle.standardError.write(Data("warning: \(warning)\n".utf8))
        }
        return json
    }

    // MARK: steps

    /// The color decision for a decoded color space. `retagAsSRGB`: RGB
    /// without an ICC (device RGB), whose pixels are taken as sRGB.
    /// `fileIsHDR`: the file's own color space is ITU-R 2100 (ImageIO read
    /// it as SDR); its SDR rendition is written as Display P3.
    static func outputColor(for space: CGColorSpace, fileIsHDR: Bool) throws -> (color: OutputColor, retagAsSRGB: Bool) {
        let plainSRGB = OutputColor(space: sRGB, icc: nil, converted: nil, reason: nil)
        switch space.model {
        case .rgb:
            if fileIsHDR {
                return (try convertedToDisplayP3("an HDR (ITU-R 2100) original, read as SDR"), false)
            }
            if CGColorSpaceUsesITUR_2100TF(space) {
                return (try convertedToDisplayP3("an ITU-R 2100 (PQ / HLG) color space"), false)
            }
            if CGColorSpaceUsesExtendedRange(space) {
                return (try convertedToDisplayP3("an extended-range color space"), false)
            }
            if space.name == CGColorSpace.sRGB {
                return (plainSRGB, false)
            }
            guard let icc = space.copyICCData() as Data?, !icc.isEmpty else {
                return (plainSRGB, true)
            }
            switch ICCProfile.stage2Verdict(icc) {
            case .readable where space.supportsOutput:
                return (OutputColor(space: space, icc: icc, converted: nil, reason: nil), false)
            case .readable:
                return (try convertedToDisplayP3("the color space cannot be written"), false)
            case let .unreadable(reason):
                return (try convertedToDisplayP3(reason), false)
            }
        case .monochrome, .cmyk, .lab, .indexed:
            // Core Image converts them on input (ColorSync), like a CoreGraphics draw.
            return (OutputColor(space: sRGB, icc: nil, converted: OutputColor.sRGBName, reason: nil), false)
        default:
            throw ToolError.unsupportedProfile("the color model \(space.model.rawValue) cannot be converted to sRGB")
        }
    }

    /// The primary image through ImageIO, oriented, with its color decision.
    /// `requestSDR` false reads as before macOS 15 (tests).
    static func decode(_ url: URL, requestSDR: Bool = true, maxPixels: UInt64 = maxDecodePixels) throws -> Source {
        guard let imageSource = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(imageSource) > 0
        else {
            throw ToolError.decodeFailed("ImageIO cannot read \(url.path) as an image")
        }
        let index = CGImageSourceGetPrimaryImageIndex(imageSource)
        let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, index, nil) as? [String: Any] ?? [:]
        if exceedsDecodePixelLimit(properties, limit: maxPixels) {
            throw ToolError.decodeFailed(
                "\(url.path) exceeds the \(maxPixels)-pixel decode limit"
            )
        }
        // The SDR primary image: a gain map is never applied, and on macOS 15
        // and later an HDR (PQ / HLG) primary is read as SDR. The file's own
        // color space comes from a lazy image (no pixels decoded).
        var decodeOptions: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        var fileIsHDR = false
        if #available(macOS 15, *), requestSDR {
            if let space = CGImageSourceCreateImageAtIndex(imageSource, index, nil)?.colorSpace {
                fileIsHDR = CGColorSpaceUsesITUR_2100TF(space)
            }
            decodeOptions[kCGImageSourceDecodeRequest] = kCGImageSourceDecodeToSDR
        }
        guard let decoded = CGImageSourceCreateImageAtIndex(
            imageSource,
            index,
            decodeOptions as CFDictionary
        ) else {
            throw ToolError.decodeFailed("ImageIO cannot decode image \(index) of \(url.path)")
        }
        guard decoded.width > 0, decoded.height > 0 else {
            throw ToolError.decodeFailed("\(url.path) has no pixels")
        }
        let materialized = try materialize(decoded, url: url)
        let orientation = (properties[kCGImagePropertyOrientation as String] as? NSNumber)
            .flatMap { CGImagePropertyOrientation(rawValue: $0.uint32Value) } ?? .up
        let profileName = properties[kCGImagePropertyProfileName as String] as? String

        guard let space = materialized.colorSpace else {
            throw ToolError.unsupportedProfile("\(url.path) has no color space")
        }
        var image = materialized
        let color: OutputColor
        do {
            let decision = try outputColor(for: space, fileIsHDR: fileIsHDR)
            color = decision.color
            if decision.retagAsSRGB {
                guard let tagged = materialized.copy(colorSpace: sRGB) else {
                    throw ToolError.unsupportedProfile("cannot treat the RGB pixels as sRGB")
                }
                image = tagged
            }
        } catch let error as ToolError {
            throw ToolError(code: error.code, message: "\(url.path): \(error.message)", exitCode: error.exitCode)
        }

        var oriented = CIImage(cgImage: image).oriented(orientation)
        let extent = oriented.extent
        if extent.origin != .zero {
            oriented = oriented.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
        }
        guard let width = RawInspector.pixelDimension(extent.width),
              let height = RawInspector.pixelDimension(extent.height)
        else {
            throw ToolError.decodeFailed("\(url.path) has no pixel extent (\(extent))")
        }
        return Source(
            image: oriented,
            width: width,
            height: height,
            sourceWidth: decoded.width,
            sourceHeight: decoded.height,
            orientation: orientation,
            color: color,
            profileName: profileName
        )
    }

    /// ImageIO's decoded bytes in a plain CGImage. Given a HEIC's CGImage
    /// directly, Core Image may read the hardware decoder's surface and
    /// convert it itself, and that gave different pixels from run to run
    /// under load (2 of 11 concurrent runs, macOS 27.0); ImageIO's own bytes
    /// are the same every run.
    static func materialize(_ image: CGImage, url: URL) throws -> CGImage {
        guard let data = image.dataProvider?.data,
              let provider = CGDataProvider(data: data),
              let copy = CGImage(
                  width: image.width,
                  height: image.height,
                  bitsPerComponent: image.bitsPerComponent,
                  bitsPerPixel: image.bitsPerPixel,
                  bytesPerRow: image.bytesPerRow,
                  space: image.colorSpace ?? sRGB,
                  bitmapInfo: image.bitmapInfo,
                  provider: provider,
                  decode: image.decode,
                  shouldInterpolate: false,
                  intent: image.renderingIntent
              )
        else {
            throw ToolError.decodeFailed("cannot read the decoded pixels of \(url.path)")
        }
        return copy
    }

    /// Lanczos in Core Image's working space (extended linear sRGB, so the
    /// light is averaged linearly), the edges clamped so no transparent
    /// border bleeds in; the identity when the size does not change.
    static func resized(_ image: CIImage, from size: (Int, Int), to target: (width: Int, height: Int)) -> CIImage {
        guard target.width != size.0 || target.height != size.1 else { return image }
        let scaleX = Double(target.width) / Double(size.0)
        let scaleY = Double(target.height) / Double(size.1)
        return image.clampedToExtent()
            .applyingFilter("CILanczosScaleTransform", parameters: [
                kCIInputScaleKey: scaleY,
                kCIInputAspectRatioKey: scaleX / scaleY,
            ])
            .cropped(to: CGRect(x: 0, y: 0, width: target.width, height: target.height))
    }

    /// 8-bit RGB in `colorSpace` (alpha dropped; premultiplied, i.e. over black).
    static func render8(
        context: CIContext,
        image: CIImage,
        width: Int,
        height: Int,
        colorSpace: CGColorSpace
    ) throws -> CGImage {
        let rowBytes = width * 4
        var pixels = Data(count: rowBytes * height)
        pixels.withUnsafeMutableBytes { buffer in
            context.render(
                image,
                toBitmap: buffer.baseAddress!,
                rowBytes: rowBytes,
                bounds: CGRect(x: 0, y: 0, width: width, height: height),
                format: .RGBA8,
                colorSpace: colorSpace
            )
        }
        guard let provider = CGDataProvider(data: pixels as CFData),
              let image = CGImage(
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bitsPerPixel: 32,
                  bytesPerRow: rowBytes,
                  space: colorSpace,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: false,
                  intent: .defaultIntent
              )
        else {
            throw ToolError.encodeFailed("cannot make a \(width)x\(height) 8-bit image")
        }
        return image
    }

    /// ImageIO's JPEG (its own APP1 / APP13 are stripped afterwards).
    static func encodeJPEG(_ image: CGImage, quality: Double) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw ToolError.encodeFailed("ImageIO cannot create a JPEG")
        }
        let properties: [String: Any] = [
            kCGImageDestinationLossyCompressionQuality as String: min(max(quality, 0), 1),
            kCGImageDestinationEmbedThumbnail as String: false,
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ToolError.encodeFailed("ImageIO failed to encode the JPEG")
        }
        return data as Data
    }
}
