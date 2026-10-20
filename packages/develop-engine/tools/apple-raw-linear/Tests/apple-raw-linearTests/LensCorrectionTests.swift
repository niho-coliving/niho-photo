import XCTest
@testable import apple_raw_linear

final class LensCorrectionTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"),
            "missing fixture \(name)"
        ).path
    }

    /// A TIFF with IFD0 → SubIFD (0x014A) holding the Sony lens tags as SSHORT arrays.
    private func sonyTIFF(littleEndian: Bool, distortion: [Int], vignetting: [Int]?) -> Data {
        var bytes: [UInt8] = []
        func u16(_ v: Int) { let x = UInt16(truncatingIfNeeded: v); bytes += littleEndian ? [UInt8(x & 0xFF), UInt8(x >> 8)] : [UInt8(x >> 8), UInt8(x & 0xFF)] }
        func u32(_ v: Int) { let x = UInt32(v); u16(Int(littleEndian ? x & 0xFFFF : x >> 16)); u16(Int(littleEndian ? x >> 16 : x & 0xFFFF)) }
        bytes += littleEndian ? [0x49, 0x49] : [0x4D, 0x4D]
        u16(42)
        u32(8)
        // IFD0 at 8: 1 entry (SubIFD LONG[1]) + next 0 → 8 + 2 + 12 + 4 = 26
        let subOffset = 26
        u16(1)
        u16(0x014A); u16(4); u32(1); u32(subOffset)
        u32(0)
        let entries = vignetting == nil ? 1 : 2
        let dataStart = subOffset + 2 + entries * 12 + 4
        let dValues = [distortion.count] + distortion
        let vValues = vignetting.map { [$0.count] + $0 } ?? []
        u16(entries)
        u16(0x7037); u16(8); u32(dValues.count); u32(dataStart)
        if vignetting != nil {
            u16(0x7032); u16(8); u32(vValues.count); u32(dataStart + dValues.count * 2)
        }
        u32(0)
        for v in dValues { u16(v) }
        for v in vValues { u16(v) }
        return Data(bytes)
    }

    func testReadsSonyTagsInBothByteOrders() throws {
        let distortion = [-1, -35, -134, -285, -474, -694, -936, -1197, -1468, -1747, -2027]
        let vignetting = [0, 64, 256, 592, 1104, 1792, 3376, 5424, 8432, 11968, 16224]
        for littleEndian in [true, false] {
            let params = try XCTUnwrap(SonyLensParams.parse(data: sonyTIFF(littleEndian: littleEndian, distortion: distortion, vignetting: vignetting)))
            XCTAssertEqual(params.distortion, distortion)
            XCTAssertEqual(params.vignetting, vignetting)
            XCTAssertNil(params.chromaticAberration)
        }
        let noVignetting = try XCTUnwrap(SonyLensParams.parse(data: sonyTIFF(littleEndian: true, distortion: distortion, vignetting: nil)))
        XCTAssertNil(noVignetting.vignetting)
    }

    func testNonTIFFAndMissingDataAreNil() {
        XCTAssertNil(SonyLensParams.parse(data: Data([0x00, 0x01, 0x02])))
        XCTAssertNil(SonyLensParams.parse(data: Data("not a tiff at all".utf8)))
        XCTAssertNil(SonyLensParams.counted([11, 1, 2]))   // shorter than its count
        XCTAssertNil(SonyLensParams.counted([1, 5]))       // one knot is not a curve
        XCTAssertEqual(SonyLensParams.counted([2, 7, 8, 0, 0]), [7, 8])
    }

    func testFactorAndGainFormulas() {
        let f = EmbeddedLensCorrection.distortionFactors([-1, -35, -2027])
        XCTAssertEqual(f[0], 1 - 1 / 16384.0, accuracy: 1e-12)
        XCTAssertEqual(f[2], 1 - 2027 / 16384.0, accuracy: 1e-12)
        // A first value that breaks the series is taken as 0.
        XCTAssertEqual(EmbeddedLensCorrection.distortionFactors([834, -35, -134])[0], 1)
        let g = EmbeddedLensCorrection.vignettingGains([0, 16224])
        XCTAssertEqual(g[0], 1, accuracy: 1e-12)
        XCTAssertEqual(g[1], 2.7762, accuracy: 1e-3)
    }

    func testInterpolationPassesThroughKnotsAndClamps() {
        let f = [1.0, 0.99, 0.95, 0.9, 0.8]
        for (i, value) in f.enumerated() {
            XCTAssertEqual(EmbeddedLensCorrection.catmullRom(f, Double(i) / 4), value, accuracy: 1e-12)
        }
        XCTAssertEqual(EmbeddedLensCorrection.catmullRom(f, 2), 0.8, accuracy: 1e-12)
        let line = [1.0, 2.0, 3.0]
        XCTAssertEqual(EmbeddedLensCorrection.catmullRom(line, 0.25), 1.5, accuracy: 1e-12)
        XCTAssertEqual(EmbeddedLensCorrection.linear(line, 0.75), 2.5, accuracy: 1e-12)
        XCTAssertEqual(EmbeddedLensCorrection.linear(line, -1), 1, accuracy: 1e-12)
    }

    func testFrameScaleFillsTheFrame() {
        XCTAssertEqual(EmbeddedLensCorrection.frameScale(width: 60, height: 40, radius: 36, factors: [1, 1, 1]), 1, accuracy: 1e-12)
        // Barrel correction (factors < 1 at the edge) needs k > 1, and with k no
        // border pixel reads outside the source.
        let factors = [1.0, 0.97, 0.9]
        let (w, h) = (60, 40)
        let radius = hypot(Double(w) / 2, Double(h) / 2)
        let k = EmbeddedLensCorrection.frameScale(width: w, height: h, radius: radius, factors: factors)
        XCTAssertGreaterThan(k, 1)
        let cx = Double(w - 1) / 2, cy = Double(h - 1) / 2
        for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w / 2, 0), (0, h / 2)] {
            let px = Double(x) - cx, py = Double(y) - cy
            let s = EmbeddedLensCorrection.sourceScale(factors: factors, radius: radius, frameScale: k, distance: hypot(px, py))
            XCTAssertLessThanOrEqual(abs(px * s), cx + 1e-9)
            XCTAssertLessThanOrEqual(abs(py * s), cy + 1e-9)
        }
    }

    func testFrameScaleIsAFixedPointAndTouchesTheFrame() {
        // Pincushion (factors > 1 at the edge, a tele end) needs k < 1. The
        // knots are looked up at |p| * k / R, so k must reproduce itself, and
        // at least one border pixel reads exactly on the source edge.
        let factors = [1.0, 1.005, 1.012, 1.02, 1.032]
        let (w, h) = (60, 40)
        let radius = hypot(Double(w) / 2, Double(h) / 2) * 1.01
        let k = EmbeddedLensCorrection.frameScale(width: w, height: h, radius: radius, factors: factors)
        XCTAssertLessThan(k, 1)
        let cx = Double(w - 1) / 2, cy = Double(h - 1) / 2
        var worst = 0.0
        for x in 0 ..< w {
            for y in [0, h - 1] {
                let px = Double(x) - cx, py = Double(y) - cy
                let s = EmbeddedLensCorrection.sourceScale(factors: factors, radius: radius, frameScale: k, distance: hypot(px, py))
                XCTAssertLessThanOrEqual(abs(px * s), cx + 1e-9)
                XCTAssertLessThanOrEqual(abs(py * s), cy + 1e-9)
                worst = max(worst, abs(px * s) / cx, abs(py * s) / cy)
            }
        }
        for y in 0 ..< h {
            for x in [0, w - 1] {
                let px = Double(x) - cx, py = Double(y) - cy
                let s = EmbeddedLensCorrection.sourceScale(factors: factors, radius: radius, frameScale: k, distance: hypot(px, py))
                worst = max(worst, abs(px * s) / cx, abs(py * s) / cy)
            }
        }
        XCTAssertEqual(worst, 1, accuracy: 1e-9)
    }

    private func image(width: Int, height: Int, _ value: (Int, Int) -> Float) -> UnsafeMutablePointer<Float> {
        let p = UnsafeMutablePointer<Float>.allocate(capacity: width * height * 4)
        for y in 0 ..< height {
            for x in 0 ..< width {
                let v = value(x, y), base = (y * width + x) * 4
                p[base] = v; p[base + 1] = v * 0.5; p[base + 2] = v * 0.25; p[base + 3] = 1
            }
        }
        return p
    }

    func testZeroDistortionIsIdentity() {
        let (w, h) = (31, 21)
        let pixels = image(width: w, height: h) { x, y in Float(x * 7 + y * 3) / 100 }
        defer { pixels.deallocate() }
        let original = Array(UnsafeBufferPointer(start: pixels, count: w * h * 4))
        let applied = EmbeddedLensCorrection.apply(
            to: pixels, width: w, height: h,
            params: SonyLensParams(distortion: Array(repeating: 0, count: 11), vignetting: nil, chromaticAberration: nil),
            settings: LensSettings.sonyDefault
        )
        XCTAssertEqual(applied.frameScale, 1, accuracy: 1e-12)
        for i in 0 ..< w * h * 4 {
            XCTAssertEqual(pixels[i], original[i], accuracy: 1e-5)
        }
    }

    func testVignettingBrightensTheCornersOnly() {
        let (w, h) = (41, 27)
        let pixels = image(width: w, height: h) { _, _ in 0.2 }
        defer { pixels.deallocate() }
        let values = [0, 64, 256, 592, 1104, 1792, 3376, 5424, 8432, 11968, 16224]
        _ = EmbeddedLensCorrection.apply(
            to: pixels, width: w, height: h,
            params: SonyLensParams(distortion: Array(repeating: 0, count: 11), vignetting: values, chromaticAberration: nil),
            settings: LensSettings(distortionRadiusScale: 1, vignettingRadiusScale: 1, vignetting: true)
        )
        let centre = pixels[((h / 2) * w + w / 2) * 4]
        let corner = pixels[0]
        // The corner pixel centre sits at 0.97 of the half-diagonal (between the last two knots).
        let r = hypot(Double(w - 1) / 2, Double(h - 1) / 2) / hypot(Double(w) / 2, Double(h) / 2)
        let expected = 0.2 * EmbeddedLensCorrection.linear(EmbeddedLensCorrection.vignettingGains(values), r)
        XCTAssertEqual(centre, 0.2, accuracy: 1e-4)
        XCTAssertGreaterThan(expected, 0.2 * 2.4)
        XCTAssertEqual(Double(corner), expected, accuracy: 1e-4)
        XCTAssertEqual(pixels[3], 1)   // alpha kept
    }

    func testLensModeDecidesCoreImageFlagAndComparedSetting() {
        let options = RenderOptions(input: "x.ARW", out: "x.tiff")
        XCTAssertEqual(options.lensCorrection, .auto)
        let apple = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1)
        XCTAssertTrue(apple.isLensCorrectionEnabled)
        let embedded = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1, lensMode: .embedded)
        XCTAssertFalse(embedded.isLensCorrectionEnabled)
        XCTAssertEqual(embedded.calibrationComparable["lensCorrection"], .bool(true))
        let off = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1, lensMode: .off)
        XCTAssertFalse(off.isLensCorrectionEnabled)
        XCTAssertEqual(off.calibrationComparable["lensCorrection"], .bool(false))
    }

    func testParsesLensModes() throws {
        for (value, mode) in [("on", LensCorrectionMode.apple), ("apple", .apple), ("embedded", .embedded), ("off", .off), ("auto", .auto)] {
            let command = try ArgumentParser.parse(["render", "a.ARW", "--out", "a.png", "--lens-correction", value])
            guard case let .render(options) = command else { return XCTFail("\(command)") }
            XCTAssertEqual(options.lensCorrection, mode)
        }
        XCTAssertThrowsError(try ArgumentParser.parse(["render", "a.ARW", "--out", "a.png", "--lens-correction", "yes"]))
    }

    func testCalibrationLensSection() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-lens"))
        XCTAssertEqual(calibration.lensMode, .embedded)
        XCTAssertEqual(calibration.lensSettings, LensSettings(distortionRadiusScale: 0.95, vignettingRadiusScale: 1.2, vignetting: false))
        let lens = try XCTUnwrap(calibration.metadataSource["lens"] as? [String: Any])
        XCTAssertEqual(lens["mode"] as? String, "embedded")
        XCTAssertNil(try Calibration.load(path: try fixture("calibration-identity")).lensMode)
        XCTAssertThrowsError(try Calibration.load(path: try fixture("calibration-lens-bad")))
    }
}
