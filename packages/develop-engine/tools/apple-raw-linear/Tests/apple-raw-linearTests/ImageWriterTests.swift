import CoreGraphics
import ImageIO
import XCTest
@testable import apple_raw_linear

/// Encode → ImageIO decode round trips for the three encodings.
final class ImageWriterTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-raw-linear-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// 3 x 2 pixels including negative, > 1 and tiny values (the float TIFF
    /// must keep all of them bit-exactly).
    private let width = 3
    private let height = 2
    private let rgb: [Float] = [
        0, 0.18, 1,
        -0.25, 1.125, 0.5,
        1e-5, 0.999, 2.5,
        0.1, 0.2, 0.3,
        0.4, 0.5, 0.6,
        -1e-3, 0.7, 1.0000001,
    ]

    private struct Decoded {
        let width: Int
        let height: Int
        let bitsPerComponent: Int
        let channels: Int
        let isFloat: Bool
        let colorSpaceName: String?
        let values: [Double]  // first 3 channels, row-major
    }

    private func decode(_ url: URL) throws -> Decoded {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let data = try XCTUnwrap(image.dataProvider?.data as Data?)
        let bpc = image.bitsPerComponent
        let channels = image.bitsPerPixel / bpc
        let info = image.bitmapInfo
        let isFloat = info.contains(.floatComponents)
        let byteOrder = info.intersection(.byteOrderMask)
        var values: [Double] = []
        data.withUnsafeBytes { bytes in
            for y in 0 ..< image.height {
                for x in 0 ..< image.width {
                    for c in 0 ..< 3 {
                        let offset = y * image.bytesPerRow + (x * channels + c) * bpc / 8
                        if bpc == 32, isFloat {
                            var bits = bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                            bits = byteOrder == .byteOrder32Big ? UInt32(bigEndian: bits) : UInt32(littleEndian: bits)
                            values.append(Double(Float(bitPattern: bits)))
                        } else if bpc == 16 {
                            var raw = bytes.loadUnaligned(fromByteOffset: offset, as: UInt16.self)
                            raw = byteOrder == .byteOrder16Little ? UInt16(littleEndian: raw) : UInt16(bigEndian: raw)
                            values.append(Double(raw))
                        }
                    }
                }
            }
        }
        return Decoded(
            width: image.width,
            height: image.height,
            bitsPerComponent: bpc,
            channels: channels,
            isFloat: isFloat,
            colorSpaceName: image.colorSpace?.name as String?,
            values: values
        )
    }

    func testFloat32TIFFRoundTripIsBitExact() throws {
        let url = directory.appendingPathComponent("f32.tiff")
        var pixels = rgb
        let colorSpace = OutputColorSpace.select(space: .linearProPhoto, encoding: .tiff32f)
        try pixels.withUnsafeMutableBytes { bytes in
            try ImageWriter.writeFloat32RGB(
                UnsafeRawPointer(bytes.baseAddress!),
                width: width,
                height: height,
                colorSpace: colorSpace.colorSpace,
                to: url
            )
        }
        let decoded = try decode(url)
        XCTAssertEqual(decoded.width, width)
        XCTAssertEqual(decoded.height, height)
        XCTAssertEqual(decoded.bitsPerComponent, 32)
        XCTAssertEqual(decoded.channels, 3)
        XCTAssertTrue(decoded.isFloat)
        XCTAssertEqual(decoded.values, rgb.map(Double.init))
        // No partial temp file is left behind.
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.contains(".partial-") }
        XCTAssertEqual(leftovers, [])
    }

    func testTIFF16ClipsAndQuantizes() throws {
        let url = directory.appendingPathComponent("u16.tiff")
        var rgba = rgbaBuffer()
        let transform = PixelTransform(matrix: .identity, encoding: .tiff16)
        _ = rgba.withUnsafeMutableBufferPointer { pointer in
            PixelPipeline.apply(transform, to: pointer.baseAddress!, width: width, height: height)
        }
        var packed = [UInt16](repeating: 0, count: width * height * 3)
        rgba.withUnsafeMutableBufferPointer { source in
            packed.withUnsafeMutableBufferPointer { destination in
                PixelPipeline.quantizeToUInt16RGB(
                    source.baseAddress!, width: width, height: height, into: destination.baseAddress!
                )
            }
        }
        let colorSpace = OutputColorSpace.select(space: .linearProPhoto, encoding: .tiff16)
        try packed.withUnsafeBytes { bytes in
            try ImageWriter.writeUInt16RGB(
                bytes.baseAddress!, width: width, height: height,
                colorSpace: colorSpace.colorSpace, container: .tiff, to: url
            )
        }
        let decoded = try decode(url)
        XCTAssertEqual(decoded.bitsPerComponent, 16)
        XCTAssertEqual(decoded.channels, 3)
        let expected = rgb.map { value -> Double in
            let clipped = Double(min(max(value, 0), 1))
            return (clipped * 65535).rounded()
        }
        XCTAssertEqual(decoded.values, expected)
    }

    /// The working copy (crate `decode.rs`): the PNG holds exactly the packed
    /// codes, `code = round((clip(x, 0, 2) / 2)^(1/1.8) · 65535)`, and
    /// `2 · (code / 65535)^1.8` gives the linear value back, including > 1.
    func testPNG16Gamma18IsTheWorkingCopyWithCeilingTwo() throws {
        let url = directory.appendingPathComponent("g18.png")
        var rgba = rgbaBuffer()
        let transform = PixelTransform(matrix: .identity, encoding: .png16g18)
        _ = rgba.withUnsafeMutableBufferPointer { pointer in
            PixelPipeline.apply(transform, to: pointer.baseAddress!, width: width, height: height)
        }
        var packed = [UInt16](repeating: 0, count: width * height * 3)
        rgba.withUnsafeMutableBufferPointer { source in
            packed.withUnsafeMutableBufferPointer { destination in
                PixelPipeline.quantizeToUInt16RGB(
                    source.baseAddress!, width: width, height: height, into: destination.baseAddress!
                )
            }
        }
        let colorSpace = OutputColorSpace.select(space: .linearProPhoto, encoding: .png16g18)
        XCTAssertEqual(colorSpace.colorSpace.name as String?, CGColorSpace.rommrgb as String)
        try packed.withUnsafeBytes { bytes in
            try ImageWriter.writeUInt16RGB(
                bytes.baseAddress!, width: width, height: height,
                colorSpace: colorSpace.colorSpace, container: .png, to: url
            )
        }
        let decoded = try decode(url)
        XCTAssertEqual(decoded.bitsPerComponent, 16)
        XCTAssertEqual(decoded.channels, 3)
        XCTAssertEqual(decoded.values, packed.map(Double.init), "the PNG stores the codes unchanged")
        for (index, value) in rgb.enumerated() {
            let code = UInt16(decoded.values[index])
            // Float pipeline vs the Double reference encoder: at most one step.
            let reference = Int(WorkingCopy.encode(Double(value)))
            XCTAssertLessThanOrEqual(abs(Int(code) - reference), 1, "channel \(index)")
            // One code step near 2.0 is 2 · 1.8 / 65535 ≈ 5.5e-5 in linear terms.
            let clipped = Double(min(max(value, 0), 2))
            XCTAssertEqual(WorkingCopy.decode(code), clipped, accuracy: 3e-5, "channel \(index)")
        }
        // 1.125 and 1.0000001 are kept (the old [0, 1] clip lost them); 2.5 → 2.
        XCTAssertGreaterThan(WorkingCopy.decode(UInt16(decoded.values[4])), 1.1)
        XCTAssertEqual(decoded.values[8], 65535)
        // The embedded ICC is ROMM RGB.
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        let profileName = properties?[kCGImagePropertyProfileName as String] as? String
        XCTAssertTrue(profileName?.contains("ROMM") ?? false, "profile: \(profileName ?? "nil")")
    }

    func testSignedPNG16RoundTripStoresCodesWithoutICCConversion() throws {
        let url = directory.appendingPathComponent("signed-g18.png")
        let rgba = rgbaBuffer()
        var packed = [UInt16](repeating: 0, count: width * height * 3)
        let encoding = try rgba.withUnsafeBufferPointer { source in
            try packed.withUnsafeMutableBufferPointer { destination in
                try SignedWorkingCopy.encode(
                    source,
                    width: width,
                    height: height,
                    into: destination
                )
            }
        }
        XCTAssertEqual(encoding.ceiling, 4)
        let colorSpace = OutputColorSpace.select(space: .linearProPhoto, encoding: .png16SignedG18)
        try packed.withUnsafeBytes { bytes in
            try ImageWriter.writeUInt16RGB(
                bytes.baseAddress!,
                width: width,
                height: height,
                colorSpace: colorSpace.colorSpace,
                container: .png,
                to: url
            )
        }
        let decoded = try decode(url)
        XCTAssertEqual(decoded.bitsPerComponent, 16)
        XCTAssertEqual(decoded.channels, 3)
        XCTAssertEqual(decoded.values, packed.map(Double.init), "ImageIO must not color-convert integer codes")
        XCTAssertEqual(decoded.values[0], 32_768)
        XCTAssertLessThan(decoded.values[3], 32_768)
        XCTAssertGreaterThan(decoded.values[4], 32_768)
    }

    func testLinearProPhotoColorSpaceIsD50Gamma1() throws {
        let space = try XCTUnwrap(OutputColorSpace.linearProPhoto())
        XCTAssertEqual(space.model, .rgb)
        let icc = try XCTUnwrap(space.copyICCData() as Data?)
        XCTAssertGreaterThan(icc.count, 128)
    }

    func testDefaultMetaPathReplacesExtension() {
        XCTAssertEqual(
            RenderCommand.defaultMetaURL(for: URL(fileURLWithPath: "/w/v8/P1.tiff")).path,
            "/w/v8/P1.json"
        )
        XCTAssertEqual(
            RenderCommand.defaultMetaURL(for: URL(fileURLWithPath: "/w/v8/P1")).path,
            "/w/v8/P1.json"
        )
        // With a working-copy meta, <stem>.json is the working copy's sidecar.
        XCTAssertEqual(
            RenderCommand.defaultMetaURL(for: URL(fileURLWithPath: "/w/wc/P1.png"), workingCopy: true).path,
            "/w/wc/P1.meta.json"
        )
    }

    private func rgbaBuffer() -> [Float] {
        var rgba: [Float] = []
        for index in 0 ..< width * height {
            rgba += [rgb[index * 3], rgb[index * 3 + 1], rgb[index * 3 + 2], 1]
        }
        return rgba
    }
}
