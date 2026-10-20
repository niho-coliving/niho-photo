import XCTest
@testable import apple_raw_linear

final class ColorMathTests: XCTestCase {
    /// `inv(M_pp_to_xyz_d50) · M_srgb_to_xyz_d50` computed with
    /// `numpy.linalg.inv` (Python 3.14 / numpy 2.3.5), float64.
    static let numpySRGBToProPhoto: [[Double]] = [
        [0.5293459266781221, 0.3300727993638261, 0.1405812739580515],
        [0.09837434248373353, 0.8734610239730559, 0.028164633543210686],
        [0.016883217605215644, 0.11767247124974249, 0.865444311145042],
    ]

    static let numpyProPhotoToSRGB: [[Double]] = [
        [2.0340759369045442, -0.7273342070033619, -0.3067417299011816],
        [-0.22881331966927385, 1.2317301572913437, -0.002916837622070277],
        [-0.00856983839680998, -0.15328656982819863, 1.1618564082250085],
    ]

    func testWhiteMapsToWhite() {
        let white = ColorMath.linearSRGBToLinearProPhoto.apply(SIMD3(1, 1, 1))
        XCTAssertEqual(white.x, 1, accuracy: 2e-3)
        XCTAssertEqual(white.y, 1, accuracy: 2e-3)
        XCTAssertEqual(white.z, 1, accuracy: 2e-3)
        let back = ColorMath.linearProPhotoToLinearSRGB.apply(SIMD3(1, 1, 1))
        XCTAssertEqual(back.x, 1, accuracy: 2e-3)
        XCTAssertEqual(back.y, 1, accuracy: 2e-3)
        XCTAssertEqual(back.z, 1, accuracy: 2e-3)
    }

    func testMatchesNumpy() throws {
        let expected = try XCTUnwrap(Matrix3(rowMajor: Self.numpySRGBToProPhoto))
        XCTAssertLessThan(ColorMath.linearSRGBToLinearProPhoto.maxAbsDifference(to: expected), 1e-6)
        let expectedInverse = try XCTUnwrap(Matrix3(rowMajor: Self.numpyProPhotoToSRGB))
        XCTAssertLessThan(ColorMath.linearProPhotoToLinearSRGB.maxAbsDifference(to: expectedInverse), 1e-6)
    }

    func testReadmeSevenDigitValues() {
        // README「色の数学」lists the matrix with 7 decimals.
        let rows = ColorMath.linearSRGBToLinearProPhoto.rowMajor.map { row in
            row.map { String(format: "%.7f", $0) }
        }
        XCTAssertEqual(rows, [
            ["0.5293459", "0.3300728", "0.1405813"],
            ["0.0983743", "0.8734610", "0.0281646"],
            ["0.0168832", "0.1176725", "0.8654443"],
        ])
    }

    func testInverseAndProduct() throws {
        let m = try XCTUnwrap(Matrix3(rowMajor: [[2, 1, 0], [0, 3, 1], [1, 0, 4]]))
        let inverse = try XCTUnwrap(m.inverse())
        XCTAssertLessThan((m * inverse).maxAbsDifference(to: .identity), 1e-12)
        XCTAssertLessThan((inverse * m).maxAbsDifference(to: .identity), 1e-12)
        XCTAssertNil(Matrix3(SIMD3(1, 2, 3), SIMD3(2, 4, 6), SIMD3(0, 0, 1)).inverse())
    }

    func testRowMajorValidation() {
        XCTAssertNil(Matrix3(rowMajor: [[1, 0, 0], [0, 1, 0]]))
        XCTAssertNil(Matrix3(rowMajor: [[1, 0], [0, 1], [0, 0]]))
        XCTAssertNil(Matrix3(rowMajor: [[1, 0, 0], [0, .nan, 0], [0, 0, 1]]))
        XCTAssertEqual(Matrix3(rowMajor: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]), .identity)
    }

    func testSourceToOutputMatrix() throws {
        // No calibration: ProPhoto output is the plain conversion, sRGB is identity.
        XCTAssertEqual(
            RenderCommand.sourceToOutputMatrix(space: .linearProPhoto, calibration: nil, exposureScale: 1),
            ColorMath.linearSRGBToLinearProPhoto
        )
        XCTAssertEqual(
            RenderCommand.sourceToOutputMatrix(space: .linearSRGB, calibration: nil, exposureScale: 1),
            .identity
        )
        // Calibration is applied in ProPhoto after the conversion, then × 2^EV.
        let calibration = try XCTUnwrap(Matrix3(rowMajor: [[1.1, -0.05, -0.05], [0, 1, 0], [0, -0.1, 1.1]]))
        let proPhoto = RenderCommand.sourceToOutputMatrix(space: .linearProPhoto, calibration: calibration, exposureScale: 2)
        let expected = calibration.scaled(by: 2) * ColorMath.linearSRGBToLinearProPhoto
        XCTAssertLessThan(proPhoto.maxAbsDifference(to: expected), 1e-12)
        // For sRGB output the calibrated ProPhoto result is converted back.
        let srgb = RenderCommand.sourceToOutputMatrix(space: .linearSRGB, calibration: calibration, exposureScale: 2)
        XCTAssertLessThan((ColorMath.linearSRGBToLinearProPhoto * srgb).maxAbsDifference(to: expected), 1e-9)
    }

    func testPixelTransformKeepsExtendedValuesUnlessClipping() {
        let unclipped = PixelTransform(matrix: .identity, encoding: .tiff32f)
        XCTAssertNil(unclipped.ceiling)
        XCTAssertEqual(unclipped.encode(-0.25), -0.25)
        XCTAssertEqual(unclipped.encode(1.5), 1.5)
        let clipped = PixelTransform(matrix: .identity, encoding: .tiff16)
        XCTAssertEqual(clipped.ceiling, 1)
        XCTAssertNil(clipped.encodeExponent)
        XCTAssertEqual(clipped.encode(-0.25), 0)
        XCTAssertEqual(clipped.encode(1.5), 1)
        XCTAssertEqual(clipped.encode(.nan), 0)
        XCTAssertEqual(PixelPipeline.quantize16(1), 65535)
        XCTAssertEqual(PixelPipeline.quantize16(0), 0)
        XCTAssertEqual(PixelPipeline.quantize16(0.5), 32768)
    }

    func testWorkingCopyTransformHasTheTwoCeiling() {
        // png16-g18 = the crate's working copy: clip [0, 2], / 2, ^(1/1.8).
        let workingCopy = PixelTransform(matrix: .identity, encoding: .png16g18)
        XCTAssertEqual(workingCopy.ceiling, 2)
        XCTAssertEqual(workingCopy.encodeExponent, 1 / 1.8)
        XCTAssertEqual(workingCopy.encode(0.18), Float(pow(0.09, 1 / 1.8)), accuracy: 1e-6)
        XCTAssertEqual(workingCopy.encode(1), Float(pow(0.5, 1 / 1.8)), accuracy: 1e-6)
        XCTAssertEqual(workingCopy.encode(1.5), Float(pow(0.75, 1 / 1.8)), accuracy: 1e-6)
        XCTAssertEqual(workingCopy.encode(2), 1)
        XCTAssertEqual(workingCopy.encode(3.5), 1)
        XCTAssertEqual(workingCopy.encode(-0.1), 0)
        XCTAssertEqual(workingCopy.encode(.nan), 0)
        // Only the working copy keeps 2^baselineEV out of the pixels.
        XCTAssertFalse(OutputEncoding.png16g18.appliesBaselineEV)
        XCTAssertFalse(OutputEncoding.png16SignedG18.appliesBaselineEV)
        XCTAssertTrue(OutputEncoding.tiff32f.appliesBaselineEV)
        XCTAssertTrue(OutputEncoding.tiff16.appliesBaselineEV)
    }

    func testPipelineStatsAndCompaction() {
        // 2 x 1 RGBA pixels; the sRGB→ProPhoto matrix keeps white at 1.
        var buffer: [Float] = [1, 1, 1, 1, -0.5, 2, 0.25, 1]
        let transform = PixelTransform(matrix: .identity, encoding: .tiff32f)
        let stats = buffer.withUnsafeMutableBufferPointer { pointer in
            PixelPipeline.apply(transform, to: pointer.baseAddress!, width: 2, height: 1)
        }
        XCTAssertEqual(stats.finitePixelCount, 2)
        XCTAssertEqual(stats.negativeCount, SIMD3(1, 0, 0))
        XCTAssertEqual(stats.aboveOneCount, SIMD3(0, 1, 0))
        XCTAssertEqual(stats.negativePixelCount, 1)
        XCTAssertNil(stats.ceiling)
        XCTAssertEqual(stats.aboveCeilingPixelCount, 0)
        XCTAssertEqual(stats.mean.x, 0.25, accuracy: 1e-9)
        buffer.withUnsafeMutableBufferPointer { pointer in
            PixelPipeline.compactRGBAToRGB(pointer.baseAddress!, pixelCount: 2)
        }
        XCTAssertEqual(Array(buffer[0 ..< 6]), [1, 1, 1, -0.5, 2, 0.25])
    }

    func testPipelineCountsPixelsAboveTheCeiling() {
        // 4 x 1 RGBA pixels: in range, one channel > 2, negative, exactly 2.
        var buffer: [Float] = [
            1.5, 0.5, 0.25, 1,
            2.5, 0.5, 0.25, 1,
            -0.1, 0.5, 3, 1,
            2, 2, 2, 1,
        ]
        let transform = PixelTransform(matrix: .identity, encoding: .png16g18)
        let stats = buffer.withUnsafeMutableBufferPointer { pointer in
            PixelPipeline.apply(transform, to: pointer.baseAddress!, width: 4, height: 1)
        }
        XCTAssertEqual(stats.ceiling, 2)
        XCTAssertEqual(stats.aboveCeilingPixelCount, 2)
        XCTAssertEqual(stats.negativePixelCount, 1)
        XCTAssertEqual(stats.aboveCeilingPixelFraction, 0.5)
        XCTAssertEqual(stats.negativePixelFraction, 0.25)
        // Encoded in place: 2 → 1, above 2 → 1, negative → 0.
        XCTAssertEqual(buffer[4], 1)
        XCTAssertEqual(buffer[8], 0)
        XCTAssertEqual(buffer[10], 1)
        XCTAssertEqual(Array(buffer[12 ..< 15]), [1, 1, 1])
        XCTAssertEqual(buffer[15], 1, "alpha untouched")
    }

    /// `ColorMath.uv` / `xy`, the uv-offset map and the DNG temperature model
    /// against `calibrate` (Python) values: `Fixtures/wb-uv-offset-python.json`.
    func testWhiteBalanceMathMatchesPython() throws {
        struct White: Decodable {
            let x: Double
            let y: Double
            let temperature: Double
            let tint: Double
        }
        struct Case: Decodable {
            let label: String
            let apple: White
            let adobe: White
        }
        struct Fixture: Decodable {
            let du: Double
            let dv: Double
            let cases: [Case]
        }
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "wb-uv-offset-python", withExtension: "json", subdirectory: "Fixtures")
        )
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertGreaterThanOrEqual(fixture.cases.count, 5)
        let map = WhiteBalanceUVOffset(du: fixture.du, dv: fixture.dv)
        for item in fixture.cases {
            let adobe = try XCTUnwrap(map.adobeWhite(x: item.apple.x, y: item.apple.y), item.label)
            // Same arithmetic in the same order as make_working_copies.py.
            XCTAssertEqual(adobe.x, item.adobe.x, accuracy: 1e-12, item.label)
            XCTAssertEqual(adobe.y, item.adobe.y, accuracy: 1e-12, item.label)
            for white in [item.apple, item.adobe] {
                let dng = try XCTUnwrap(DNGTemperature.temperatureTint(x: white.x, y: white.y), item.label)
                XCTAssertEqual(dng.temperature, white.temperature, accuracy: 1e-6, item.label)
                XCTAssertEqual(dng.tint, white.tint, accuracy: 1e-6, item.label)
            }
            // xy → uv → xy is the identity.
            let uv = ColorMath.uv(x: item.apple.x, y: item.apple.y)
            let back = ColorMath.xy(u: uv.u, v: uv.v)
            XCTAssertEqual(back.x, item.apple.x, accuracy: 1e-15, item.label)
            XCTAssertEqual(back.y, item.apple.y, accuracy: 1e-15, item.label)
        }
        XCTAssertNil(map.adobeWhite(x: .nan, y: 0.3))
        XCTAssertNil(DNGTemperature.temperatureTint(x: .nan, y: 0.3))
    }

    /// `DNGTemperature.xy` against `wbmodel.xy_from_temperature` (Python
    /// 3.14 / numpy 2.3.5), including its 2000 K clamp.
    func testDNGXYMatchesPython() {
        let cases: [(temperature: Double, tint: Double, x: Double, y: Double)] = [
            (5000, 0, 0.34510414172851334, 0.3516225216009751),
            (2000, -150, 0.4328379924032558, 0.288386653874922),
            (50000, 150, 0.19812025503880212, 0.2793996470637307),
            (3200, -15.5, 0.41623534536500534, 0.38416286534259525),
            (6504, 5, 0.3130733876946506, 0.3262855653809698),
            (5001, 10, 0.34571979664732916, 0.3588117420416335),
            (2850, 0, 0.4479935003379701, 0.40754905680250564),
            (10000, 50, 0.2701021975244136, 0.30865195429313835),
            // Below 2000 K the references clamp.
            (1500, 0, 0.5266929106668047, 0.41330847059636033),
            (1900, 12, 0.5361382313297074, 0.4258802850367401),
        ]
        for item in cases {
            let xy = DNGTemperature.xy(temperature: item.temperature, tint: item.tint)
            XCTAssertEqual(xy.x, item.x, accuracy: 1e-12, "\(item)")
            XCTAssertEqual(xy.y, item.y, accuracy: 1e-12, "\(item)")
        }
        // Unclamped (the SDK formula; `xy_from_temperature` without its max):
        // the isotherms below 2000 K, extrapolated below 1667 K.
        let unclamped: [(temperature: Double, tint: Double, x: Double, y: Double)] = [
            (1900, 12, 0.5474778487058025, 0.4235925125961518),
            (1700, -30, 0.5370967812263009, 0.3760724515951233),
            (1000, -250, 0.5057513878063508, 0.21375838632515454),
            (100_000, 250, 0.1570783120234782, 0.30026345446608305),
        ]
        for item in unclamped {
            let xy = DNGTemperature.xy(temperature: item.temperature, tint: item.tint, minimumTemperature: nil)
            XCTAssertEqual(xy.x, item.x, accuracy: 1e-12, "\(item)")
            XCTAssertEqual(xy.y, item.y, accuracy: 1e-12, "\(item)")
        }
        // Above 2000 K the clamp changes nothing.
        let clamped = DNGTemperature.xy(temperature: 3200, tint: -15.5)
        let raw = DNGTemperature.xy(temperature: 3200, tint: -15.5, minimumTemperature: nil)
        XCTAssertEqual(clamped.x, raw.x)
        XCTAssertEqual(clamped.y, raw.y)
    }

    /// `xy` and `temperatureTint` invert each other: exactly on the
    /// isotherms, within the DNG model's own inconsistency between them
    /// (up to 2.2e-4 of K and 3e-3 tint at 3200 K, tint −250).
    func testDNGXYRoundTripsWithTemperatureTint() throws {
        let onIsotherms: Set<Double> = [2000, 2500, 5000, 10000, 20000, 50000, 100_000]
        for temperature in [1700.0, 1900, 2000, 2500, 3200, 5000, 6500, 10000, 20000, 50000, 100_000] {
            for tint in [-250.0, -150, -50, 0, 50, 150, 250] {
                let xy = DNGTemperature.xy(temperature: temperature, tint: tint, minimumTemperature: nil)
                let back = try XCTUnwrap(DNGTemperature.temperatureTint(x: xy.x, y: xy.y))
                let label = "\(temperature) K, tint \(tint)"
                if onIsotherms.contains(temperature) {
                    XCTAssertEqual(back.temperature, temperature, accuracy: temperature * 1e-12, label)
                    XCTAssertEqual(back.tint, tint, accuracy: 1e-9, label)
                } else {
                    XCTAssertEqual(back.temperature, temperature, accuracy: temperature * 5e-4, label)
                    XCTAssertEqual(back.tint, tint, accuracy: 5e-3, label)
                }
            }
        }
    }

    /// `appleWhite` inverts `adobeWhite`, and matches `wbtable.lightroom_to_apple`.
    func testAppleWhiteInvertsAdobeWhite() throws {
        let map = WhiteBalanceUVOffset(du: -0.006818, dv: 0.00005)
        let python: [(x: Double, y: Double, appleX: Double, appleY: Double)] = [
            (0.34510414172851334, 0.3516225216009751, 0.35353331360601675, 0.34890351398227576),
            (0.41623534536500534, 0.38416286534259525, 0.42442299683042, 0.38108537137349796),
            // xy_from_temperature(2000, +150): off the diagram, still mapped.
            (0.6780118729900962, 0.6147154935586289, 0.6861478404359602, 0.6082229311069354),
        ]
        for item in python {
            let apple = try XCTUnwrap(map.appleWhite(x: item.x, y: item.y))
            XCTAssertEqual(apple.x, item.appleX, accuracy: 1e-12)
            XCTAssertEqual(apple.y, item.appleY, accuracy: 1e-12)
        }
        for (x, y) in [(0.4221533238887787, 0.395207017660141), (0.3127, 0.329), (0.25, 0.25), (0.5, 0.41)] {
            let adobe = try XCTUnwrap(map.adobeWhite(x: x, y: y))
            let back = try XCTUnwrap(map.appleWhite(x: adobe.x, y: adobe.y))
            XCTAssertEqual(back.x, x, accuracy: 1e-12)
            XCTAssertEqual(back.y, y, accuracy: 1e-12)
            let apple = try XCTUnwrap(map.appleWhite(x: x, y: y))
            let forth = try XCTUnwrap(map.adobeWhite(x: apple.x, y: apple.y))
            XCTAssertEqual(forth.x, x, accuracy: 1e-12)
            XCTAssertEqual(forth.y, y, accuracy: 1e-12)
        }
        XCTAssertNil(map.appleWhite(x: .nan, y: 0.3))
    }
}
