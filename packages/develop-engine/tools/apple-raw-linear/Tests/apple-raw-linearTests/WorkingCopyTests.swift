import XCTest
@testable import apple_raw_linear

/// The stage-2 working-copy contract (crate `decode.rs`): the 2.0-ceiling
/// gamma 1.8 codes and the `WorkingCopyMeta` JSON.
final class WorkingCopyTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"),
            "missing fixture \(name).json"
        ).path
    }

    /// P1012822 as Core Image reports it (decoderVersion 8): the values the
    /// Python working copy (`make_working_copies.py`) was made from.
    private let neutral = NeutralReading(
        temperatureK: 3176.7542,
        tint: -4.5214148,
        x: 0.4221533238887787,
        y: 0.395207017660141,
        decoderVersion: "8"
    )

    func testReferenceCodecIsTheCrateFormula() {
        XCTAssertEqual(WorkingCopy.gamma, 1.8)
        XCTAssertEqual(WorkingCopy.ceiling, 2.0)
        XCTAssertEqual(WorkingCopy.encode(0), 0)
        XCTAssertEqual(WorkingCopy.encode(-1), 0)
        XCTAssertEqual(WorkingCopy.encode(.nan), 0)
        XCTAssertEqual(WorkingCopy.encode(2), 65535)
        XCTAssertEqual(WorkingCopy.encode(7.5), 65535)
        XCTAssertEqual(WorkingCopy.encode(1), UInt16((pow(0.5, 1 / 1.8) * 65535).rounded()))
        XCTAssertEqual(WorkingCopy.decode(0), 0)
        XCTAssertEqual(WorkingCopy.decode(65535), 2)
        // decode is an exact right inverse on the code grid.
        for code in 0 ... 65535 {
            let value = UInt16(code)
            XCTAssertEqual(WorkingCopy.encode(WorkingCopy.decode(value)), value, "code \(code)")
        }
    }

    /// The render path (Float `PixelTransform` + `quantize16`) matches the
    /// Double reference within one code over [−0.1, 2.2].
    func testRenderPathMatchesTheReferenceEncoder() {
        let transform = PixelTransform(matrix: .identity, encoding: .png16g18)
        var differing = 0
        let steps = 200_000
        for step in 0 ... steps {
            let value = Float(-0.1 + 2.3 * Double(step) / Double(steps))
            let code = PixelPipeline.quantize16(transform.encode(value))
            let reference = WorkingCopy.encode(Double(value))
            let difference = abs(Int(code) - Int(reference))
            XCTAssertLessThanOrEqual(difference, 1, "value \(value)")
            if difference != 0 { differing += 1 }
        }
        // Differences are rounding ties only.
        XCTAssertLessThan(Double(differing) / Double(steps), 0.01)
        // Tiny values are not flushed to 0 by the gamma.
        XCTAssertGreaterThan(PixelPipeline.quantize16(transform.encode(1e-6)), 0)
    }

    /// Serialized, then read back the way `WorkingCopyMeta::from_json` does.
    private func roundTrip(_ json: [String: Any]) throws -> [String: Any] {
        let data = try JSONOutput.pretty(json)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testMetadataIsWhatTheCrateReads() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-wbmap"))
        let built = WorkingCopy.metadata(
            neutral: neutral,
            calibration: calibration,
            decoderVersion: "8",
            source: ["tool": Tool.metadata]
        )
        XCTAssertEqual(built.warnings, [])
        let meta = try roundTrip(built.json)
        XCTAssertEqual(meta["kind"] as? String, "raw")
        XCTAssertEqual(meta["baselineEV"] as? Double, -0.10998)
        XCTAssertEqual(meta["dcpSha256"] as? String, "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v1")
        XCTAssertEqual(meta["lookTableIncluded"] as? Bool, false)
        let white = try XCTUnwrap(meta["asShotWhite"] as? [String: Any])
        XCTAssertEqual(white["x"] as? Double, 0.4221533238887787)
        XCTAssertEqual(white["y"] as? Double, 0.395207017660141)
        XCTAssertEqual(white["temperature"] as? Double, 3176.7542)
        XCTAssertEqual(white["tint"] as? Double, -4.5214148)
        // Python (make_working_copies.py, rounded to 6 / 1 / 2 decimals):
        // x 0.413734, y 0.39848, temperature 3384.9, tint 4.89.
        let adobe = try XCTUnwrap(meta["asShotWhiteAdobe"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(adobe["x"] as? Double), 0.4137336182110378, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(adobe["y"] as? Double), 0.39847966287214376, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(adobe["temperature"] as? Double), 3384.945072931617, accuracy: 1e-6)
        XCTAssertEqual(try XCTUnwrap(adobe["tint"] as? Double), 4.893304306416134, accuracy: 1e-6)
        XCTAssertNotNil(meta["_source"] as? [String: Any])
    }

    func testMetadataWithoutCalibration() throws {
        let built = WorkingCopy.metadata(neutral: neutral, calibration: nil, decoderVersion: "8", source: [:])
        XCTAssertEqual(built.warnings, [])
        let meta = try roundTrip(built.json)
        XCTAssertEqual(meta["kind"] as? String, "raw")
        XCTAssertEqual(meta["baselineEV"] as? Double, 0)
        XCTAssertEqual(meta["dcpSha256"] as? String, "apple-ciraw8/linear-prophoto-d50/uncalibrated")
        XCTAssertTrue(meta["asShotWhiteAdobe"] is NSNull)
        let white = try XCTUnwrap(meta["asShotWhite"] as? [String: Any])
        XCTAssertEqual(white["x"] as? Double, neutral.x)
    }

    func testCalibrationWithoutMapGivesNoAdobeWhite() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-identity"))
        let built = WorkingCopy.metadata(neutral: neutral, calibration: calibration, decoderVersion: "8", source: [:])
        XCTAssertEqual(built.warnings, [])
        XCTAssertTrue(built.json["asShotWhiteAdobe"] is NSNull)
        XCTAssertEqual(built.json["dcpSha256"] as? String, calibration.document.baseVersion)
    }

    func testUnknownMapModelWarnsAndGivesNoAdobeWhite() throws {
        let text = try String(contentsOfFile: try fixture("calibration-wbmap"), encoding: .utf8)
        let modified = text.replacingOccurrences(of: "\"model\":\"uv-offset\"", with: "\"model\":\"affine-uv\"")
        XCTAssertNotEqual(modified, text)
        let calibration = try Calibration.parse(data: Data(modified.utf8), path: "affine")
        XCTAssertNil(calibration.whiteBalanceMap)
        XCTAssertEqual(calibration.whiteBalanceMapModel, "affine-uv")
        let built = WorkingCopy.metadata(neutral: neutral, calibration: calibration, decoderVersion: "8", source: [:])
        XCTAssertTrue(built.json["asShotWhiteAdobe"] is NSNull)
        XCTAssertEqual(built.warnings.count, 1)
        XCTAssertTrue(built.warnings[0].contains("affine-uv"), built.warnings[0])
    }
}
