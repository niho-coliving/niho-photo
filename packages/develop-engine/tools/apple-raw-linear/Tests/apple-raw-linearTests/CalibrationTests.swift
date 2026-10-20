import XCTest
@testable import apple_raw_linear

final class CalibrationTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"),
            "missing fixture \(name).json"
        )
        return url.path
    }

    private func assertToolError(
        _ expression: @autoclosure () throws -> some Any,
        code: String,
        exitCode: Int32,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try expression(), file: file, line: line) { error in
            guard let toolError = error as? ToolError else {
                return XCTFail("not a ToolError: \(error)", file: file, line: line)
            }
            XCTAssertEqual(toolError.code, code, toolError.message, file: file, line: line)
            XCTAssertEqual(toolError.exitCode, exitCode, file: file, line: line)
        }
    }

    func testLoadsTheSpecSample() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-identity"))
        XCTAssertEqual(calibration.matrix, .identity)
        XCTAssertEqual(calibration.baselineEV, 0)
        XCTAssertEqual(calibration.exposureScale, 1)
        XCTAssertNil(calibration.illuminants)
        XCTAssertEqual(calibration.document.decoder.decoderVersion, "8")
        XCTAssertEqual(calibration.document.baseVersion, "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v1")
        // id derived from camera.id / track / version = the baseVersion's last segment.
        XCTAssertEqual(calibration.id, "cal-panasonic-dc-s5-apple-v1")
        XCTAssertEqual(calibration.sha256.count, 64)
        let resolution = try calibration.resolve(neutralTemperatureK: 3176.75)
        XCTAssertEqual(resolution.matrix, .identity)
        XCTAssertEqual(resolution.details["method"] as? String, "matrix")
    }

    func testMatchingSettingsProduceNoWarnings() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-identity"))
        let options = RenderOptions(input: "x.RW2", out: "x.tiff")
        let assigned = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1)
        let warnings = calibration.warnings(
            cameraMake: "Panasonic",
            cameraModel: "DC-S5",
            decoderVersion: "8",
            comparableSettings: assigned.calibrationComparable
        )
        XCTAssertEqual(warnings, [])
    }

    func testMismatchesAreWarningsNotErrors() throws {
        // decoderVersion is the number 7 in this fixture; lensCorrection false.
        let calibration = try Calibration.load(path: try fixture("calibration-illuminants"))
        XCTAssertEqual(calibration.document.decoder.decoderVersion, "7")
        let options = RenderOptions(input: "x.RW2", out: "x.tiff")
        let assigned = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1)
        let warnings = calibration.warnings(
            cameraMake: "SONY",
            cameraModel: "ILCE-7M4",
            decoderVersion: "8",
            comparableSettings: assigned.calibrationComparable
        )
        XCTAssertEqual(warnings.count, 3, "\(warnings)")
        XCTAssertTrue(warnings.contains { $0.contains("decoderVersion 7") })
        XCTAssertTrue(warnings.contains { $0.contains("camera") })
        XCTAssertTrue(warnings.contains { $0.contains("lensCorrection") })
    }

    func testCameraNameNormalization() {
        XCTAssertTrue(Calibration.sameCamera(
            calibrationMake: "Panasonic", calibrationModel: "DC-S5",
            rawMake: "Panasonic", rawModel: "Panasonic DC-S5"
        ))
        XCTAssertFalse(Calibration.sameCamera(
            calibrationMake: "Panasonic", calibrationModel: "DC-S5",
            rawMake: "Panasonic", rawModel: "DC-S5M2"
        ))
    }

    func testIlluminantsInterpolateInMired() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-illuminants"))
        let illuminants = try XCTUnwrap(calibration.illuminants)
        // Sorted by mired ascending: 5500 K first.
        XCTAssertEqual(illuminants.map(\.temperatureK), [5500, 3200])
        XCTAssertEqual(calibration.baselineEV, -0.25)
        XCTAssertEqual(calibration.exposureScale, pow(2, -0.25), accuracy: 1e-15)

        let warm = try XCTUnwrap(Matrix3(rowMajor: [[1.20, -0.10, -0.10], [-0.04, 1.08, -0.04], [0.00, -0.20, 1.20]]))
        let cool = try XCTUnwrap(Matrix3(rowMajor: [[1.10, -0.05, -0.05], [-0.02, 1.04, -0.02], [0.00, -0.10, 1.10]]))

        // Halfway in mired between 5500 K and 3200 K.
        let midMired = (1e6 / 5500 + 1e6 / 3200) / 2
        let mid = try calibration.resolve(neutralTemperatureK: 1e6 / midMired)
        XCTAssertLessThan(mid.matrix.maxAbsDifference(to: .interpolate(cool, warm, t: 0.5)), 1e-12)
        XCTAssertEqual(mid.details["clamped"] as? Bool, false)

        // Outside the range: clamped to the nearest end.
        let hot = try calibration.resolve(neutralTemperatureK: 2800)
        XCTAssertEqual(hot.matrix, warm)
        XCTAssertEqual(hot.details["clamped"] as? Bool, true)
        let cold = try calibration.resolve(neutralTemperatureK: 7500)
        XCTAssertEqual(cold.matrix, cool)

        // Exactly on an entry.
        XCTAssertEqual(try calibration.resolve(neutralTemperatureK: 5500).matrix, cool)

        // Illuminants without a neutral temperature cannot be resolved.
        assertToolError(try calibration.resolve(neutralTemperatureK: nil),
                        code: "unsupported_calibration_feature", exitCode: 3)
    }

    func testWhiteBalanceMapIsRead() throws {
        // The real DC-S5 apple-v1 shape: extra keys (schema, fit, ...) are ignored.
        let calibration = try Calibration.load(path: try fixture("calibration-wbmap"))
        XCTAssertEqual(calibration.whiteBalanceMap, WhiteBalanceUVOffset(du: -0.006818, dv: 0.00005))
        XCTAssertEqual(calibration.whiteBalanceMapModel, "uv-offset")
        XCTAssertEqual(calibration.baselineEV, -0.10998)
        let json = try XCTUnwrap(calibration.metadataSource["whiteBalanceMap"] as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "uv-offset")
    }

    func testCalibrationWithoutWhiteBalanceMapStillLoads() throws {
        let calibration = try Calibration.load(path: try fixture("calibration-identity"))
        XCTAssertNil(calibration.whiteBalanceMap)
        XCTAssertNil(calibration.whiteBalanceMapModel)
        XCTAssertTrue(calibration.metadataSource["whiteBalanceMap"] is NSNull)
        // An explicit null is the same as absent.
        let text = try String(contentsOfFile: try fixture("calibration-identity"), encoding: .utf8)
        let withNull = text.replacingOccurrences(of: "\"hueSat\":null,", with: "\"hueSat\":null,\"whiteBalanceMap\":null,")
        XCTAssertNotEqual(withNull, text)
        XCTAssertNil(try Calibration.parse(data: Data(withNull.utf8), path: "null-map").whiteBalanceMap)
    }

    func testMalformedWhiteBalanceMapIsInvalid() throws {
        let text = try String(contentsOfFile: try fixture("calibration-wbmap"), encoding: .utf8)
        let variants = [
            text.replacingOccurrences(of: "\"du\":-0.006818,", with: ""),
            text.replacingOccurrences(of: "\"dv\":5e-05,", with: "\"dv\":\"x\","),
        ]
        for variant in variants {
            XCTAssertNotEqual(variant, text)
            assertToolError(try Calibration.parse(data: Data(variant.utf8), path: "bad-map"),
                            code: "invalid_calibration", exitCode: 4)
        }
    }

    /// `--gamut-mapping auto` follows `decoder.settings.gamutMapping` when it
    /// is a bool, else on (0.4.0's pinned value); on / off override it.
    func testGamutMappingAutoFollowsTheCalibration() throws {
        let text = try String(contentsOfFile: try fixture("calibration-identity"), encoding: .utf8)
        func calibration(_ setting: String?) throws -> Calibration {
            let replacement = setting.map { "\"gamutMapping\":\($0)," } ?? ""
            let modified = text.replacingOccurrences(of: "\"gamutMapping\":true,", with: replacement)
            XCTAssertNotEqual(modified, text, "fixture has no gamutMapping")
            return try Calibration.parse(data: Data(modified.utf8), path: "gamut")
        }
        let on = try Calibration.load(path: try fixture("calibration-identity"))
        let off = try calibration("false")
        let absent = try calibration(nil)
        let notABool = try calibration("\"off\"")
        XCTAssertEqual(on.gamutMapping, true)
        XCTAssertEqual(off.gamutMapping, false)
        XCTAssertNil(absent.gamutMapping)
        XCTAssertNil(notABool.gamutMapping, "not a bool")

        XCTAssertEqual(RenderCommand.resolvedGamutMapping(requested: .auto, calibration: on).enabled, true)
        let fromCalibration = RenderCommand.resolvedGamutMapping(requested: .auto, calibration: off)
        XCTAssertEqual(fromCalibration.enabled, false)
        XCTAssertEqual(fromCalibration.source, "calibration decoder.settings.gamutMapping")
        for candidate in [absent, notABool] {
            let resolved = RenderCommand.resolvedGamutMapping(requested: .auto, calibration: candidate)
            XCTAssertEqual(resolved.enabled, true)
            XCTAssertEqual(resolved.source, "default")
        }
        XCTAssertEqual(RenderCommand.resolvedGamutMapping(requested: .auto, calibration: nil).enabled, true)
        XCTAssertEqual(RenderCommand.resolvedGamutMapping(requested: .on, calibration: off).enabled, true)
        XCTAssertEqual(RenderCommand.resolvedGamutMapping(requested: .off, calibration: on).enabled, false)
        XCTAssertEqual(RenderCommand.resolvedGamutMapping(requested: .off, calibration: nil).source, "--gamut-mapping")

        // The resolved flag is what the calibration's settings are compared with.
        let options = RenderOptions(input: "x.RW2", out: "x.tiff")
        func warnings(_ calibration: Calibration, gamutMapping: Bool) -> [String] {
            calibration.warnings(
                cameraMake: "Panasonic",
                cameraModel: "DC-S5",
                decoderVersion: "8",
                comparableSettings: AssignedSettings(
                    decoderVersion: "8",
                    options: options,
                    scaleFactor: 1,
                    gamutMapping: gamutMapping
                ).calibrationComparable
            )
        }
        XCTAssertEqual(warnings(off, gamutMapping: false), [])
        XCTAssertEqual(warnings(off, gamutMapping: true).count, 1)
        XCTAssertTrue(warnings(off, gamutMapping: true)[0].contains("gamutMapping"))
    }

    func testHueSatIsRejected() throws {
        assertToolError(try Calibration.load(path: try fixture("calibration-huesat")),
                        code: "unsupported_calibration_feature", exitCode: 3)
    }

    func testMalformedMatrixIsInvalid() throws {
        assertToolError(try Calibration.load(path: try fixture("calibration-bad-matrix")),
                        code: "invalid_calibration", exitCode: 4)
    }

    func testMissingFileIsInputNotFound() {
        assertToolError(try Calibration.load(path: "/nonexistent/calibration.json"),
                        code: "input_not_found", exitCode: 4)
    }

    func testOtherSchemasAndTracksAreUnsupported() throws {
        let sample = try Data(contentsOf: URL(fileURLWithPath: try fixture("calibration-identity")))
        let text = String(decoding: sample, as: UTF8.self)
        let variants: [(String, String)] = [
            ("\"niho-develop-calibration/v1\"", "\"niho-develop-calibration/v2\""),
            ("\"track\":\"apple\"", "\"track\":\"adobe\""),
            ("\"kind\":\"apple-cirawfilter\"", "\"kind\":\"libraw\""),
            ("\"workingSpace\":\"linear-prophoto-d50\"", "\"workingSpace\":\"linear-srgb-d65\""),
        ]
        for (from, to) in variants {
            let modified = text.replacingOccurrences(of: from, with: to)
            XCTAssertNotEqual(modified, text, "fixture does not contain \(from)")
            assertToolError(try Calibration.parse(data: Data(modified.utf8), path: "variant"),
                            code: "unsupported_calibration_feature", exitCode: 3)
        }
        assertToolError(try Calibration.parse(data: Data("{".utf8), path: "broken"),
                        code: "invalid_calibration", exitCode: 4)
        let missing = text.replacingOccurrences(of: "\"baselineEV\":0.0,", with: "")
        assertToolError(try Calibration.parse(data: Data(missing.utf8), path: "missing"),
                        code: "invalid_calibration", exitCode: 4)
    }
}
