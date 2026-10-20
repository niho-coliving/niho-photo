import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import apple_raw_linear

/// `encode-jpeg` and `retag-jpeg` (W2b-1 #17145): the export carries the
/// capture time only (Epic #17114 Decision 10, F7a #17143's rule), the
/// pixels of `encode-jpeg` are written as they are and `retag-jpeg` never
/// re-encodes.
final class JPEGExportTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-raw-linear-jpeg-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: fixtures

    private let tiffKey = kCGImagePropertyTIFFDictionary as String
    private let exifKey = kCGImagePropertyExifDictionary as String
    private let gpsKey = kCGImagePropertyGPSDictionary as String
    private let exifAuxKey = kCGImagePropertyExifAuxDictionary as String
    private let iptcKey = kCGImagePropertyIPTCDictionary as String
    private let dateKey = kCGImagePropertyExifDateTimeOriginal as String
    private let offsetKey = kCGImagePropertyExifOffsetTimeOriginal as String
    private let subsecKey = kCGImagePropertyExifSubsecTimeOriginal as String

    private let capture = JPEGExport.CaptureTime(
        dateTimeOriginal: "2026:09:20 10:11:12", offsetTimeOriginal: "+09:00", subsecTimeOriginal: "123"
    )

    /// A smooth RGB gradient (8-bit), untagged (device RGB) unless `space` is given.
    private func gradient(width: Int, height: Int, space: CGColorSpace? = nil) throws -> (CGImage, [UInt8]) {
        var rgb = [UInt8](repeating: 0, count: width * height * 3)
        var rgbx = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0 ..< height {
            for x in 0 ..< width {
                let values = [
                    UInt8(20 + 200 * x / max(width - 1, 1)),
                    UInt8(40 + 150 * y / max(height - 1, 1)),
                    UInt8(160 - 100 * (x + y) / max(width + height - 2, 1)),
                ]
                for c in 0 ..< 3 {
                    rgb[(y * width + x) * 3 + c] = values[c]
                    rgbx[(y * width + x) * 4 + c] = values[c]
                }
            }
        }
        let colorSpace = space ?? CGColorSpaceCreateDeviceRGB()
        let image = try rgbx.withUnsafeMutableBytes { bytes -> CGImage in
            let context = try XCTUnwrap(CGContext(
                data: bytes.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ))
            return try XCTUnwrap(context.makeImage())
        }
        return (image, rgb)
    }

    private func write(_ image: CGImage, type: UTType, name: String, properties: [String: Any] = [:]) throws -> URL {
        let url = directory.appendingPathComponent(name)
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url
    }

    /// Everything the rule drops, as a camera or Photo Bench's export
    /// (0.4.1's `encode-jpeg`) writes it: the capture time with its offset
    /// and sub-second, the lens and body, GPS, TIFF camera keys, IPTC (ImageIO
    /// also writes it as XMP) and an embedded thumbnail.
    private func cameraProperties(orientation: Int, withCaptureTime: Bool = true) -> [String: Any] {
        var exif: [String: Any] = [
            kCGImagePropertyExifISOSpeedRatings as String: [400],
            kCGImagePropertyExifLensModel as String: "LUMIX S 20-60/F3.5-5.6",
            kCGImagePropertyExifFNumber as String: 5.6,
            kCGImagePropertyExifBodySerialNumber as String: "SN123",
            kCGImagePropertyExifPixelXDimension as String: 6000,
            kCGImagePropertyExifPixelYDimension as String: 4000,
        ]
        if withCaptureTime {
            exif[dateKey] = "2026:09:20 10:11:12"
            exif[offsetKey] = "+09:00"
            exif[subsecKey] = "123"
        }
        return [
            kCGImagePropertyOrientation as String: orientation,
            kCGImageDestinationEmbedThumbnail as String: true,
            tiffKey: [
                kCGImagePropertyTIFFMake as String: "Panasonic",
                kCGImagePropertyTIFFModel as String: "DC-S5",
                kCGImagePropertyTIFFDateTime as String: "2026:09:20 10:11:12",
                kCGImagePropertyTIFFArtist as String: "NIHO",
                kCGImagePropertyTIFFSoftware as String: "Ver.2.0",
                kCGImagePropertyTIFFCopyright as String: "(c) NIHO",
                kCGImagePropertyTIFFImageDescription as String: "private note",
                kCGImagePropertyTIFFHostComputer as String: "studio-mac",
                kCGImagePropertyTIFFOrientation as String: orientation,
            ],
            exifKey: exif,
            exifAuxKey: [
                kCGImagePropertyExifAuxSerialNumber as String: "XYZ",
                kCGImagePropertyExifAuxLensModel as String: "LUMIX S 20-60",
            ],
            gpsKey: [
                kCGImagePropertyGPSLatitude as String: 35.3192,
                kCGImagePropertyGPSLatitudeRef as String: "N",
                kCGImagePropertyGPSLongitude as String: 139.5467,
                kCGImagePropertyGPSLongitudeRef as String: "E",
            ],
            iptcKey: [
                kCGImagePropertyIPTCKeywords as String: ["kamakura"],
                kCGImagePropertyIPTCCaptionAbstract as String: "caption",
            ],
        ]
    }

    /// `encode-jpeg`'s original: a camera JPEG with orientation 6.
    private func original(name: String = "original.jpg", withCaptureTime: Bool = true) throws -> URL {
        let (image, _) = try gradient(width: 64, height: 48)
        let url = try write(image, type: .jpeg, name: name, properties: cameraProperties(orientation: 6, withCaptureTime: withCaptureTime))
        // The fixture must carry what the rule drops, or the test proves nothing.
        let read = try properties(url)
        XCTAssertNotNil(read[iptcKey])
        XCTAssertNotNil(read[gpsKey])
        XCTAssertNotNil(read[exifAuxKey])
        XCTAssertEqual((read[tiffKey] as? [String: Any])?[kCGImagePropertyTIFFMake as String] as? String, "Panasonic")
        XCTAssertEqual((read[exifKey] as? [String: Any])?[dateKey] as? String, withCaptureTime ? "2026:09:20 10:11:12" : nil)
        return url
    }

    /// `retag-jpeg`'s input: Photo Bench's upright export with everything the
    /// rule drops, plus a comment segment.
    private func photoBenchExport(
        name: String = "photobench.jpg",
        withCaptureTime: Bool = true,
        orientation: Int = 1
    ) throws -> URL {
        let (image, _) = try gradient(width: 160, height: 107, space: CGColorSpace(name: CGColorSpace.sRGB))
        var camera = cameraProperties(orientation: orientation, withCaptureTime: withCaptureTime)
        camera[kCGImageDestinationLossyCompressionQuality as String] = 0.92
        let url = try write(image, type: .jpeg, name: name, properties: camera)
        let encoded = try Data(contentsOf: url)
        let (segments, _) = try JPEGSegments.parse([UInt8](encoded))
        let afterFirst = try XCTUnwrap(segments.first).range.upperBound
        var withComment = Data(encoded.prefix(afterFirst))
        withComment.append(contentsOf: segment(0xFE, Array("private note".utf8)))
        withComment.append(encoded.dropFirst(afterFirst))
        try withComment.write(to: url)

        let data = try Data(contentsOf: url)
        let markers = JPEGSegments.markers(in: data)
        XCTAssertTrue(markers.contains(0xFE), "comment")
        XCTAssertTrue(markers.contains(0xED), "IPTC (APP13)")
        XCTAssertTrue(segmentKinds(data).contains("XMP"))
        XCTAssertEqual(thumbnail(in: data), true, "an EXIF thumbnail (IFD1)")
        let read = try properties(url)
        XCTAssertNotNil(read[gpsKey])
        XCTAssertNotNil(read[exifAuxKey])
        return url
    }

    private func segment(_ marker: UInt8, _ payload: [UInt8]) -> [UInt8] {
        let length = payload.count + 2
        return [0xFF, marker, UInt8(length >> 8), UInt8(length & 0xFF)] + payload
    }

    private func properties(_ url: URL) throws -> [String: Any] {
        try properties(Data(contentsOf: url))
    }

    private func properties(_ data: Data) throws -> [String: Any] {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
    }

    /// "JFIF", "EXIF", "XMP", "ICC", "APPn", "COM" or "Mxx" per segment before the scan.
    private func segmentKinds(_ data: Data) -> [String] {
        let bytes = [UInt8](data)
        guard let (segments, _) = try? JPEGSegments.parse(bytes) else { return ["unparsable"] }
        return segments.map { segment in
            switch segment.marker {
            case 0xE0 where JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.jfifSignature): "JFIF"
            case 0xE1 where JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.exifSignature): "EXIF"
            case 0xE1 where JPEGSegments.payload(bytes, segment, startsWith: JPEGExport.xmpSignature): "XMP"
            case 0xE2 where JPEGSegments.payload(bytes, segment, startsWith: JPEGSegments.iccSignature): "ICC"
            case 0xE0 ... 0xEF: "APP\(Int(segment.marker) - 0xE0)"
            case 0xFE: "COM"
            default: String(format: "M%02X", segment.marker)
            }
        }
    }

    /// Whether the EXIF links a thumbnail (IFD1); nil without EXIF.
    private func thumbnail(in data: Data) -> Bool? {
        let bytes = [UInt8](data)
        guard let (segments, _) = try? JPEGSegments.parse(bytes),
              let exif = segments.first(where: {
                  $0.marker == 0xE1 && JPEGSegments.payload(bytes, $0, startsWith: JPEGSegments.exifSignature)
              })
        else { return nil }
        return JPEGExport.linksSecondIFD(bytes, exif)
    }

    private func scan(_ data: Data) throws -> Data {
        let (_, scanStart) = try JPEGSegments.parse([UInt8](data))
        return data.subdata(in: scanStart ..< data.count)
    }

    private func files() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    }

    /// The rule, read back from the file: the capture time, the size, sRGB,
    /// orientation 1 and nothing of the camera, the place or a thumbnail.
    private func assertTheRule(
        _ url: URL,
        width: Int,
        height: Int,
        colorSpace: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let data = try Data(contentsOf: url)
        XCTAssertEqual(JPEGExport.ruleViolations(in: data, capture: capture), [], file: file, line: line)
        XCTAssertEqual(segmentKinds(data).filter { $0.hasPrefix("APP") || $0 == "XMP" || $0 == "COM" }, [], file: file, line: line)
        XCTAssertEqual(segmentKinds(data).filter { $0 == "EXIF" }.count, 1, file: file, line: line)
        XCTAssertEqual(thumbnail(in: data), false, "no thumbnail", file: file, line: line)

        let written = try properties(data)
        XCTAssertEqual(written[kCGImagePropertyPixelWidth as String] as? Int, width, file: file, line: line)
        XCTAssertEqual(written[kCGImagePropertyPixelHeight as String] as? Int, height, file: file, line: line)
        XCTAssertEqual(written[kCGImagePropertyOrientation as String] as? Int ?? 1, 1, file: file, line: line)
        for key in [gpsKey, exifAuxKey, iptcKey] {
            XCTAssertNil(written[key], key, file: file, line: line)
        }

        let exif = try XCTUnwrap(written[exifKey] as? [String: Any], file: file, line: line)
        XCTAssertEqual(exif[dateKey] as? String, "2026:09:20 10:11:12", file: file, line: line)
        XCTAssertEqual(exif[offsetKey] as? String, "+09:00", file: file, line: line)
        XCTAssertEqual(exif[subsecKey] as? String, "123", file: file, line: line)
        XCTAssertEqual(exif[kCGImagePropertyExifPixelXDimension as String] as? Int, width, file: file, line: line)
        XCTAssertEqual(exif[kCGImagePropertyExifPixelYDimension as String] as? Int, height, file: file, line: line)
        XCTAssertEqual(exif[kCGImagePropertyExifColorSpace as String] as? Int, colorSpace, file: file, line: line)
        for key in [
            kCGImagePropertyExifLensModel, kCGImagePropertyExifFNumber, kCGImagePropertyExifISOSpeedRatings,
            kCGImagePropertyExifBodySerialNumber,
        ] {
            XCTAssertNil(exif[key as String], key as String, file: file, line: line)
        }

        let tiff = try XCTUnwrap(written[tiffKey] as? [String: Any], file: file, line: line)
        XCTAssertEqual(tiff[kCGImagePropertyTIFFOrientation as String] as? Int, 1, file: file, line: line)
        for key in [
            kCGImagePropertyTIFFMake, kCGImagePropertyTIFFModel, kCGImagePropertyTIFFDateTime, kCGImagePropertyTIFFArtist,
            kCGImagePropertyTIFFSoftware, kCGImagePropertyTIFFCopyright, kCGImagePropertyTIFFImageDescription,
            kCGImagePropertyTIFFHostComputer,
        ] {
            XCTAssertNil(tiff[key as String], key as String, file: file, line: line)
        }
    }

    /// No EXIF at all (no capture time), and none of the rest.
    private func assertNoEXIF(_ url: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let data = try Data(contentsOf: url)
        XCTAssertEqual(JPEGExport.ruleViolations(in: data, capture: nil), [], file: file, line: line)
        XCTAssertEqual(segmentKinds(data).filter { $0 != "JFIF" && !$0.hasPrefix("M") }, [], file: file, line: line)
        let written = try properties(data)
        for key in [exifKey, tiffKey, gpsKey, exifAuxKey, iptcKey] {
            XCTAssertNil(written[key], key, file: file, line: line)
        }
        XCTAssertEqual(written[kCGImagePropertyOrientation as String] as? Int ?? 1, 1, file: file, line: line)
    }

    // MARK: the rule (dictionaries)

    func testCaptureTimeIsTheOriginalsDateTimeOriginal() {
        let full: [String: Any] = [exifKey: [
            dateKey: "2026:09:20 10:11:12", offsetKey: "+09:00", subsecKey: "123",
            kCGImagePropertyExifLensModel as String: "lens",
        ]]
        XCTAssertEqual(JPEGExport.captureTime(from: full), capture)
        XCTAssertEqual(
            JPEGExport.captureTime(from: [exifKey: [dateKey: "2026:09:20 10:11:12 ", offsetKey: "-03:30"]]),
            JPEGExport.CaptureTime(dateTimeOriginal: "2026:09:20 10:11:12", offsetTimeOriginal: "-03:30", subsecTimeOriginal: nil)
        )
        // A malformed offset or sub-second is dropped, the date kept.
        for (offset, subsec) in [("+9:00", "12a"), ("+14:30", ""), ("09:00", "1234567890"), ("+09-00", " ")] {
            XCTAssertEqual(
                JPEGExport.captureTime(from: [exifKey: [dateKey: "2026:09:20 10:11:12", offsetKey: offset, subsecKey: subsec]]),
                JPEGExport.CaptureTime(dateTimeOriginal: "2026:09:20 10:11:12", offsetTimeOriginal: nil, subsecTimeOriginal: nil),
                "\(offset) \(subsec)"
            )
        }
        // No capture time: none, blank, zero, malformed.
        for date in ["    :  :     :  :  ", "0000:00:00 00:00:00", "2026-09-20 10:11:12", "2026:13:20 10:11:12",
                     "2026:09:20 24:00:00", "2026:02:29 10:11:12", "2024:02:30 10:11:12", "2025:04:31 10:11:12",
                     "1900:02:29 10:11:12", "2026:09:20", "2026:09:20T10:11:12", ""]
        {
            XCTAssertNil(JPEGExport.captureTime(from: [exifKey: [dateKey: date]]), date)
        }
        for date in ["2024:02:29 10:11:12", "2000:02:29 10:11:12"] {
            XCTAssertNotNil(JPEGExport.captureTime(from: [exifKey: [dateKey: date]]), date)
        }
        XCTAssertNil(JPEGExport.captureTime(from: [:]))
        XCTAssertNil(JPEGExport.captureTime(from: [exifKey: [offsetKey: "+09:00"]]))
        XCTAssertNil(
            JPEGExport.captureTime(from: [tiffKey: [kCGImagePropertyTIFFDateTime as String: "2026:09:20 10:11:12"]]),
            "TIFF DateTime (the file's change) is not the capture time"
        )
    }

    func testDestinationPropertiesAreTheCaptureTimeOnly() throws {
        let properties = JPEGExport.destinationProperties(capture: capture, pixelWidth: 6000, pixelHeight: 4000, quality: 1.5)
        XCTAssertEqual(Set(properties.keys), [
            exifKey, tiffKey,
            kCGImageDestinationLossyCompressionQuality as String, kCGImagePropertyOrientation as String,
        ], "no thumbnail, GPS, ExifAux or IPTC")
        XCTAssertEqual(properties[exifKey] as? NSDictionary, [
            dateKey: "2026:09:20 10:11:12", offsetKey: "+09:00", subsecKey: "123",
            kCGImagePropertyExifPixelXDimension as String: 6000,
            kCGImagePropertyExifPixelYDimension as String: 4000,
            kCGImagePropertyExifColorSpace as String: 1,
        ] as NSDictionary)
        XCTAssertEqual(properties[tiffKey] as? [String: Int], [kCGImagePropertyTIFFOrientation as String: 1])
        XCTAssertEqual(properties[kCGImageDestinationLossyCompressionQuality as String] as? Double, 1)
        XCTAssertEqual(properties[kCGImagePropertyOrientation as String] as? Int, 1)

        let dateOnly = JPEGExport.CaptureTime(dateTimeOriginal: "2026:09:20 10:11:12", offsetTimeOriginal: nil, subsecTimeOriginal: nil)
        let exif = try XCTUnwrap(JPEGExport.exifProperties(capture: dateOnly, pixelWidth: 1, pixelHeight: 2)[exifKey] as? [String: Any])
        XCTAssertEqual(Set(exif.keys), [
            dateKey, kCGImagePropertyExifPixelXDimension as String, kCGImagePropertyExifPixelYDimension as String,
            kCGImagePropertyExifColorSpace as String,
        ])

        let bare = JPEGExport.destinationProperties(capture: nil, pixelWidth: 10, pixelHeight: 20, quality: 0.92)
        XCTAssertEqual(Set(bare.keys), [kCGImageDestinationLossyCompressionQuality as String, kCGImagePropertyOrientation as String])
        XCTAssertEqual(JPEGExport.defaultQuality, 0.92)
    }

    func testStrippingKeepsTheExifOnlyWhenAsked() throws {
        let jfif = segment(0xE0, JPEGSegments.jfifSignature + [1, 1, 0, 0, 1, 0, 1, 0, 0])
        let exif = segment(0xE1, JPEGSegments.exifSignature + [1, 2, 3])
        let xmp = segment(0xE1, JPEGExport.xmpSignature + [9])
        let icc = segment(0xE2, JPEGSegments.iccSignature + [1, 1, 7, 7])
        let photoshop = segment(0xED, Array("Photoshop 3.0".utf8) + [0, 1])
        let comment = segment(0xFE, Array("hello".utf8))
        let quantization = segment(0xDB, [0] + Array(repeating: 1, count: 64))
        let scan: [UInt8] = [0xFF, 0xDA, 0x00, 0x02, 0x12, 0x34, 0xFF, 0xD9]
        let jpeg = Data([0xFF, 0xD8] + jfif + exif + xmp + icc + photoshop + comment + quantization + scan)
        XCTAssertEqual(
            try JPEGSegments.strippingMetadata(jpeg, keepICC: true, keepExif: true),
            Data([0xFF, 0xD8] + jfif + exif + icc + quantization + scan)
        )
        XCTAssertEqual(try JPEGSegments.strippingMetadata(jpeg, keepICC: true), Data([0xFF, 0xD8] + jfif + icc + quantization + scan))
        XCTAssertEqual(JPEGSegments.imageData(jpeg), Data(quantization + scan))
    }

    func testStrippingRemovesMetadataBetweenProgressiveScans() throws {
        func segment(_ marker: UInt8, _ payload: [UInt8]) -> [UInt8] {
            let length = payload.count + 2
            return [0xFF, marker, UInt8(length >> 8), UInt8(length & 0xFF)] + payload
        }

        let progressiveFrame = segment(0xC2, [8, 0, 1, 0, 1, 1, 1, 0x11, 0])
        let quantization = segment(0xDB, [0] + Array(repeating: 1, count: 64))
        let huffman = segment(0xC4, [0x10, 0, 1, 2])
        let dcScanHeader = segment(0xDA, [1, 1, 0, 0, 0, 0])
        let acScanHeader = segment(0xDA, [1, 1, 0, 1, 0x3F, 0])
        let privateApp = segment(0xEC, Array("private metadata".utf8))
        let comment = segment(0xFE, Array("private comment".utf8))
        let firstEntropyScan: [UInt8] = [0x11, 0xFF, 0x00, 0x22, 0xFF, 0xD0, 0x33]
        let secondEntropyScan: [UInt8] = [0x44, 0xFF, 0x00, 0x55]
        let jpegBytes = [0xFF, 0xD8] + progressiveFrame + quantization + dcScanHeader + firstEntropyScan + privateApp
            + huffman + comment + acScanHeader + secondEntropyScan + [0xFF, 0xD9]
        let jpeg = Data(jpegBytes)

        let markers = JPEGSegments.markers(in: jpeg)
        XCTAssertTrue(markers.contains(0xEC), "APP12 between scans is parsed")
        XCTAssertTrue(markers.contains(0xFE), "COM between scans is parsed")
        let violations = JPEGExport.ruleViolations(in: jpeg, capture: nil)
        XCTAssertTrue(violations.contains("APP12"), "the output rule checks later scans")
        XCTAssertTrue(violations.contains("comment"), "the output rule checks later comments")

        let stripped = try JPEGSegments.strippingMetadata(jpeg, keepICC: true)
        let expectedBytes = [0xFF, 0xD8] + progressiveFrame + quantization + dcScanHeader + firstEntropyScan + huffman
            + acScanHeader + secondEntropyScan + [0xFF, 0xD9]
        let expected = Data(expectedBytes)
        XCTAssertEqual(stripped, expected, "entropy data, restart markers, tables and SOS headers remain byte-for-byte")
        XCTAssertFalse(JPEGSegments.markers(in: stripped).contains(0xEC))
        XCTAssertFalse(JPEGSegments.markers(in: stripped).contains(0xFE))
        XCTAssertEqual(JPEGSegments.imageData(jpeg), JPEGSegments.imageData(stripped))
        XCTAssertThrowsError(try JPEGSegments.strippingMetadata(Data(jpegBytes + privateApp), keepICC: true)) {
            XCTAssertEqual(($0 as? ToolError)?.code, "encode_failed", "reject data after EOI instead of copying it")
        }
    }

    // MARK: encode-jpeg

    func testEncodeJPEGWritesTheCaptureTimeOnly() throws {
        let originalURL = try original()
        let (image, _) = try gradient(width: 640, height: 427)
        let pixelsURL = try write(image, type: .png, name: "pixels.png")
        let outURL = directory.appendingPathComponent("out/export.jpg")

        let summary = try EncodeJPEGCommand.run(EncodeJPEGOptions(
            pixels: pixelsURL.path, metadataFrom: originalURL.path, out: outURL.path
        ))
        XCTAssertEqual(summary["metadata"] as? Bool, true, "the capture time was written")
        XCTAssertEqual(summary["width"] as? Int, 640)
        XCTAssertEqual(summary["height"] as? Int, 427)
        XCTAssertEqual(summary["warnings"] as? Int, 0)

        let source = try XCTUnwrap(CGImageSourceCreateWithURL(outURL as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        XCTAssertTrue((try properties(outURL)[kCGImagePropertyProfileName as String] as? String ?? "").contains("sRGB"))
        try assertTheRule(outURL, width: 640, height: 427)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outURL.deletingLastPathComponent().path), ["export.jpg"])
    }

    func testEncodeJPEGWithoutACaptureTimeWritesNoEXIF() throws {
        let (image, _) = try gradient(width: 32, height: 24)
        let pixelsURL = try write(image, type: .png, name: "pixels.png")
        let text = directory.appendingPathComponent("note.txt")
        try Data("not an image".utf8).write(to: text)
        let noDate = try original(name: "no-date.jpg", withCaptureTime: false)
        for from in [directory.appendingPathComponent("missing.RW2").path, text.path, noDate.path] {
            let outURL = directory.appendingPathComponent("bare.jpg")
            let summary = try EncodeJPEGCommand.run(EncodeJPEGOptions(pixels: pixelsURL.path, metadataFrom: from, out: outURL.path))
            XCTAssertEqual(summary["metadata"] as? Bool, false, from)
            XCTAssertEqual(summary["warnings"] as? Int, 1, from)
            XCTAssertEqual(try properties(outURL)[kCGImagePropertyPixelWidth as String] as? Int, 32)
            try assertNoEXIF(outURL)
        }
    }

    func testPixelsAreWrittenAsTheyAre() throws {
        let originalURL = try original()
        for space in [nil, CGColorSpace(name: CGColorSpace.sRGB)] {
            let (image, rgb) = try gradient(width: 96, height: 64, space: space)
            let pixelsURL = try write(image, type: .png, name: "pixels.png")
            let outURL = directory.appendingPathComponent("q1.jpg")
            _ = try EncodeJPEGCommand.run(EncodeJPEGOptions(
                pixels: pixelsURL.path, metadataFrom: originalURL.path, out: outURL.path, quality: 1
            ))
            // Decode into sRGB (the JPEG's own space: no conversion on the way back).
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(outURL as CFURL, nil))
            let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            var rgbx = [UInt8](repeating: 0, count: 96 * 64 * 4)
            try rgbx.withUnsafeMutableBytes { bytes in
                let context = try XCTUnwrap(CGContext(
                    data: bytes.baseAddress, width: 96, height: 64, bitsPerComponent: 8, bytesPerRow: 96 * 4,
                    space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                ))
                context.draw(decoded, in: CGRect(x: 0, y: 0, width: 96, height: 64))
            }
            var maxDiff = 0
            var sum = 0
            for i in 0 ..< 96 * 64 {
                for c in 0 ..< 3 {
                    let d = abs(Int(rgbx[i * 4 + c]) - Int(rgb[i * 3 + c]))
                    maxDiff = max(maxDiff, d)
                    sum += d
                }
            }
            let mean = Double(sum) / Double(96 * 64 * 3)
            XCTAssertLessThanOrEqual(maxDiff, 6, "space \(String(describing: space?.name))")
            XCTAssertLessThan(mean, 1.5, "space \(String(describing: space?.name))")
        }
    }

    func testFailuresLeaveNoFile() throws {
        let originalURL = try original()
        let (image, _) = try gradient(width: 16, height: 16)
        let pixelsURL = try write(image, type: .png, name: "pixels.png")
        let text = directory.appendingPathComponent("note.txt")
        try Data("not an image".utf8).write(to: text)
        let before = try files()

        func code(_ options: EncodeJPEGOptions) -> String? {
            do {
                _ = try EncodeJPEGCommand.run(options)
                return nil
            } catch let error as ToolError {
                return error.code
            } catch {
                return "\(error)"
            }
        }
        let out = directory.appendingPathComponent("out.jpg").path
        XCTAssertEqual(code(EncodeJPEGOptions(pixels: directory.appendingPathComponent("none.png").path, metadataFrom: originalURL.path, out: out)), "input_not_found")
        XCTAssertEqual(code(EncodeJPEGOptions(pixels: text.path, metadataFrom: originalURL.path, out: out)), "read_failed")
        XCTAssertEqual(code(EncodeJPEGOptions(pixels: pixelsURL.path, metadataFrom: originalURL.path, out: pixelsURL.path)), "invalid_arguments")
        XCTAssertEqual(code(EncodeJPEGOptions(pixels: pixelsURL.path, metadataFrom: originalURL.path, out: originalURL.path)), "invalid_arguments")
        XCTAssertEqual(code(EncodeJPEGOptions(pixels: pixelsURL.path, metadataFrom: originalURL.path, out: text.path + "/out.jpg")), "write_failed")
        XCTAssertEqual(try files(), before, "no output and no partial file")
    }

    // MARK: retag-jpeg

    func testRetagKeepsTheImageAndPutsTheCaptureTimeOnly() throws {
        let inURL = try photoBenchExport()
        let input = try Data(contentsOf: inURL)
        let outURL = directory.appendingPathComponent("retagged/export.jpg")

        let summary = try RetagJPEGCommand.run(RetagJPEGOptions(input: inURL.path, out: outURL.path))
        XCTAssertEqual(summary["ok"] as? Bool, true)
        XCTAssertEqual(summary["metadata"] as? Bool, true)
        XCTAssertEqual(summary["width"] as? Int, 160)
        XCTAssertEqual(summary["height"] as? Int, 107)
        XCTAssertEqual(summary["warnings"] as? Int, 0)
        try assertTheRule(outURL, width: 160, height: 107)

        // Lossless: the scan (SOS to the end) and the tables are the input's bytes.
        let output = try Data(contentsOf: outURL)
        XCTAssertEqual(try scan(output), try scan(input))
        XCTAssertEqual(JPEGSegments.imageData(output), JPEGSegments.imageData(input))
        XCTAssertEqual(try Data(contentsOf: inURL), input, "--in is left as it is")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outURL.deletingLastPathComponent().path), ["export.jpg"])
    }

    func testRetagRemovesMetadataAfterTheFirstScan() throws {
        let inURL = try photoBenchExport(name: "metadata-after-scan.jpg")
        let original = try Data(contentsOf: inURL)
        XCTAssertTrue(original.suffix(2).elementsEqual([0xFF, 0xD9]), "fixture ends at EOI")
        var input = Data(original.dropLast(2))
        input.append(contentsOf: segment(0xEC, Array("private APP12".utf8)))
        input.append(contentsOf: [0xFF, 0xD9])
        try input.write(to: inURL)

        let outURL = directory.appendingPathComponent("metadata-after-scan-retagged.jpg")
        _ = try RetagJPEGCommand.run(RetagJPEGOptions(input: inURL.path, out: outURL.path))
        try assertTheRule(outURL, width: 160, height: 107)
        XCTAssertEqual(JPEGSegments.imageData(try Data(contentsOf: outURL)), JPEGSegments.imageData(input))
    }

    func testRetagInPlace() throws {
        let url = try photoBenchExport(name: "in-place.jpg")
        let input = try Data(contentsOf: url)
        let before = try files()
        let summary = try RetagJPEGCommand.run(RetagJPEGOptions(input: url.path, out: url.path))
        XCTAssertEqual(summary["metadata"] as? Bool, true)
        try assertTheRule(url, width: 160, height: 107)
        XCTAssertEqual(try scan(Data(contentsOf: url)), try scan(input))
        XCTAssertEqual(try files(), before, "no partial file left")
    }

    func testRetagWithoutACaptureTimeWritesNoEXIF() throws {
        let inURL = try photoBenchExport(withCaptureTime: false)
        let input = try Data(contentsOf: inURL)
        let outURL = directory.appendingPathComponent("bare.jpg")
        let summary = try RetagJPEGCommand.run(RetagJPEGOptions(input: inURL.path, out: outURL.path))
        XCTAssertEqual(summary["metadata"] as? Bool, false)
        XCTAssertEqual(summary["warnings"] as? Int, 1)
        try assertNoEXIF(outURL)
        XCTAssertEqual(try scan(Data(contentsOf: outURL)), try scan(input))
    }

    func testRetagKeepsTheICC() throws {
        let p3 = try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))
        let (image, _) = try gradient(width: 48, height: 32, space: p3)
        let inURL = try write(image, type: .jpeg, name: "p3.jpg", properties: [
            exifKey: [dateKey: "2026:09:20 10:11:12", offsetKey: "+09:00", subsecKey: "123"],
            gpsKey: [kCGImagePropertyGPSLatitude as String: 35.3192, kCGImagePropertyGPSLatitudeRef as String: "N"],
        ])
        let icc = try XCTUnwrap(JPEGSegments.iccProfile(in: Data(contentsOf: inURL)), "the fixture carries the P3 ICC")
        let outURL = directory.appendingPathComponent("p3-retagged.jpg")
        let summary = try RetagJPEGCommand.run(RetagJPEGOptions(input: inURL.path, out: outURL.path))
        XCTAssertEqual(summary["warnings"] as? Int, 1, "ColorSpace 65535")
        XCTAssertEqual(JPEGSegments.iccProfile(in: try Data(contentsOf: outURL)), icc)
        try assertTheRule(outURL, width: 48, height: 32, colorSpace: 65535)
        XCTAssertEqual(try scan(Data(contentsOf: outURL)), try scan(Data(contentsOf: inURL)))
    }

    func testRetagFailuresLeaveNoFile() throws {
        let (image, _) = try gradient(width: 16, height: 16)
        let png = try write(image, type: .png, name: "pixels.png")
        let text = directory.appendingPathComponent("note.txt")
        try Data("not an image".utf8).write(to: text)
        let rotated = try photoBenchExport(name: "rotated.jpg", orientation: 6)
        let jpeg = try photoBenchExport(name: "ok.jpg")
        let before = try files()

        func code(_ input: String, _ out: String) -> String? {
            do {
                _ = try RetagJPEGCommand.run(RetagJPEGOptions(input: input, out: out))
                return nil
            } catch let error as ToolError {
                return error.code
            } catch {
                return "\(error)"
            }
        }
        let out = directory.appendingPathComponent("out.jpg").path
        XCTAssertEqual(code(directory.appendingPathComponent("none.jpg").path, out), "input_not_found")
        XCTAssertEqual(code(png.path, out), "read_failed", "a PNG is not a JPEG")
        XCTAssertEqual(code(text.path, out), "read_failed")
        XCTAssertEqual(code(rotated.path, out), "read_failed", "orientation 6 would turn the photo")
        XCTAssertEqual(code(jpeg.path, text.path + "/out.jpg"), "write_failed")
        XCTAssertEqual(code(png.path, png.path), "read_failed")
        XCTAssertEqual(try files(), before, "no output and no partial file")
    }

    // MARK: the check

    func testRuleViolationsCatchWhatTheRuleDrops() throws {
        let photoBench = try Data(contentsOf: photoBenchExport())
        let violations = JPEGExport.ruleViolations(in: photoBench, capture: capture)
        for expected in [
            "{GPS}", "{ExifAux}", "{IPTC}", "EXIF thumbnail (IFD1)", "XMP", "IPTC (APP13)", "comment",
            "{TIFF} Make", "{TIFF} Model", "{TIFF} Software", "{Exif} LensModel", "{Exif} BodySerialNumber",
        ] {
            XCTAssertTrue(violations.contains(expected), "\(expected) in \(violations)")
        }
        XCTAssertTrue(JPEGExport.ruleViolations(in: photoBench, capture: nil).contains("EXIF without a capture time"))

        // A JPEG with the rule passes, and only with its own capture time.
        let (image, _) = try gradient(width: 32, height: 24)
        let pixelsURL = try write(image, type: .png, name: "pixels.png")
        let outURL = directory.appendingPathComponent("rule.jpg")
        _ = try EncodeJPEGCommand.run(EncodeJPEGOptions(pixels: pixelsURL.path, metadataFrom: try original().path, out: outURL.path))
        let rule = try Data(contentsOf: outURL)
        XCTAssertEqual(JPEGExport.ruleViolations(in: rule, capture: capture), [])
        let other = JPEGExport.CaptureTime(dateTimeOriginal: "2026:09:21 00:00:00", offsetTimeOriginal: nil, subsecTimeOriginal: "123")
        XCTAssertEqual(JPEGExport.ruleViolations(in: rule, capture: other), [
            "DateTimeOriginal 2026:09:20 10:11:12 instead of 2026:09:21 00:00:00",
            "OffsetTimeOriginal +09:00 instead of none",
        ])
        XCTAssertEqual(JPEGExport.ruleViolations(in: Data("not a jpeg".utf8), capture: nil), ["not a JPEG"])
    }

    // MARK: arguments

    func testEncodeJPEGArguments() throws {
        let command = try ArgumentParser.parse(["encode-jpeg", "--pixels", "p.png", "--metadata-from=a.RW2", "--out", "o.jpg"])
        XCTAssertEqual(command, .encodeJPEG(EncodeJPEGOptions(pixels: "p.png", metadataFrom: "a.RW2", out: "o.jpg", quality: 0.92)))
        let quality = try ArgumentParser.parse(["encode-jpeg", "--pixels", "p.png", "--metadata-from", "a", "--out", "o.jpg", "--quality", "0.8"])
        XCTAssertEqual(quality, .encodeJPEG(EncodeJPEGOptions(pixels: "p.png", metadataFrom: "a", out: "o.jpg", quality: 0.8)))
        for arguments in [
            ["encode-jpeg", "--metadata-from", "a", "--out", "o.jpg"],
            ["encode-jpeg", "--pixels", "p.png", "--out", "o.jpg"],
            ["encode-jpeg", "--pixels", "p.png", "--metadata-from", "a"],
            ["encode-jpeg", "--pixels", "p.png", "--metadata-from", "a", "--out", "o.jpg", "--quality", "1.5"],
            ["encode-jpeg", "--pixels", "p.png", "--metadata-from", "a", "--out", "o.jpg", "--quality", "nan"],
            ["encode-jpeg", "--pixels", "p.png", "--metadata-from", "a", "--out", "o.jpg", "--long-edge", "full"],
            ["encode-jpeg", "p.png"],
        ] {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments")
            }
        }
    }

    func testRetagJPEGArguments() throws {
        XCTAssertEqual(
            try ArgumentParser.parse(["retag-jpeg", "--in", "a.jpg", "--out=b.jpg"]),
            .retagJPEG(RetagJPEGOptions(input: "a.jpg", out: "b.jpg"))
        )
        XCTAssertEqual(
            try ArgumentParser.parse(["retag-jpeg", "--in", "a.jpg", "--out", "a.jpg"]),
            .retagJPEG(RetagJPEGOptions(input: "a.jpg", out: "a.jpg"))
        )
        for arguments in [
            ["retag-jpeg", "--out", "b.jpg"],
            ["retag-jpeg", "--in", "a.jpg"],
            ["retag-jpeg", "a.jpg", "--out", "b.jpg"],
            ["retag-jpeg", "--in", "a.jpg", "--out", "b.jpg", "--quality", "0.9"],
            ["retag-jpeg", "--in", "a.jpg", "--in", "c.jpg", "--out", "b.jpg"],
        ] {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments")
            }
        }
    }

    func testOptInPixelEncodingUsesNewMinorSeries() {
        XCTAssertEqual(Tool.version, "0.5.2")
        XCTAssertTrue(Tool.version.hasPrefix("0.5."), "the opt-in p3/e4 encoding requires a minor version")
    }
}
