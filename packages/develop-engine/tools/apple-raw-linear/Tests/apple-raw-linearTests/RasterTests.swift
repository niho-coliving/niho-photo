import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import apple_raw_linear

/// `raster` (0.4.3, K5-c1 #17153): the raster working copy as an 8-bit JPEG
/// with the source's ICC (or sRGB without one), ICC-only metadata, upright,
/// downscaled in linear light, and its sRGB preview. The images are made here
/// with CoreGraphics / ImageIO (no image files in the repository).
final class RasterTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-raw-linear-raster-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: fixtures

    private let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
    private let displayP3 = CGColorSpace(name: CGColorSpace.displayP3)!

    /// An image whose pixel (x, y) (row 0 = top) has the components
    /// `pixel(x, y)` in [0, 1], 8 or 16 bits, in `space` (RGB, gray or CMYK).
    private func makeImage(
        width: Int,
        height: Int,
        space: CGColorSpace,
        bits: Int = 8,
        _ pixel: (Int, Int) -> [Double]
    ) throws -> CGImage {
        let colors = space.numberOfComponents
        let stride = colors == 3 ? 4 : colors
        let bytesPerComponent = bits / 8
        let maxValue = Double((1 << bits) - 1)
        var buffer = [UInt8](repeating: 0, count: width * height * stride * bytesPerComponent)
        for y in 0 ..< height {
            for x in 0 ..< width {
                let values = pixel(x, y)
                for c in 0 ..< colors {
                    let code = UInt16((min(max(values[c], 0), 1) * maxValue).rounded())
                    let offset = ((y * width + x) * stride + c) * bytesPerComponent
                    if bits == 8 {
                        buffer[offset] = UInt8(code)
                    } else {
                        buffer[offset] = UInt8(code & 0xFF)
                        buffer[offset + 1] = UInt8(code >> 8)
                    }
                }
            }
        }
        let alpha: CGImageAlphaInfo = colors == 3 ? .noneSkipLast : .none
        let info = alpha.rawValue | (bits == 16 ? CGBitmapInfo.byteOrder16Little.rawValue : 0)
        // A data provider, not a bitmap context: any color space (PQ, linear) works.
        let provider = try XCTUnwrap(CGDataProvider(data: Data(buffer) as CFData))
        return try XCTUnwrap(CGImage(
            width: width,
            height: height,
            bitsPerComponent: bits,
            bitsPerPixel: bits * stride,
            bytesPerRow: width * stride * bytesPerComponent,
            space: space,
            bitmapInfo: CGBitmapInfo(rawValue: info),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ))
    }

    private func write(_ image: CGImage, type: UTType, name: String, properties: [String: Any] = [:]) throws -> URL {
        let url = directory.appendingPathComponent(name)
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url
    }

    /// EXIF, GPS, TIFF and IPTC a working copy must not carry.
    private let privateMetadata: [String: Any] = [
        kCGImagePropertyExifDictionary as String: [
            kCGImagePropertyExifDateTimeOriginal as String: "2026:09:20 10:11:12",
            kCGImagePropertyExifLensModel as String: "iPhone 16 Pro back camera",
        ],
        kCGImagePropertyGPSDictionary as String: [
            kCGImagePropertyGPSLatitude as String: 35.3192,
            kCGImagePropertyGPSLatitudeRef as String: "N",
            kCGImagePropertyGPSLongitude as String: 139.5467,
            kCGImagePropertyGPSLongitudeRef as String: "E",
        ],
        kCGImagePropertyTIFFDictionary as String: [
            kCGImagePropertyTIFFMake as String: "Apple",
            kCGImagePropertyTIFFModel as String: "iPhone 16 Pro",
        ],
        kCGImagePropertyIPTCDictionary as String: [
            kCGImagePropertyIPTCKeywords as String: ["kamakura"],
        ],
    ]

    private func properties(_ url: URL) throws -> [String: Any] {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
    }

    /// The file drawn into 8-bit RGBA in `space` (CoreGraphics converts from
    /// the file's own color space).
    private func pixels(_ url: URL, in space: CGColorSpace) throws -> (width: Int, height: Int, rgba: [UInt8]) {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try rgba.withUnsafeMutableBytes { bytes in
            let context = try XCTUnwrap(CGContext(
                data: bytes.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return (image.width, image.height, rgba)
    }

    private func pixel(_ image: (width: Int, height: Int, rgba: [UInt8]), _ x: Int, _ y: Int) -> [Int] {
        let offset = (y * image.width + x) * 4
        return (0 ..< 3).map { Int(image.rgba[offset + $0]) }
    }

    private func assertClose(_ actual: [Int], _ expected: [Int], tolerance: Int, _ message: String = "",
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.count, expected.count, message, file: file, line: line)
        for (a, e) in zip(actual, expected) where abs(a - e) > tolerance {
            XCTFail("\(actual) is not within \(tolerance) of \(expected) \(message)", file: file, line: line)
            return
        }
    }

    /// A PNG without any color chunk (iCCP, sRGB, gAMA, cHRM, cICP): an
    /// untagged RGB original.
    private func strippingColorChunks(_ url: URL) throws -> URL {
        let bytes = [UInt8](try Data(contentsOf: url))
        var output = Data(bytes[0 ..< 8])
        var index = 8
        var dropped: [String] = []
        while index + 12 <= bytes.count {
            let length = Int(bytes[index]) << 24 | Int(bytes[index + 1]) << 16 | Int(bytes[index + 2]) << 8 | Int(bytes[index + 3])
            let type = String(decoding: bytes[(index + 4) ..< (index + 8)], as: UTF8.self)
            let end = index + 12 + length
            if ["iCCP", "sRGB", "gAMA", "cHRM", "cICP"].contains(type) {
                dropped.append(type)
            } else {
                output.append(contentsOf: bytes[index ..< end])
            }
            index = end
        }
        XCTAssertFalse(dropped.isEmpty, "the PNG carried a color chunk to strip")
        let stripped = directory.appendingPathComponent("untagged-" + url.lastPathComponent)
        try output.write(to: stripped)
        return stripped
    }

    private func run(_ options: RasterOptions) throws -> [String: Any] {
        try RasterCommand.run(options)
    }

    private func out(_ name: String) -> String {
        directory.appendingPathComponent(name).path
    }

    private func files() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    }

    /// The working copy's container: JPEG, JFIF / ICC / tables only.
    private func assertICCOnlyJPEG(_ url: URL, icc: Bool, file: StaticString = #filePath, line: UInt = #line) throws {
        let data = try Data(contentsOf: url)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier, file: file, line: line)
        let markers = JPEGSegments.markers(in: data)
        XCTAssertFalse(markers.isEmpty, file: file, line: line)
        for marker in markers where (0xE0 ... 0xEF).contains(marker) || marker == 0xFE {
            XCTAssertTrue([0xE0, 0xE2].contains(marker), String(format: "APP / COM marker %02X", marker), file: file, line: line)
        }
        XCTAssertEqual(markers.contains(0xE2), icc, "ICC APP2", file: file, line: line)
        let written = try properties(url)
        for key in [
            kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyTIFFDictionary,
            kCGImagePropertyIPTCDictionary, kCGImagePropertyExifAuxDictionary, kCGImagePropertyMakerAppleDictionary,
        ] {
            XCTAssertNil(written[key as String], "\(key)", file: file, line: line)
        }
        XCTAssertEqual(written[kCGImagePropertyOrientation as String] as? Int ?? 1, 1, file: file, line: line)
        // No thumbnail: none in APP1 (dropped) and a JFIF APP0 with a 0x0 one.
        let bytes = [UInt8](data)
        for segment in try JPEGSegments.parse(bytes).segments where segment.marker == 0xE0 {
            let payload = Array(bytes[segment.payload])
            XCTAssertGreaterThanOrEqual(payload.count, 14, file: file, line: line)
            XCTAssertEqual(Array(payload[12 ..< 14]), [0, 0], "JFIF thumbnail size", file: file, line: line)
        }
        XCTAssertNil(CGImageSourceCopyMetadataAtIndex(source, 0, nil).flatMap { metadata in
            (CGImageMetadataCopyTags(metadata) as? [CGImageMetadataTag]).flatMap { $0.isEmpty ? nil : $0 }
        }, "no XMP / EXIF tags", file: file, line: line)
    }

    // MARK: color

    func testDisplayP3SixteenBitPNGKeepsItsICC() throws {
        // A saturated P3 color outside sRGB: a conversion to sRGB would clip it.
        let color = [0.95, 0.12, 0.06]
        let image = try makeImage(width: 400, height: 300, space: displayP3, bits: 16) { _, _ in color }
        XCTAssertEqual(image.bitsPerComponent, 16)
        let input = try write(image, type: .png, name: "p3.png", properties: privateMetadata)
        let sourceProperties = try properties(input)
        XCTAssertEqual(sourceProperties[kCGImagePropertyDepth as String] as? Int, 16)
        XCTAssertNotNil(sourceProperties[kCGImagePropertyExifDictionary as String], "the fixture carries EXIF")
        XCTAssertNotNil(sourceProperties[kCGImagePropertyGPSDictionary as String], "the fixture carries GPS")

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg"), longEdge: .pixels(200)))
        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        XCTAssertEqual(json["kind"] as? String, "raster")
        XCTAssertEqual(json["encoding"] as? String, "jpeg8")
        XCTAssertEqual(json["width"] as? Int, 200)
        XCTAssertEqual(json["height"] as? Int, 150)
        XCTAssertEqual(json["sourceWidth"] as? Int, 400)
        XCTAssertEqual(json["sourceHeight"] as? Int, 300)
        XCTAssertEqual(json["orientationApplied"] as? Bool, false)
        XCTAssertEqual(json["colorSpace"] as? String, CGColorSpace.displayP3 as String)
        XCTAssertTrue(json["converted"] is NSNull, "the source's own ICC")
        XCTAssertTrue(json["preview"] is NSNull)
        XCTAssertEqual(json["tool"] as? [String: String], ["name": "apple-raw-linear", "version": Tool.version])
        XCTAssertEqual((json["bytes"] as? Int).map(Int64.init), FileWriting.fileSize(outURL))

        // The ICC: the source color space's, byte for byte, and its SHA-256.
        let sourceICC = try XCTUnwrap(displayP3.copyICCData() as Data?)
        let embedded = try XCTUnwrap(JPEGSegments.iccProfile(in: Data(contentsOf: outURL)))
        XCTAssertEqual(embedded, sourceICC)
        XCTAssertEqual(json["iccSha256"] as? String, RasterWorkingCopy.sha256Hex(sourceICC))
        XCTAssertEqual((json["iccSha256"] as? String)?.count, 64)

        let written = try properties(outURL)
        XCTAssertEqual(written[kCGImagePropertyPixelWidth as String] as? Int, 200)
        XCTAssertEqual(written[kCGImagePropertyPixelHeight as String] as? Int, 150)
        XCTAssertEqual(written[kCGImagePropertyDepth as String] as? Int, 8)
        XCTAssertEqual(written[kCGImagePropertyProfileName as String] as? String, "Display P3")
        try assertICCOnlyJPEG(outURL, icc: true)

        // The pixels stay in P3 (not clipped to sRGB): drawn into P3 they are the source's codes.
        let decoded = try pixels(outURL, in: displayP3)
        assertClose(pixel(decoded, 100, 75), color.map { Int(($0 * 255).rounded()) }, tolerance: 3)
    }

    func testOrientationIsAppliedAndMetadataDropped() throws {
        // Stored 64x48 with a red block at the stored top-left; orientation 6
        // shows it rotated 90° clockwise (the block at the top-right).
        let image = try makeImage(width: 64, height: 48, space: sRGB) { x, y in
            x < 8 && y < 8 ? [1, 0, 0] : [0.5, 0.5, 0.5]
        }
        var metadata = privateMetadata
        metadata[kCGImagePropertyOrientation as String] = 6
        let input = try write(image, type: .jpeg, name: "rotated.jpg", properties: metadata)
        XCTAssertEqual(try properties(input)[kCGImagePropertyOrientation as String] as? Int, 6)
        XCTAssertNotNil(try properties(input)[kCGImagePropertyGPSDictionary as String])

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg")))
        XCTAssertEqual(json["width"] as? Int, 48)
        XCTAssertEqual(json["height"] as? Int, 64)
        XCTAssertEqual(json["sourceWidth"] as? Int, 64)
        XCTAssertEqual(json["sourceHeight"] as? Int, 48)
        XCTAssertEqual(json["orientationApplied"] as? Bool, true)
        XCTAssertTrue(json["iccSha256"] is NSNull, "an sRGB original")
        XCTAssertTrue(json["converted"] is NSNull)

        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        try assertICCOnlyJPEG(outURL, icc: false)
        let decoded = try pixels(outURL, in: sRGB)
        XCTAssertEqual(decoded.width, 48)
        XCTAssertEqual(decoded.height, 64)
        XCTAssertGreaterThan(pixel(decoded, 44, 3)[0], 200, "the block is at the top-right")
        XCTAssertLessThan(pixel(decoded, 44, 3)[1], 60)
        assertClose(pixel(decoded, 3, 3), [128, 128, 128], tolerance: 6, "top-left")
        assertClose(pixel(decoded, 44, 60), [128, 128, 128], tolerance: 6, "bottom-right")
    }

    func testUntaggedPNGIsSRGBWithoutICC() throws {
        let image = try makeImage(width: 48, height: 32, space: sRGB) { _, _ in [0.8, 0.4, 0.2] }
        let input = try strippingColorChunks(try write(image, type: .png, name: "tagged.png"))

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg")))
        XCTAssertTrue(json["iccSha256"] is NSNull)
        XCTAssertTrue(json["converted"] is NSNull, "taken as sRGB, not converted")
        XCTAssertEqual(json["colorSpace"] as? String, CGColorSpace.sRGB as String)
        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        try assertICCOnlyJPEG(outURL, icc: false)
        XCTAssertNil(JPEGSegments.iccProfile(in: try Data(contentsOf: outURL)))
        // Treated as sRGB: the codes are kept.
        assertClose(pixel(try pixels(outURL, in: sRGB), 24, 16), [204, 102, 51], tolerance: 3)
    }

    func testGrayPNGIsConvertedToSRGB() throws {
        let gray = try XCTUnwrap(CGColorSpace(name: CGColorSpace.genericGrayGamma2_2))
        let image = try makeImage(width: 40, height: 30, space: gray) { _, _ in [0.5] }
        let input = try write(image, type: .png, name: "gray.png")
        XCTAssertEqual(try properties(input)[kCGImagePropertyColorModel as String] as? String, "Gray")

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg")))
        XCTAssertTrue(json["iccSha256"] is NSNull)
        XCTAssertEqual(json["converted"] as? String, "srgb")
        XCTAssertEqual(json["colorSpace"] as? String, CGColorSpace.sRGB as String)
        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        try assertICCOnlyJPEG(outURL, icc: false)
        let written = try properties(outURL)
        XCTAssertEqual(written[kCGImagePropertyColorModel as String] as? String, "RGB")
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(outURL as CFURL, nil))
        XCTAssertEqual(CGImageSourceCreateImageAtIndex(source, 0, nil)?.colorSpace?.numberOfComponents, 3)
        // Gray 0.5 (gamma 2.2) in sRGB, as CoreGraphics converts it.
        let expected = pixel(try pixels(input, in: sRGB), 20, 15)
        assertClose(pixel(try pixels(outURL, in: sRGB), 20, 15), expected, tolerance: 2)
    }

    func testCMYKJPEGIsConvertedToSRGB() throws {
        let cmyk = try XCTUnwrap(CGColorSpace(name: CGColorSpace.genericCMYK))
        let image = try makeImage(width: 40, height: 30, space: cmyk) { _, _ in [0.2, 0.5, 0.7, 0.1] }
        let input = try write(image, type: .jpeg, name: "cmyk.jpg", properties: [
            kCGImageDestinationLossyCompressionQuality as String: 1,
        ])
        XCTAssertEqual(try properties(input)[kCGImagePropertyColorModel as String] as? String, "CMYK")

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg")))
        XCTAssertTrue(json["iccSha256"] is NSNull)
        XCTAssertEqual(json["converted"] as? String, "srgb")
        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        try assertICCOnlyJPEG(outURL, icc: false)
        XCTAssertEqual(try properties(outURL)[kCGImagePropertyColorModel as String] as? String, "RGB")
        let expected = pixel(try pixels(input, in: sRGB), 20, 15)
        assertClose(pixel(try pixels(outURL, in: sRGB), 20, 15), expected, tolerance: 3)
    }

    func testPNGJPEGAndTIFFRunThroughTheirActualImageIOTypes() throws {
        let image = try makeImage(width: 32, height: 24, space: sRGB) { x, y in
            [Double(x) / 31, Double(y) / 23, 0.35]
        }
        let formats: [(UTType, String)] = [(.png, "PnG"), (.jpeg, "JpEg"), (.tiff, "TiFf")]

        for (type, extensionCase) in formats {
            let input = try write(image, type: type, name: "source-\(type.identifier).\(extensionCase)")
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
            XCTAssertEqual(CGImageSourceGetType(source) as String?, type.identifier)

            let output = directory.appendingPathComponent("working-\(extensionCase).jpg")
            let json = try run(RasterOptions(input: input.path, out: output.path))
            XCTAssertEqual(json["width"] as? Int, 32)
            XCTAssertEqual(json["height"] as? Int, 24)
            XCTAssertEqual(json["orientationApplied"] as? Bool, false)
            try assertICCOnlyJPEG(output, icc: false)
            let expected = pixel(try pixels(input, in: sRGB), 16, 12)
            assertClose(pixel(try pixels(output, in: sRGB), 16, 12), expected, tolerance: 5, type.identifier)
        }
    }

    func testHEICKeepsItsICCAndIsUpright() throws {
        let types = CGImageDestinationCopyTypeIdentifiers() as? [String] ?? []
        guard types.contains(UTType.heic.identifier) else {
            XCTFail("unsupported capability: this CI Mac has no HEIC encoder")
            return
        }
        let image = try makeImage(width: 96, height: 64, space: displayP3) { x, y in
            x < 12 && y < 12 ? [0.95, 0.1, 0.05] : [0.3, 0.5, 0.7]
        }
        var metadata = privateMetadata
        metadata[kCGImagePropertyOrientation as String] = 6
        let input = try write(image, type: .heic, name: "photo.heic", properties: metadata)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.heic.identifier)
        let sourceProperties = try properties(input)
        XCTAssertEqual(sourceProperties[kCGImagePropertyOrientation as String] as? Int, 6)

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg"), previewOut: out("preview.jpg")))
        XCTAssertEqual(json["width"] as? Int, 64)
        XCTAssertEqual(json["height"] as? Int, 96)
        XCTAssertEqual(json["orientationApplied"] as? Bool, true)
        XCTAssertEqual(json["colorSpace"] as? String, CGColorSpace.displayP3 as String)
        XCTAssertTrue(json["converted"] is NSNull)
        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        let embedded = try XCTUnwrap(JPEGSegments.iccProfile(in: Data(contentsOf: outURL)))
        XCTAssertEqual(json["iccSha256"] as? String, RasterWorkingCopy.sha256Hex(embedded))
        try assertICCOnlyJPEG(outURL, icc: true)
        try assertICCOnlyJPEG(URL(fileURLWithPath: out("preview.jpg")), icc: false)
        let decoded = try pixels(outURL, in: displayP3)
        XCTAssertGreaterThan(pixel(decoded, 58, 4)[0], 200, "the block is at the top-right")
        XCTAssertLessThan(pixel(decoded, 4, 4)[0], 120)
    }

    // MARK: sources stage 2 cannot read as they are → Display P3

    private var displayP3ICC: Data {
        get throws { try XCTUnwrap(displayP3.copyICCData() as Data?) }
    }

    /// A working copy converted to Display P3: the P3 ICC, its SHA-256, and an
    /// ICC stage 2 reads.
    private func assertDisplayP3(_ json: [String: Any], _ outURL: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(json["converted"] as? String, "displayP3", file: file, line: line)
        XCTAssertEqual(json["colorSpace"] as? String, CGColorSpace.displayP3 as String, file: file, line: line)
        let embedded = try XCTUnwrap(JPEGSegments.iccProfile(in: Data(contentsOf: outURL)), file: file, line: line)
        XCTAssertEqual(embedded, try displayP3ICC, file: file, line: line)
        XCTAssertEqual(json["iccSha256"] as? String, RasterWorkingCopy.sha256Hex(embedded), file: file, line: line)
        XCTAssertEqual(ICCProfile.stage2Verdict(embedded), .readable, file: file, line: line)
        try assertICCOnlyJPEG(outURL, icc: true, file: file, line: line)
    }

    func testLinearDisplayP3IsConvertedToDisplayP3() throws {
        let linear = try XCTUnwrap(CGColorSpace(name: CGColorSpace.linearDisplayP3))
        let sourceICC = try XCTUnwrap(linear.copyICCData() as Data?)
        guard case .unreadable = ICCProfile.stage2Verdict(sourceICC) else {
            return XCTFail("the linear P3 ICC is nearly linear")
        }
        let color = [0.5, 0.2, 0.05]
        let image = try makeImage(width: 64, height: 48, space: linear, bits: 16) { _, _ in color }
        let input = try write(image, type: .png, name: "linear-p3.png")
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
        XCTAssertEqual(CGImageSourceCreateImageAtIndex(source, 0, nil)?.colorSpace?.name, CGColorSpace.linearDisplayP3)

        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg")))
        let outURL = URL(fileURLWithPath: out("wc.jpg"))
        try assertDisplayP3(json, outURL)
        // The same color, now P3-encoded (not the linear codes under a P3 tag).
        let expected = pixel(try pixels(input, in: displayP3), 32, 24)
        XCTAssertGreaterThan(expected[0], 170, "0.5 linear is about 188 encoded")
        assertClose(pixel(try pixels(outURL, in: displayP3), 32, 24), expected, tolerance: 3)
    }

    func testPQAndHLGAreConvertedToDisplayP3() throws {
        for name in [CGColorSpace.itur_2100_PQ, CGColorSpace.itur_2100_HLG] {
            let space = try XCTUnwrap(CGColorSpace(name: name))
            let image = try makeImage(width: 48, height: 32, space: space, bits: 16) { x, _ in
                [0.3 + 0.4 * Double(x) / 47, 0.35, 0.25]
            }
            let input = try write(image, type: .png, name: "hdr.png")
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
            let fileSpace = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil)?.colorSpace)
            XCTAssertTrue(CGColorSpaceUsesITUR_2100TF(fileSpace), "\(name)")

            // This macOS: read as SDR, written as Display P3.
            let outURL = URL(fileURLWithPath: out("hdr.jpg"))
            try assertDisplayP3(try run(RasterOptions(input: input.path, out: outURL.path)), outURL)

            // Before macOS 15 (no SDR request): the PQ / HLG pixels are converted by Core Image.
            let unrequested = try RasterCommand.decode(input, requestSDR: false)
            XCTAssertEqual(unrequested.color.converted, "displayP3", "\(name)")
            XCTAssertEqual(unrequested.color.space.name, CGColorSpace.displayP3)
            XCTAssertEqual(unrequested.color.icc, try displayP3ICC)
        }
    }

    func testColorDecisions() throws {
        func decision(_ name: CFString, fileIsHDR: Bool = false) throws -> (converted: String?, icc: Data?, space: String?, retag: Bool) {
            let space = try XCTUnwrap(CGColorSpace(name: name), "\(name)")
            let result = try RasterCommand.outputColor(for: space, fileIsHDR: fileIsHDR)
            return (result.color.converted, result.color.icc, result.color.space.name as String?, result.retagAsSRGB)
        }
        // Kept as they are (matrix / TRC, not linear): the source's own ICC.
        for name in [CGColorSpace.displayP3, CGColorSpace.adobeRGB1998, CGColorSpace.rommrgb, CGColorSpace.itur_2020] {
            let kept = try decision(name)
            XCTAssertNil(kept.converted, "\(name)")
            XCTAssertEqual(kept.icc, CGColorSpace(name: name)?.copyICCData() as Data?, "\(name)")
            XCTAssertEqual(kept.space, name as String)
        }
        // sRGB: no ICC, not converted.
        let srgb = try decision(CGColorSpace.sRGB)
        XCTAssertNil(srgb.converted)
        XCTAssertNil(srgb.icc)
        XCTAssertFalse(srgb.retag)
        // Linear, extended range, PQ / HLG, or an HDR original → Display P3.
        for name in [
            CGColorSpace.linearSRGB, CGColorSpace.linearDisplayP3, CGColorSpace.genericRGBLinear,
            CGColorSpace.extendedSRGB, CGColorSpace.extendedLinearSRGB, CGColorSpace.extendedDisplayP3,
            CGColorSpace.itur_2100_PQ, CGColorSpace.itur_2100_HLG,
        ] {
            let converted = try decision(name)
            XCTAssertEqual(converted.converted, "displayP3", "\(name)")
            XCTAssertEqual(converted.space, CGColorSpace.displayP3 as String, "\(name)")
            XCTAssertEqual(converted.icc, try displayP3ICC, "\(name)")
        }
        XCTAssertEqual(try decision(CGColorSpace.displayP3, fileIsHDR: true).converted, "displayP3")
        // Gray and CMYK → sRGB (no ICC), unchanged rule.
        for name in [CGColorSpace.genericGrayGamma2_2, CGColorSpace.linearGray, CGColorSpace.genericCMYK] {
            let gray = try decision(name)
            XCTAssertEqual(gray.converted, "srgb", "\(name)")
            XCTAssertNil(gray.icc, "\(name)")
        }
        // RGB without an ICC (device RGB): taken as sRGB.
        let device = try RasterCommand.outputColor(for: CGColorSpaceCreateDeviceRGB(), fileIsHDR: false)
        XCTAssertNil(device.color.converted)
        XCTAssertNil(device.color.icc)
        XCTAssertTrue(device.retagAsSRGB)
    }

    // MARK: ICC tag table

    private func be32(_ value: Int) -> [UInt8] {
        [UInt8(value >> 24 & 0xFF), UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)]
    }

    private func s15(_ value: Double) -> [UInt8] {
        be32(Int(Int32((value * 65536).rounded())) & 0xFFFF_FFFF)
    }

    private func ascii(_ text: String) -> [UInt8] {
        Array(text.utf8)
    }

    private func xyz(_ x: Double, _ y: Double, _ z: Double) -> [UInt8] {
        ascii("XYZ ") + [0, 0, 0, 0] + s15(x) + s15(y) + s15(z)
    }

    private func curv(_ points: [UInt16]) -> [UInt8] {
        ascii("curv") + [0, 0, 0, 0] + be32(points.count) + points.flatMap { [UInt8($0 >> 8), UInt8($0 & 0xFF)] }
    }

    private func para(_ function: UInt8, _ parameters: [Double]) -> [UInt8] {
        ascii("para") + [0, 0, 0, 0] + [0, function, 0, 0] + parameters.flatMap { s15($0) }
    }

    /// A minimal profile: the header (data color space, `acsp`), the tag
    /// table and the tag data.
    private func profile(_ tags: [(String, [UInt8])], colorSpace: String = "RGB ") -> Data {
        var header = [UInt8](repeating: 0, count: 128)
        header.replaceSubrange(12 ..< 16, with: ascii("mntr"))
        header.replaceSubrange(16 ..< 20, with: ascii(colorSpace))
        header.replaceSubrange(20 ..< 24, with: ascii("XYZ "))
        header.replaceSubrange(36 ..< 40, with: ascii("acsp"))
        var table = be32(tags.count)
        var area: [UInt8] = []
        let base = 128 + 4 + tags.count * 12
        for (name, data) in tags {
            table += ascii(name) + be32(base + area.count) + be32(data.count)
            area += data
            while area.count % 4 != 0 { area.append(0) }
        }
        var bytes = header + table + area
        bytes.replaceSubrange(0 ..< 4, with: be32(bytes.count))
        return Data(bytes)
    }

    private func matrixShaper(_ r: [UInt8], _ g: [UInt8], _ b: [UInt8]) -> [(String, [UInt8])] {
        [
            ("rXYZ", xyz(0.515, 0.241, -0.001)), ("gXYZ", xyz(0.292, 0.692, 0.042)), ("bXYZ", xyz(0.157, 0.067, 0.784)),
            ("rTRC", r), ("gTRC", g), ("bTRC", b),
        ]
    }

    func testICCVerdicts() throws {
        func readable(_ data: Data?) -> Bool {
            guard let data else { return false }
            return ICCProfile.stage2Verdict(data) == .readable
        }
        func icc(_ name: CFString) -> Data? {
            CGColorSpace(name: name)?.copyICCData() as Data?
        }
        // The system's profiles: matrix / TRC ones are read as they are.
        XCTAssertTrue(readable(try displayP3ICC), "Display P3 (para, gamma 2.4)")
        XCTAssertTrue(readable(icc(CGColorSpace.sRGB)), "sRGB (curv table)")
        XCTAssertTrue(readable(icc(CGColorSpace.adobeRGB1998)), "Adobe RGB (curv, gamma 2.2)")
        XCTAssertFalse(readable(icc(CGColorSpace.linearDisplayP3)), "linear P3 (para, gamma 1.0)")
        XCTAssertFalse(readable(icc(CGColorSpace.genericRGBLinear)), "generic linear RGB")
        XCTAssertFalse(readable(icc(CGColorSpace.itur_2100_PQ)), "PQ (A2B0 / B2A0 only)")

        let gamma18 = curv([0x01CD]) // u8Fixed8 1.80
        XCTAssertTrue(readable(profile(matrixShaper(gamma18, gamma18, gamma18))))
        XCTAssertTrue(readable(profile(matrixShaper(curv([0, 20000, 65535]), gamma18, gamma18))), "a table")
        XCTAssertTrue(readable(profile(matrixShaper(para(0, [2.2]), para(3, [2.4, 0.948, 0.052, 0.077, 0.04]), gamma18))))
        XCTAssertTrue(readable(profile(matrixShaper(curv([0x014D]), gamma18, gamma18))), "gamma 1.30 is not linear")

        // Nearly linear TRCs.
        XCTAssertFalse(readable(profile(matrixShaper(curv([]), gamma18, gamma18))), "identity curv")
        XCTAssertFalse(readable(profile(matrixShaper(gamma18, curv([0x0133]), gamma18))), "curv gamma 1.2")
        XCTAssertFalse(readable(profile(matrixShaper(gamma18, gamma18, para(0, [1.29])))), "para gamma 1.29")
        XCTAssertFalse(readable(profile(matrixShaper(gamma18, gamma18, para(3, [1.0, 1, 0, 0, 0])))), "para gamma 1.0")

        // Not a matrix / TRC profile.
        let lutOnly = profile([("A2B0", ascii("mAB ") + [UInt8](repeating: 0, count: 28)), ("wtpt", xyz(0.9642, 1, 0.8249))])
        XCTAssertFalse(readable(lutOnly), "A2B0 only")
        var missing = matrixShaper(gamma18, gamma18, gamma18)
        missing.removeLast()
        XCTAssertFalse(readable(profile(missing)), "no bTRC")
        XCTAssertFalse(readable(profile([("kTRC", gamma18)], colorSpace: "GRAY")), "gray")
        XCTAssertFalse(readable(profile(matrixShaper(gamma18, gamma18, gamma18), colorSpace: "CMYK")), "CMYK header")
        XCTAssertFalse(readable(profile(matrixShaper(ascii("sf32") + [0, 0, 0, 0, 0, 1, 0, 0], gamma18, gamma18))), "an unknown TRC type")
        XCTAssertFalse(readable(profile(matrixShaper(para(9, [2.2]), gamma18, gamma18))), "an unknown para function")
        var zero = matrixShaper(gamma18, gamma18, gamma18)
        zero[0] = ("rXYZ", xyz(0, 0, 0))
        XCTAssertFalse(readable(profile(zero)), "a zero colorant")

        // Malformed.
        let good = [UInt8](profile(matrixShaper(gamma18, gamma18, gamma18)))
        XCTAssertFalse(readable(Data(good.prefix(131))), "shorter than the header")
        XCTAssertFalse(readable(Data(good.prefix(140))), "a truncated tag table")
        var outside = good
        outside.replaceSubrange(136 ..< 140, with: be32(good.count + 100))
        XCTAssertFalse(readable(Data(outside)), "a tag outside the profile")
        var truncatedCurve = matrixShaper(gamma18, gamma18, gamma18)
        truncatedCurve[3] = ("rTRC", ascii("curv") + [0, 0, 0, 0] + be32(40) + [0, 1])
        XCTAssertFalse(readable(profile(truncatedCurve)), "a truncated curv")
    }

    // MARK: size

    func testNeverEnlarges() throws {
        let image = try makeImage(width: 64, height: 48, space: sRGB) { x, _ in [Double(x) / 63, 0.5, 0.5] }
        let input = try write(image, type: .png, name: "small.png")
        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg"), longEdge: .pixels(5000)))
        XCTAssertEqual(json["width"] as? Int, 64)
        XCTAssertEqual(json["height"] as? Int, 48)
        let written = try properties(URL(fileURLWithPath: out("wc.jpg")))
        XCTAssertEqual(written[kCGImagePropertyPixelWidth as String] as? Int, 64)
        XCTAssertEqual(written[kCGImagePropertyPixelHeight as String] as? Int, 48)
    }

    func testTargetSize() {
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 4032, height: 3024, longEdge: 2560) == (2560, 1920))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 3024, height: 4032, longEdge: 2560) == (1920, 2560))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 400, height: 300, longEdge: 200) == (200, 150))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 6000, height: 4000, longEdge: 1024) == (1024, 683))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 2560, height: 10, longEdge: 1024) == (1024, 4))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 5000, height: 1, longEdge: 1024) == (1024, 1))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 800, height: 600, longEdge: 2560) == (800, 600))
        XCTAssertTrue(RasterWorkingCopy.targetSize(width: 2560, height: 2560, longEdge: 2560) == (2560, 2560))
    }

    func testFullSizePreservesSourceDimensionsAndRejectsJPEGOverflow() throws {
        let image = try makeImage(width: 64, height: 48, space: sRGB) { x, y in
            [Double(x) / 63, Double(y) / 47, 0.5]
        }
        let input = try write(image, type: .png, name: "full.png")
        let json = try run(RasterOptions(input: input.path, out: out("full.jpg"), longEdge: .full))
        XCTAssertEqual(json["width"] as? Int, 64)
        XCTAssertEqual(json["height"] as? Int, 48)

        let tooWide = try makeImage(width: 65_536, height: 1, space: sRGB) { _, _ in [0.5, 0.5, 0.5] }
        let tooWideInput = try write(tooWide, type: .png, name: "too-wide.png")
        do {
            _ = try RasterCommand.run(RasterOptions(input: tooWideInput.path, out: out("too-wide.jpg"), longEdge: .full))
            XCTFail("a source dimension above JPEG's limit must be rejected")
        } catch let error as ToolError {
            XCTAssertEqual(error.code, "unsupported_dimensions")
        }
        XCTAssertFalse(RasterCommand.exceedsJPEGDimensionLimit(width: 65_535, height: 65_535))
    }

    func testDecodePixelLimitUsesOverflowSafePropertyDimensions() {
        XCTAssertFalse(RasterCommand.exceedsDecodePixelLimit(width: 5000, height: 8000))
        XCTAssertTrue(RasterCommand.exceedsDecodePixelLimit(width: 5000, height: 8001))
        XCTAssertTrue(RasterCommand.exceedsDecodePixelLimit(width: UInt64.max, height: 2))
        XCTAssertTrue(RasterCommand.exceedsDecodePixelLimit([
            kCGImagePropertyPixelWidth as String: NSNumber(value: 10_000),
            kCGImagePropertyPixelHeight as String: NSNumber(value: 4_001),
        ]))
        XCTAssertFalse(RasterCommand.exceedsDecodePixelLimit([
            kCGImagePropertyPixelWidth as String: NSNumber(value: 10_000),
            kCGImagePropertyPixelHeight as String: NSNumber(value: 4_000),
        ]))
    }

    /// `--long-edge full` keeps every pixel, so a 48MP photo is ordinary input
    /// (the 40MP working-copy cap would make it `decode_failed`); the wider cap
    /// still bounds a decompression bomb.
    func testFullSizeUsesTheWiderDecodePixelLimit() {
        XCTAssertEqual(RasterCommand.decodePixelLimit(for: .pixels(2560)), RasterCommand.maxDecodePixels)
        XCTAssertEqual(RasterCommand.decodePixelLimit(for: .full), RasterCommand.maxFullSizeDecodePixels)
        let fullLimit = RasterCommand.decodePixelLimit(for: .full)
        // 8000 x 6000 (48MP): over the working-copy cap, within the full-size cap.
        XCTAssertTrue(RasterCommand.exceedsDecodePixelLimit(width: 8000, height: 6000))
        XCTAssertFalse(RasterCommand.exceedsDecodePixelLimit(width: 8000, height: 6000, limit: fullLimit))
        XCTAssertFalse(RasterCommand.exceedsDecodePixelLimit(width: 20_000, height: 10_000, limit: fullLimit))
        XCTAssertTrue(RasterCommand.exceedsDecodePixelLimit(width: 20_000, height: 10_001, limit: fullLimit))
        XCTAssertTrue(RasterCommand.exceedsDecodePixelLimit(width: UInt64.max, height: 2, limit: fullLimit))
    }

    /// 1px black / white columns halved: the linear mean (0.5 → sRGB 188),
    /// not the gamma-encoded mean (128).
    func testDownscalesInLinearLight() throws {
        let image = try makeImage(width: 64, height: 64, space: sRGB) { x, _ in
            x.isMultiple(of: 2) ? [1, 1, 1] : [0, 0, 0]
        }
        let input = try write(image, type: .png, name: "stripes.png")
        let json = try run(RasterOptions(input: input.path, out: out("wc.jpg"), longEdge: .pixels(32)))
        XCTAssertEqual(json["width"] as? Int, 32)
        XCTAssertEqual(json["height"] as? Int, 32)
        let decoded = try pixels(URL(fileURLWithPath: out("wc.jpg")), in: sRGB)
        var sum = 0
        var count = 0
        for y in 2 ..< 30 {
            for x in 2 ..< 30 {
                sum += pixel(decoded, x, y)[1]
                count += 1
            }
        }
        let mean = Double(sum) / Double(count)
        XCTAssertEqual(mean, 188, accuracy: 6, "linear mean; gamma-space scaling gives about 128")
    }

    // MARK: preview

    func testPreviewIsSRGBAndSmall() throws {
        let color = [0.95, 0.12, 0.06]
        let image = try makeImage(width: 1500, height: 1000, space: displayP3) { x, y in
            x < 750 ? color : [Double(x) / 1499, Double(y) / 999, 0.4]
        }
        let input = try write(image, type: .png, name: "big.png", properties: privateMetadata)
        let json = try run(RasterOptions(
            input: input.path, out: out("wc.jpg"), previewOut: out("preview.jpg"), meta: out("wc.json")
        ))
        XCTAssertEqual(json["width"] as? Int, 1500, "under the default long edge")
        let preview = try XCTUnwrap(json["preview"] as? [String: Int])
        XCTAssertEqual(preview["width"], 1024)
        XCTAssertEqual(preview["height"], 683)
        let previewURL = URL(fileURLWithPath: out("preview.jpg"))
        XCTAssertEqual(preview["bytes"].map(Int64.init), FileWriting.fileSize(previewURL))
        XCTAssertLessThanOrEqual(try XCTUnwrap(preview["bytes"]), 1 << 20)
        try assertICCOnlyJPEG(previewURL, icc: false)

        // Converted to sRGB (the P3 color clipped the way CoreGraphics converts it), not tagged P3.
        let one = try makeImage(width: 1, height: 1, space: displayP3) { _, _ in color }
        let expected = try pixels(write(one, type: .png, name: "one.png"), in: sRGB)
        assertClose(pixel(try pixels(previewURL, in: sRGB), 200, 340), pixel(expected, 0, 0), tolerance: 4)

        // --meta: the same JSON as stdout.
        let meta = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: out("wc.json")))) as? [String: Any]
        )
        XCTAssertEqual(JSONOutput.singleLine(meta), JSONOutput.singleLine(json))
        XCTAssertEqual(try files(), ["big.png", "one.png", "preview.jpg", "wc.jpg", "wc.json"])
    }

    func testPreviewQualityLadder() throws {
        let sizes: [Double: Int] = [0.85: 3_000_000, 0.72: 1_200_000, 0.6: 1_048_576, 0.45: 500_000]
        var tried: [Double] = []
        let fitted = try RasterWorkingCopy.fitting(qualities: RasterWorkingCopy.previewQualities, maxBytes: 1 << 20) { quality in
            tried.append(quality)
            return Data(count: sizes[quality]!)
        }
        XCTAssertEqual(fitted.quality, 0.6, "1 MiB exactly fits")
        XCTAssertEqual(tried, [0.85, 0.72, 0.6])
        XCTAssertEqual(RasterWorkingCopy.previewQualities, [0.85, 0.72, 0.6, 0.45])
        XCTAssertEqual(RasterWorkingCopy.previewMaxBytes, 1_048_576)

        XCTAssertThrowsError(try RasterWorkingCopy.fitting(qualities: [0.85, 0.45], maxBytes: 10) { _ in Data(count: 11) }) { error in
            XCTAssertEqual((error as? ToolError)?.code, "encode_failed")
            XCTAssertEqual((error as? ToolError)?.exitCode, 4)
        }
    }

    // MARK: determinism and failures

    func testSameInputGivesTheSameBytes() throws {
        let image = try makeImage(width: 1300, height: 900, space: displayP3) { x, y in
            [Double(x % 97) / 96, Double(y % 53) / 52, Double((x + y) % 31) / 30]
        }
        let input = try write(image, type: .png, name: "noise.png")
        var runs: [(Data, Data, String)] = []
        for round in 0 ..< 2 {
            let json = try run(RasterOptions(
                input: input.path, out: out("wc\(round).jpg"), previewOut: out("preview\(round).jpg"), longEdge: .pixels(1100)
            ))
            runs.append((
                try Data(contentsOf: URL(fileURLWithPath: out("wc\(round).jpg"))),
                try Data(contentsOf: URL(fileURLWithPath: out("preview\(round).jpg"))),
                JSONOutput.singleLine(json)
            ))
        }
        XCTAssertEqual(runs[0].0, runs[1].0, "working copy")
        XCTAssertEqual(runs[0].1, runs[1].1, "preview")
        XCTAssertEqual(runs[0].2, runs[1].2, "metadata")
    }

    /// Core Image gets a plain copy of ImageIO's decoded bytes (not the
    /// decoder's surface, whose conversion varied from run to run).
    func testDecodedPixelsAreMaterialized() throws {
        let image = try makeImage(width: 32, height: 24, space: displayP3, bits: 16) { x, y in
            [Double(x) / 31, Double(y) / 23, 0.25]
        }
        let input = try write(image, type: .png, name: "p3.png")
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let copy = try RasterCommand.materialize(decoded, url: input)
        XCTAssertEqual(copy.width, 32)
        XCTAssertEqual(copy.height, 24)
        XCTAssertEqual(copy.bitsPerComponent, decoded.bitsPerComponent)
        XCTAssertEqual(copy.bitmapInfo, decoded.bitmapInfo)
        XCTAssertEqual(copy.colorSpace?.name, CGColorSpace.displayP3)
        XCTAssertEqual(copy.dataProvider?.data as Data?, decoded.dataProvider?.data as Data?)
    }

    func testFailuresLeaveNoFile() throws {
        let image = try makeImage(width: 16, height: 16, space: sRGB) { _, _ in [0.5, 0.5, 0.5] }
        let input = try write(image, type: .png, name: "ok.png")
        let text = directory.appendingPathComponent("note.txt")
        try Data("not an image".utf8).write(to: text)
        let empty = directory.appendingPathComponent("empty.heic")
        try Data().write(to: empty)
        let truncated = directory.appendingPathComponent("truncated.png")
        try Data(try Data(contentsOf: input).prefix(24)).write(to: truncated)
        let before = try files()

        func failure(_ options: RasterOptions) -> ToolError? {
            do {
                _ = try RasterCommand.run(options)
                return nil
            } catch {
                return error as? ToolError
            }
        }
        let outPath = out("wc.jpg")
        XCTAssertEqual(failure(RasterOptions(input: out("missing.heic"), out: outPath))?.code, "input_not_found")
        for path in [text.path, empty.path, truncated.path] {
            let error = failure(RasterOptions(input: path, out: outPath))
            XCTAssertEqual(error?.code, "decode_failed", path)
            XCTAssertEqual(error?.exitCode, 4, path)
        }
        XCTAssertEqual(failure(RasterOptions(input: input.path, out: input.path))?.code, "invalid_arguments")
        XCTAssertEqual(failure(RasterOptions(input: input.path, out: outPath, previewOut: outPath))?.code, "invalid_arguments")
        XCTAssertEqual(failure(RasterOptions(input: input.path, out: outPath, meta: input.path))?.code, "invalid_arguments")
        XCTAssertEqual(failure(RasterOptions(input: input.path, out: text.path + "/wc.jpg"))?.code, "write_failed")
        XCTAssertEqual(try files(), before, "no output and no partial file")
    }

    // MARK: JPEG segments

    func testJPEGSegmentsKeepOnlyTheICC() throws {
        func segment(_ marker: UInt8, _ payload: [UInt8]) -> [UInt8] {
            let length = payload.count + 2
            return [0xFF, marker, UInt8(length >> 8), UInt8(length & 0xFF)] + payload
        }
        let icc = (0 ..< 300).map { UInt8($0 % 251) }
        let signature = Array("ICC_PROFILE".utf8) + [0]
        let jfif = segment(0xE0, Array("JFIF".utf8) + [0, 1, 1, 0, 0, 72, 0, 72, 0, 0])
        let exif = segment(0xE1, Array("Exif".utf8) + [0, 0, 1, 2, 3])
        let xmp = segment(0xE1, Array("http://ns.adobe.com/xap/1.0/".utf8) + [0, 9])
        let photoshop = segment(0xED, Array("Photoshop 3.0".utf8) + [0, 1])
        let comment = segment(0xFE, Array("hello".utf8))
        // The ICC in two chunks, stored out of order.
        let icc2 = segment(0xE2, signature + [2, 2] + Array(icc[200...]))
        let icc1 = segment(0xE2, signature + [1, 2] + Array(icc[..<200]))
        let quantization = segment(0xDB, [0] + Array(repeating: 1, count: 64))
        let scan: [UInt8] = [0xFF, 0xDA, 0x00, 0x02, 0x12, 0x34, 0xFF, 0xD9]
        let jpeg = Data([0xFF, 0xD8] + jfif + exif + icc2 + xmp + icc1 + photoshop + comment + quantization + scan)

        XCTAssertEqual(JPEGSegments.iccProfile(in: jpeg), Data(icc))
        let kept = try JPEGSegments.strippingMetadata(jpeg, keepICC: true)
        XCTAssertEqual(kept, Data([0xFF, 0xD8] + jfif + icc2 + icc1 + quantization + scan))
        XCTAssertEqual(JPEGSegments.iccProfile(in: kept), Data(icc))
        let bare = try JPEGSegments.strippingMetadata(jpeg, keepICC: false)
        XCTAssertEqual(bare, Data([0xFF, 0xD8] + jfif + quantization + scan))
        XCTAssertNil(JPEGSegments.iccProfile(in: bare))

        // A missing chunk is no profile; a broken stream is encode_failed.
        XCTAssertNil(JPEGSegments.iccProfile(in: Data([0xFF, 0xD8] + icc2 + scan)))
        XCTAssertThrowsError(try JPEGSegments.strippingMetadata(Data([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x40]), keepICC: false)) { error in
            XCTAssertEqual((error as? ToolError)?.code, "encode_failed")
        }
        XCTAssertThrowsError(try JPEGSegments.strippingMetadata(Data("not a jpeg".utf8), keepICC: false))
    }
}
