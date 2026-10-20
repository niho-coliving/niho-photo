// Photo Bench references for the RAW working-copy golden (macOS only).
//
// Built and run by scripts/golden/make_raw_references.py against Photo Bench's
// own sources (PHOTOBENCH_DIR, the commit photobench-engine was packaged from):
// it renders with PhotoCore's RAW production path, `AdobeBaseRenderer.Handle
// .image(settings:)` through `RenderEngine.exportTIFF` (`.final`, the output
// transform, sRGB 16-bit), from a working copy instead of Photo Bench's own
// LibRaw + DCP decode. photobench-engine cannot do that: its `export` always
// re-decodes the RAW through LibRaw and the Adobe DCP with the Adobe Color
// look, a different stage 1 than `renderWorkingCopy`.
//
//   raw-reference wc  <raw> <wc.png> <wc.json> <cases.json> <out-dir>
//     The working copy (`renderWorkingCopy`: macOS RAW, linear ProPhoto,
//     16-bit PNG) becomes the handle's camera image with an identity
//     Stage M, no DCP HueSatMap / LookTable, an identity look and variant
//     `.c` (no Adobe Color point curve): the handle then runs exactly stage
//     2's RAW order (exposure 2^(baselineEV + exposure) -> [S] -> look
//     (identity cube) -> ACR3 -> P -> Calibration -> Q -> sRGB -> relative
//     WB -> output transform). Also writes <out-dir>/wc.f32 (the working
//     copy before the PNG quantization, as Photo Bench's working-copy code
//     renders it) for the crate's quantization measurement.
//   raw-reference dcp <raw> <cases.json> <out-dir> [maxDimension]
//     Photo Bench's own LibRaw + Adobe DCP decode (the camera's DCP without
//     its LookTable, an identity look, variant `.c`), reduced to
//     maxDimension (2560) like a preview working copy. Writes the working
//     copy the original spec described (Stage H output, before exposure) as
//     wc.png / wc.json / wc.f32 and renders the cases from the same handle:
//     the absolute white balance there re-derives Stage M / H at the new
//     white (the crate approximates it with a CAT from the as-shot white).
//
// cases.json: {"cases": [{"name": "...", "settings": <EditSettings JSON>}]}.
// Every case is written as <out-dir>/<name>.png (16-bit sRGB RGBA).
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
@testable import PhotoCore

struct Case: Decodable {
    let name: String
    let settings: EditSettings
}

struct Cases: Decodable {
    let cases: [Case]
}

enum HarnessError: Error, CustomStringConvertible {
    case usage
    case message(String)
    var description: String {
        switch self {
        case .usage:
            "usage: raw-reference wc <raw> <wc.png> <wc.json> <cases.json> <out> | dcp <raw> <cases.json> <out> [max]"
        case let .message(m): m
        }
    }
}

let identity3 = Matrix3x3(1, 0, 0, 0, 1, 0, 0, 0, 1)

/// Adobe Color's look with every entry the identity (the look stage of the
/// handle stays a cube, as NIHO's `niho-interim-1` is the identity).
func identityLook(_ locator: AdobeProfileLocator) throws -> AdobeLookXMP {
    guard let url = locator.locateAdobeColorLookXMP() else {
        throw HarnessError.message("Adobe Color.xmp not found (install Lightroom or DNG Converter)")
    }
    var look = try AdobeLookXMP(contentsOf: url)
    look.lookTableData.entries = look.lookTableData.entries.map { _ in
        DCPProfile.HueSatEntry(hueShift: 0, satScale: 1, valScale: 1)
    }
    return look
}

/// Reads a working copy PNG (16-bit RGB, no color chunks) into RGBA float
/// linear ProPhoto, decoding each code as the protocol does.
func readWorkingCopy(_ url: URL) throws -> (width: Int, height: Int, rgba: [Float], codes: [Int]) {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.bitsPerComponent == 16,
          let data = image.dataProvider?.data as Data?
    else {
        throw HarnessError.message("cannot read 16-bit PNG \(url.path)")
    }
    let (width, height) = (image.width, image.height)
    let channels = image.bitsPerPixel / 16
    let bigEndian = image.bitmapInfo.contains(.byteOrder16Big)
        || !image.bitmapInfo.contains(.byteOrder16Little)
    var lut = [Float](repeating: 0, count: 65_536)
    for code in 0..<65_536 {
        lut[code] = Float(WorkingCopyRenderer.decodedSample(UInt16(code)))
    }
    var rgba = [Float](repeating: 1, count: width * height * 4)
    var codes = [Int](repeating: 0, count: width * height * 3)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        for y in 0..<height {
            let row = raw.baseAddress! + y * image.bytesPerRow
            for x in 0..<width {
                for c in 0..<3 {
                    let v = row.loadUnaligned(fromByteOffset: (x * channels + c) * 2, as: UInt16.self)
                    let code = Int(bigEndian ? UInt16(bigEndian: v) : UInt16(littleEndian: v))
                    codes[(y * width + x) * 3 + c] = code
                    rgba[(y * width + x) * 4 + c] = lut[code]
                }
            }
        }
    }
    return (width, height, rgba, codes)
}

func ciImage(rgba: [Float], width: Int, height: Int) -> CIImage {
    CIImage(
        bitmapData: rgba.withUnsafeBufferPointer { Data(buffer: $0) },
        bytesPerRow: width * 16,
        size: CGSize(width: width, height: height),
        format: .RGBAf,
        colorSpace: nil
    )
}

/// `wc.f32`: "NIHOWCF1", width, height (u32 LE), then RGB f32 LE rows.
func writeF32(_ pixels: PreviewWorkingRaster.RenderedPixels, to url: URL) throws {
    var out = Data("NIHOWCF1".utf8)
    for v in [UInt32(pixels.width), UInt32(pixels.height)] {
        withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) }
    }
    let stride = pixels.rowBytes / 4
    pixels.data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let f = raw.bindMemory(to: Float.self)
        var row = [Float](repeating: 0, count: pixels.width * 3)
        for y in 0..<pixels.height {
            for x in 0..<pixels.width {
                for c in 0..<3 {
                    row[x * 3 + c] = f[y * stride + x * 4 + c]
                }
            }
            row.withUnsafeBufferPointer { out.append(Data(buffer: $0)) }
        }
    }
    try out.write(to: url)
}

/// Renders every case through `exportTIFF` and rewrites the 16-bit TIFF as
/// a 16-bit PNG (same samples) for the crate's test.
func renderCases(_ decoded: DecodedPhoto, cases: [Case], out: URL) throws {
    let engine = RenderEngine()
    for c in cases {
        let tiff = out.appendingPathComponent(".\(c.name).tif")
        let started = Date()
        _ = try engine.exportTIFF(decoded: decoded, settings: c.settings, destination: tiff)
        guard let source = CGImageSourceCreateWithURL(tiff as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw HarnessError.message("cannot read back \(tiff.path)")
        }
        let png = out.appendingPathComponent("\(c.name).png")
        guard let destination = CGImageDestinationCreateWithURL(png as CFURL, UTType.png.identifier as CFString, 1, nil)
        else {
            throw HarnessError.message("cannot write \(png.path)")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw HarnessError.message("cannot write \(png.path)")
        }
        try? FileManager.default.removeItem(at: tiff)
        print("wrote \(png.path) (\(image.width)x\(image.height), \(image.bitsPerComponent)-bit, \(Int(Date().timeIntervalSince(started) * 1000)) ms)")
    }
}

func decodedPhoto(url: URL, handle: AdobeBaseRenderer.Handle, width: Int, height: Int) -> DecodedPhoto {
    DecodedPhoto(
        sourceURL: url,
        image: handle.image(userExposureEV: 0),
        metadata: [:],
        info: DecodeInfo(
            backend: "niho-raw-golden",
            width: width,
            height: height,
            durationMilliseconds: 0,
            isRAW: true,
            isBoundedSRGBRaster: false,
            intent: .fullResolution,
            appliedScaleFactor: 1,
            asShotWhiteXY: handle.assets.whiteXY
        ),
        adobeBase: handle
    )
}

/// `WorkingCopyRenderer.render`'s steps 1-3 for a RAW (its private
/// `openRAW`: CIRAWFilter RAW 8, the flat calibration baseline) up to the
/// float pixels it encodes, so the crate can measure the PNG quantization.
func workingCopyPixels(raw: URL, maxDimension: Int) throws -> PreviewWorkingRaster.RenderedPixels {
    guard let filter = CIRAWFilter(imageURL: raw),
          let version = WorkingCopyRenderer.selectRAWDecoderVersion(supported: filter.supportedDecoderVersions)
    else {
        throw HarnessError.message("macOS RAW cannot open \(raw.lastPathComponent)")
    }
    filter.decoderVersion = version
    let configuration = RAWDecodeConfiguration.calibrationBaseline
    filter.exposure = configuration.exposure
    filter.shadowBias = configuration.shadowBias
    filter.boostAmount = configuration.boostAmount
    filter.boostShadowAmount = configuration.boostShadowAmount
    filter.extendedDynamicRangeAmount = configuration.extendedDynamicRangeAmount
    filter.scaleFactor = 1
    filter.isGamutMappingEnabled = true
    guard let image = filter.outputImage else {
        throw HarnessError.message("macOS RAW cannot render \(raw.lastPathComponent)")
    }
    let linear = IdentityWorkingCopyCalibration().apply(
        to: AdobeBaseRenderer.applyMatrix(DNGColorSpace.srgbLinearToProPhoto, to: image)
    )
    let clipped = linear.applyingFilter("CIColorClamp", parameters: [
        "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
        "inputMaxComponents": CIVector(x: 1.0e6, y: 1.0e6, z: 1.0e6, w: 1),
    ])
    let raster = PreviewWorkingRaster(
        context: CIContext(mtlDevice: MTLCreateSystemDefaultDevice()!, options: PreviewWorkingRaster.contextOptions)
    )
    guard let pixels = raster.renderPixels(WorkingCopyRenderer.reduced(clipped, maxDimension: maxDimension)) else {
        throw HarnessError.message("cannot render the working copy of \(raw.lastPathComponent)")
    }
    return pixels
}

func runWorkingCopy(raw: URL, png: URL, meta: URL, cases: [Case], out: URL) throws {
    let metaJSON = try JSONSerialization.jsonObject(with: Data(contentsOf: meta)) as? [String: Any] ?? [:]
    let baselineEV = metaJSON["baselineEV"] as? Double ?? 0
    let wc = try readWorkingCopy(png)
    // The float working copy, checked against the engine's PNG codes.
    let pixels = try workingCopyPixels(raw: raw, maxDimension: max(wc.width, wc.height))
    guard pixels.width == wc.width, pixels.height == wc.height else {
        throw HarnessError.message("float working copy \(pixels.width)x\(pixels.height) != PNG \(wc.width)x\(wc.height)")
    }
    var differing = 0
    var maxCodeDifference = 0
    pixels.data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let f = raw.bindMemory(to: Float.self)
        let stride = pixels.rowBytes / 4
        for y in 0..<wc.height {
            for x in 0..<wc.width {
                for c in 0..<3 {
                    let code = Int(WorkingCopyRenderer.encodedSample(f[y * stride + x * 4 + c]))
                    let stored = wc.codes[(y * wc.width + x) * 3 + c]
                    if code != stored {
                        differing += 1
                        maxCodeDifference = max(maxCodeDifference, abs(code - stored))
                    }
                }
            }
        }
    }
    print("float working copy vs engine PNG: \(differing) samples differ (max \(maxCodeDifference) codes)")
    try writeF32(pixels, to: out.appendingPathComponent("wc.f32"))
    let locator = AdobeProfileLocator()
    // Any DCP satisfies AdobeBaseAssets' initializer; its matrices and
    // tables are then taken out (identity Stage M, no HueSatMap / LookTable).
    guard let located = locator.locateDCP(uniqueCameraModel: "Panasonic DC-S5") else {
        throw HarnessError.message("no DCP found to seed AdobeBaseAssets")
    }
    var dcp = located.profile
    dcp.hueSatMapData1 = nil
    dcp.hueSatMapData2 = nil
    dcp.lookTableData = nil
    var assets = try AdobeBaseAssets(
        dcp: dcp, look: try identityLook(locator), neutralG1: SIMD3(1, 1, 1), baselineEV: baselineEV
    )
    assets.combinedMatrix = identity3
    assets.huesatTable = nil
    let handle = AdobeBaseRenderer.makeHandle(
        cameraImage: ciImage(rgba: wc.rgba, width: wc.width, height: wc.height),
        assets: assets,
        cacheKey: AdobeBaseRenderer.CacheKey(
            dcpIdentity: "niho-working-copy-identity", lookIdentity: "identity",
            whiteXY: assets.whiteXY, exposureEV: baselineEV, variant: .c
        ),
        variant: .c
    )
    try renderCases(decodedPhoto(url: png, handle: handle, width: wc.width, height: wc.height), cases: cases, out: out)
}

func runDCP(raw: URL, cases: [Case], out: URL, maxDimension: Int) throws {
    let decoded = try LibRawDecoder().decode(url: raw)
    guard let base = decoded.adobeBase else {
        throw HarnessError.message("\(raw.lastPathComponent): no Adobe DCP (profile fallback)")
    }
    let locator = AdobeProfileLocator()
    var dcp = try DCPProfile(contentsOf: URL(fileURLWithPath: base.cacheKey.dcpIdentity))
    // NIHO has no DCP LookTable stage (README "忠実度") and no Adobe Color look.
    dcp.lookTableData = nil
    let assets = try AdobeBaseAssets(dcp: dcp, look: try identityLook(locator), neutralG1: base.assets.neutralG1)
    let full = AdobeBaseRenderer.makeHandle(
        cameraImage: base.cameraImage,
        assets: assets,
        cacheKey: AdobeBaseRenderer.CacheKey(
            dcpIdentity: base.cacheKey.dcpIdentity + "#noLookTable", lookIdentity: "identity",
            whiteXY: assets.whiteXY, exposureEV: assets.baselineEV, variant: .c
        ),
        variant: .c
    )
    let raster = PreviewWorkingRaster(
        context: CIContext(mtlDevice: MTLCreateSystemDefaultDevice()!, options: PreviewWorkingRaster.contextOptions)
    )
    guard let reduced = full.downscaled(maxDimension: CGFloat(maxDimension), using: raster) else {
        throw HarnessError.message("cannot reduce \(raw.lastPathComponent)")
    }
    // The working copy: Stage H's output, before exposure.
    guard let pixels = raster.renderPixels(reduced.image(through: .huesat)) else {
        throw HarnessError.message("cannot render the working copy")
    }
    try WorkingCopyRenderer.encodePNG16(pixels).write(to: out.appendingPathComponent("wc.png"))
    try writeF32(pixels, to: out.appendingPathComponent("wc.f32"))
    let meta: [String: Any] = [
        "kind": "raw",
        "engine": "photobench-libraw-dcp",
        "baselineEV": assets.baselineEV,
        "asShotWhite": ["x": assets.whiteXY.x, "y": assets.whiteXY.y],
        "dcpSha256": "",
        "lookTableIncluded": false,
        "dcp": base.cacheKey.dcpIdentity,
    ]
    try JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted, .sortedKeys])
        .write(to: out.appendingPathComponent("wc.json"))
    try renderCases(
        decodedPhoto(url: raw, handle: reduced, width: pixels.width, height: pixels.height),
        cases: cases, out: out
    )
}

func main() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let mode = args.first else { throw HarnessError.usage }
    func cases(_ path: String) throws -> [Case] {
        try JSONDecoder().decode(Cases.self, from: Data(contentsOf: URL(fileURLWithPath: path))).cases
    }
    switch mode {
    case "wc" where args.count == 6:
        let out = URL(fileURLWithPath: args[5])
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try runWorkingCopy(
            raw: URL(fileURLWithPath: args[1]), png: URL(fileURLWithPath: args[2]),
            meta: URL(fileURLWithPath: args[3]), cases: try cases(args[4]), out: out
        )
    case "dcp" where args.count == 4 || args.count == 5:
        let out = URL(fileURLWithPath: args[3])
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try runDCP(
            raw: URL(fileURLWithPath: args[1]), cases: try cases(args[2]), out: out,
            maxDimension: args.count == 5 ? Int(args[4])! : 2560
        )
    default:
        throw HarnessError.usage
    }
}

do {
    try main()
} catch {
    FileHandle.standardError.write(Data("raw-reference: \(error)\n".utf8))
    exit(1)
}
