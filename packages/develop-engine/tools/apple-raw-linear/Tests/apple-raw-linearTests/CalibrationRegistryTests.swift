import CryptoKit
import XCTest
@testable import apple_raw_linear

/// `--calibration-registry` (S4b #17034): the per-camera registry the
/// production worker renders with, and the working copy's lens rule.
final class CalibrationRegistryTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-raw-linear-registry-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
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

    /// The identity fixture with another camera / track / lens section.
    @discardableResult
    private func writeCalibration(
        _ relativePath: String,
        make: String = "Panasonic",
        model: String = "DC-S5",
        cameraId: String? = "panasonic-dc-s5",
        track: String = "apple",
        decoderVersion: String = "8",
        lensMode: String? = nil,
        extra: [String: Any] = [:]
    ) throws -> URL {
        let fixture = try XCTUnwrap(
            Bundle.module.url(forResource: "calibration-identity", withExtension: "json", subdirectory: "Fixtures")
        )
        var json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        )
        json["camera"] = ["make": make, "model": model, "id": cameraId.map { $0 as Any } ?? NSNull()]
        json["track"] = track
        if var decoder = json["decoder"] as? [String: Any] {
            decoder["decoderVersion"] = decoderVersion
            json["decoder"] = decoder
        }
        if let lensMode {
            json["lens"] = ["mode": lensMode]
        }
        json.merge(extra) { _, new in new }
        let url = directory.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: json).write(to: url)
        return url
    }

    private func writeRegistry(_ object: [String: Any], name: String = "registry.json") throws -> String {
        let url = directory.appendingPathComponent(name)
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        return url.path
    }

    private func registry(
        _ cameras: [[String: String]],
        track: String = "apple",
        schema: String = CalibrationRegistry.schema
    ) throws -> String {
        try writeRegistry(["schema": schema, "track": track, "cameras": cameras])
    }

    // MARK: - Selection

    func testSelectsOnlyAStrictMakeAndModelMatch() throws {
        try writeCalibration("panasonic-dc-s5/apple-v2.json", lensMode: "apple")
        let path = try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "panasonic-dc-s5/apple-v2.json"],
            ["make": "SONY", "model": "ZV-E10M2", "file": "sony/apple-v1.json"],
        ])
        let loaded = try CalibrationRegistry.load(path: path)
        XCTAssertEqual(loaded.track, "apple")
        XCTAssertEqual(loaded.fileName, "registry.json")

        let expected = CalibrationRegistry.Entry(make: "Panasonic", model: "DC-S5", file: "panasonic-dc-s5/apple-v2.json")
        XCTAssertEqual(try loaded.entry(make: "Panasonic", model: "DC-S5"), expected)
        // Case, surrounding spaces and a model that repeats the make still match.
        XCTAssertEqual(try loaded.entry(make: " PANASONIC ", model: "Panasonic DC-S5"), expected)
        XCTAssertEqual(try loaded.entry(make: "Sony", model: "ZV-E10M2")?.file, "sony/apple-v1.json")
        // Strict: another model, a missing make or model, another make → none.
        XCTAssertNil(try loaded.entry(make: "Panasonic", model: "DC-S5M2"))
        XCTAssertNil(try loaded.entry(make: nil, model: "DC-S5"))
        XCTAssertNil(try loaded.entry(make: "Panasonic", model: nil))
        XCTAssertNil(try loaded.entry(make: "Canon", model: "DC-S5"))

        let selected = try loaded.calibration(make: "Panasonic", model: "DC-S5")
        XCTAssertEqual(selected.calibration?.id, "cal-panasonic-dc-s5-apple-v1")
        XCTAssertEqual(selected.calibration?.lensMode, .apple)
        XCTAssertEqual(selected.selection, .init(registry: "registry.json", file: "panasonic-dc-s5/apple-v2.json"))
        XCTAssertEqual(selected.selection.json["file"] as? String, "panasonic-dc-s5/apple-v2.json")

        let none = try loaded.calibration(make: "Canon", model: "EOS R5")
        XCTAssertNil(none.calibration)
        XCTAssertEqual(none.selection, .init(registry: "registry.json", file: nil))
        XCTAssertTrue(none.selection.json["file"] is NSNull)
    }

    func testTwoMatchingEntriesAreInvalid() throws {
        let path = try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "a.json"],
            ["make": "panasonic", "model": "dc-s5", "file": "b.json"],
        ])
        let loaded = try CalibrationRegistry.load(path: path)
        assertToolError(try loaded.entry(make: "Panasonic", model: "DC-S5"), code: "invalid_calibration", exitCode: 4)
        // Other cameras are unaffected.
        XCTAssertNil(try loaded.entry(make: "SONY", model: "ZV-E10M2"))
    }

    func testEntryFilesStayInsideTheRegistryFolder() throws {
        for file in ["/etc/calibration.json", "../outside.json", "cam/../../outside.json", "~/cal.json", "cam/"] {
            let path = try registry([["make": "Panasonic", "model": "DC-S5", "file": file]])
            assertToolError(try CalibrationRegistry.load(path: path), code: "invalid_calibration", exitCode: 4)
        }
        XCTAssertTrue(CalibrationRegistry.isInside(directory: directory, relativePath: "cam/apple-v1.json"))
        XCTAssertTrue(CalibrationRegistry.isInside(directory: directory, relativePath: "./cam/apple-v1.json"))
        XCTAssertFalse(CalibrationRegistry.isInside(directory: directory, relativePath: ".."))
    }

    func testMalformedRegistriesAreInvalid() throws {
        let camera = ["make": "Panasonic", "model": "DC-S5", "file": "a.json"]
        assertToolError(
            try CalibrationRegistry.load(path: try writeRegistry(["schema": CalibrationRegistry.schema, "track": "apple"])),
            code: "invalid_calibration",
            exitCode: 4
        )
        assertToolError(try CalibrationRegistry.load(path: try registry([])), code: "invalid_calibration", exitCode: 4)
        assertToolError(
            try CalibrationRegistry.load(path: try registry([camera], track: " ")),
            code: "invalid_calibration",
            exitCode: 4
        )
        for key in ["make", "model", "file"] {
            var entry = camera
            entry[key] = ""
            assertToolError(try CalibrationRegistry.load(path: try registry([entry])), code: "invalid_calibration", exitCode: 4)
        }
        assertToolError(
            try CalibrationRegistry.load(path: try registry([camera], schema: "niho-develop-calibration-registry/v2")),
            code: "unsupported_calibration_feature",
            exitCode: 3
        )
        // A missing registry names the registry, not the RAW (input_not_found).
        assertToolError(
            try CalibrationRegistry.load(path: directory.appendingPathComponent("missing.json").path),
            code: "invalid_calibration",
            exitCode: 4
        )
    }

    func testCalibrationMustBeForTheEntrysCameraAndTrack() throws {
        try writeCalibration("sony.json", make: "SONY", model: "ZV-E10M2", cameraId: "sony-zv-e10m2")
        let wrongCamera = try CalibrationRegistry.load(path: try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "sony.json"],
        ]))
        assertToolError(
            try wrongCamera.calibration(make: "Panasonic", model: "DC-S5"),
            code: "invalid_calibration",
            exitCode: 4
        )

        try writeCalibration("panasonic.json")
        let wrongTrack = try CalibrationRegistry.load(path: try registry(
            [["make": "Panasonic", "model": "DC-S5", "file": "panasonic.json"]],
            track: "adobe"
        ))
        assertToolError(
            try wrongTrack.calibration(make: "Panasonic", model: "DC-S5"),
            code: "invalid_calibration",
            exitCode: 4
        )

        let missingFile = try CalibrationRegistry.load(path: try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "nope/apple-v9.json"],
        ]))
        assertToolError(
            try missingFile.calibration(make: "Panasonic", model: "DC-S5"),
            code: "invalid_calibration",
            exitCode: 4
        )
    }

    func testRegistryRejectsCalibrationForDifferentAppliedDecoderVersion() throws {
        try writeCalibration("panasonic/apple-v2.json", decoderVersion: "8")
        let loaded = try CalibrationRegistry.load(path: try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "panasonic/apple-v2.json"],
        ]))
        let selected = try loaded.calibration(make: "Panasonic", model: "DC-S5")
        let calibration = try XCTUnwrap(selected.calibration)

        XCTAssertNoThrow(
            try loaded.validateDecoderVersion(of: calibration, file: "panasonic/apple-v2.json", appliedVersion: "8")
        )
        assertToolError(
            try loaded.validateDecoderVersion(of: calibration, file: "panasonic/apple-v2.json", appliedVersion: "7"),
            code: "invalid_calibration",
            exitCode: 4
        )
    }

    // MARK: - fallback (#18398)

    /// The generic calibration: no camera, lens apple, gamut mapping on.
    @discardableResult
    private func writeFallback(
        _ relativePath: String = "generic/apple-v1.json",
        cameraId: Any = "generic",
        lensMode: String? = "apple",
        decoderVersion: String = "8",
        extra: [String: Any] = [:]
    ) throws -> URL {
        var fields: [String: Any] = ["camera": ["make": NSNull(), "model": NSNull(), "id": cameraId]]
        fields.merge(extra) { _, new in new }
        return try writeCalibration(relativePath, decoderVersion: decoderVersion, lensMode: lensMode, extra: fields)
    }

    private func registryWithFallback(
        _ cameras: [[String: String]] = [["make": "Panasonic", "model": "DC-S5", "file": "panasonic/apple-v2.json"]],
        fallback: String = "generic/apple-v1.json",
        track: String = "apple",
        name: String = "fallback-registry.json"
    ) throws -> String {
        try writeRegistry([
            "schema": CalibrationRegistry.schema,
            "track": track,
            "cameras": cameras,
            "fallback": ["file": fallback],
        ], name: name)
    }

    func testFallbackRendersACameraWithoutAnEntry() throws {
        try writeCalibration("panasonic/apple-v2.json", lensMode: "apple")
        try writeFallback()
        let loaded = try CalibrationRegistry.load(path: try registryWithFallback())
        XCTAssertEqual(loaded.fallback, "generic/apple-v1.json")

        // A camera with an entry keeps its own calibration.
        let own = try loaded.calibration(make: "Panasonic", model: "DC-S5", decoderVersion: "8")
        XCTAssertEqual(own.calibration?.id, "cal-panasonic-dc-s5-apple-v1")
        XCTAssertEqual(own.selection, .init(registry: "fallback-registry.json", file: "panasonic/apple-v2.json"))
        XCTAssertEqual(own.selection.json["fallback"] as? Bool, false)

        // Any other camera (or one without make / model) gets the fallback for its decoder version.
        for (make, model) in [("Canon", "EOS R5"), (nil, nil) as (String?, String?), ("Panasonic", "DC-S5M2")] {
            let selected = try loaded.calibration(make: make, model: model, decoderVersion: "8")
            XCTAssertEqual(selected.calibration?.id, "cal-generic-apple-v1", "\(make ?? "-") \(model ?? "-")")
            XCTAssertEqual(selected.calibration?.document.camera.id, "generic")
            XCTAssertEqual(
                selected.selection,
                .init(registry: "fallback-registry.json", file: "generic/apple-v1.json", fallback: true)
            )
            XCTAssertEqual(selected.selection.json["fallback"] as? Bool, true)
        }
        // Another decoder version (DNG's 8.DNG) stays uncalibrated.
        let dng = try loaded.calibration(make: "Leica", model: "Q3", decoderVersion: "8.DNG")
        XCTAssertNil(dng.calibration)
        XCTAssertEqual(dng.selection, .init(registry: "fallback-registry.json", file: nil))
        // The camera-only selection (the signed working copy) never falls back.
        XCTAssertNil(try loaded.calibration(make: "Canon", model: "EOS R5").calibration)

        // Without a fallback nothing changes.
        let plain = try CalibrationRegistry.load(path: try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "panasonic/apple-v2.json"],
        ]))
        XCTAssertNil(plain.fallback)
        let none = try plain.calibration(make: "Canon", model: "EOS R5", decoderVersion: "8")
        XCTAssertNil(none.calibration)
        XCTAssertEqual(none.selection, .init(registry: "registry.json", file: nil))
    }

    func testFallbackSelectionUsesTheDecoderActuallyAppliedAfterAllowFallback() throws {
        try writeFallback(decoderVersion: "8")
        let loaded = try CalibrationRegistry.load(path: try registryWithFallback())
        let requestedVersion = "7"
        let appliedDefaultVersion = "8"
        XCTAssertNotEqual(requestedVersion, appliedDefaultVersion)

        // RenderCommand resolves --allow-fallback before this lookup and passes the
        // applied default. Looking up with the unsupported request would miss it.
        let selected = try loaded.calibration(make: "Canon", model: "EOS R5", decoderVersion: appliedDefaultVersion)
        XCTAssertEqual(selected.calibration?.id, "cal-generic-apple-v1")
        XCTAssertTrue(selected.selection.fallback)

        let requestedOnly = try loaded.calibration(make: "Canon", model: "EOS R5", decoderVersion: requestedVersion)
        XCTAssertNil(requestedOnly.calibration)
        XCTAssertFalse(requestedOnly.selection.fallback)
    }

    func testFallbackKeepsEverythingButTheColorOfAnUncalibratedRender() throws {
        try writeCalibration("panasonic/apple-v2.json", lensMode: "apple")
        let path = try registryWithFallback()
        func fallback() throws -> Calibration {
            try CalibrationRegistry.load(path: path).loadFallbackCalibration()
        }
        try writeFallback()
        XCTAssertEqual(try fallback().lensMode, .apple)

        let table: [String: Any] = [
            "schema": WhiteBalanceTable.schema,
            "space": WhiteBalanceTable.space,
            "scale": WhiteBalanceTable.scale,
            "reference": ["temperature": 5000, "tint": 0],
            "mired": [100, 200],
            "tint": [-10, 10],
            "inverseMatrices": Array(repeating: [1, 0, 0, 0, 1, 0, 0, 0, 1], count: 4),
            "measured": ["raws": 3],
        ]
        var gamutOff = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: try XCTUnwrap(
                    Bundle.module.url(forResource: "calibration-identity", withExtension: "json", subdirectory: "Fixtures")
                ))
            ) as? [String: Any]
        )["decoder"] as? [String: Any]
        var settings = gamutOff?["settings"] as? [String: Any] ?? [:]
        settings["gamutMapping"] = false
        gamutOff?["settings"] = settings
        let invalid: [(String, () throws -> Void)] = [
            ("a camera", { try self.writeCalibration("generic/apple-v1.json", make: "Canon", model: "EOS R5", cameraId: "generic", lensMode: "apple") }),
            ("no camera.id", { try self.writeFallback(cameraId: NSNull()) }),
            ("lens embedded", { try self.writeFallback(lensMode: "embedded") }),
            ("no lens section", { try self.writeFallback(lensMode: nil) }),
            ("gamut mapping off", { try self.writeFallback(extra: ["decoder": gamutOff as Any]) }),
            ("a white-balance map", { try self.writeFallback(extra: ["whiteBalanceMap": ["model": "uv-offset", "du": 0.001, "dv": 0]]) }),
            ("a white-balance table", { try self.writeFallback(extra: ["whiteBalanceTable": table]) }),
        ]
        for (label, write) in invalid {
            try write()
            XCTAssertThrowsError(try fallback(), label) { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_calibration", label)
            }
        }
        // The fallback's track is the registry's.
        try writeFallback()
        let otherTrack = try registryWithFallback(track: "adobe", name: "adobe-registry.json")
        assertToolError(
            try CalibrationRegistry.load(path: otherTrack).loadFallbackCalibration(),
            code: "invalid_calibration",
            exitCode: 4
        )

        // The file stays inside the registry's folder and must exist.
        for file in ["/etc/generic.json", "../generic.json", ""] {
            assertToolError(
                try CalibrationRegistry.load(path: try registryWithFallback(fallback: file)),
                code: "invalid_calibration",
                exitCode: 4
            )
        }
        let missing = try CalibrationRegistry.load(path: try registryWithFallback(fallback: "generic/apple-v9.json"))
        assertToolError(try missing.loadFallbackCalibration(), code: "invalid_calibration", exitCode: 4)
        assertToolError(
            try missing.calibration(make: "Canon", model: "EOS R5", decoderVersion: "8"),
            code: "invalid_calibration",
            exitCode: 4
        )
    }

    func testRegistryCommandReportsTheFallback() throws {
        try writeCalibration("panasonic/apple-v2.json", lensMode: "apple")
        try writeFallback()
        let path = try registryWithFallback()
        let line = try RegistryCommand.run(RegistryOptions(registry: path))
        XCTAssertFalse(line.contains(directory.path), "no absolute paths")
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(object["cameras"] as? Int, 1)
        let fallback = try XCTUnwrap(object["fallback"] as? [String: Any])
        XCTAssertEqual(fallback["file"] as? String, "generic/apple-v1.json")
        XCTAssertEqual(fallback["id"] as? String, "cal-generic-apple-v1")
        XCTAssertEqual(fallback["cameraId"] as? String, "generic")
        XCTAssertEqual(fallback["version"] as? String, "v1")
        XCTAssertEqual(fallback["decoderVersion"] as? String, "8")
        XCTAssertEqual(fallback["lensMode"] as? String, "apple")

        // No fallback → null.
        let plain = try writeRegistry(
            [
                "schema": CalibrationRegistry.schema,
                "track": "apple",
                "cameras": [["make": "Panasonic", "model": "DC-S5", "file": "panasonic/apple-v2.json"]],
            ],
            name: "plain-registry.json"
        )
        let plainObject = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(try RegistryCommand.run(RegistryOptions(registry: plain)).utf8))
                as? [String: Any]
        )
        XCTAssertTrue(plainObject["fallback"] is NSNull)

        // The fallback's camera.id must differ from every entry's (the baseVersion tells them apart).
        try writeFallback(cameraId: "panasonic-dc-s5")
        assertToolError(try RegistryCommand.run(RegistryOptions(registry: path)), code: "invalid_calibration", exitCode: 4)
        // A broken fallback stops the startup check.
        try writeFallback(lensMode: "embedded")
        assertToolError(try RegistryCommand.run(RegistryOptions(registry: path)), code: "invalid_calibration", exitCode: 4)
    }

    /// The registry the production worker ships with: every entry loads, is
    /// for its camera and track, and corrects the lens (apple or embedded).
    func testTheRepositoryRegistry() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // apple-raw-linearTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apple-raw-linear
            .deletingLastPathComponent() // tools
            .deletingLastPathComponent() // develop-engine
        let path = root.appendingPathComponent("calibration/apple-registry.json").path
        let loaded = try CalibrationRegistry.load(path: path)
        XCTAssertEqual(loaded.track, Calibration.track)
        XCTAssertFalse(loaded.cameras.isEmpty)
        for entry in loaded.cameras {
            XCTAssertEqual(try loaded.entry(make: entry.make, model: entry.model), entry, entry.file)
            let calibration = try loaded.loadCalibration(for: entry)
            XCTAssertEqual(calibration.document.track, loaded.track, entry.file)
            let mode = try XCTUnwrap(calibration.lensMode, "\(entry.file) has no lens section")
            XCTAssertTrue([LensCorrectionMode.apple, .embedded].contains(mode), "\(entry.file): lens.mode \(mode.rawValue)")
            XCTAssertNotNil(calibration.document.camera.id, entry.file)
        }
        // The fallback (#18398) keeps the uncalibrated render's lens and white,
        // and a camera without an entry gets it on decoder 8 only.
        let fallback = try loaded.loadFallbackCalibration()
        XCTAssertEqual(fallback.lensMode, .apple)
        XCTAssertEqual(fallback.document.camera.id, "generic")
        let unregistered = try loaded.calibration(make: "Canon", model: "EOS R5", decoderVersion: "8")
        XCTAssertEqual(unregistered.calibration?.id, fallback.id)
        XCTAssertTrue(unregistered.selection.fallback)
        XCTAssertNil(try loaded.calibration(make: "Canon", model: "EOS R5", decoderVersion: "8.DNG").calibration)
    }

    // MARK: - registry (the worker's startup check)

    func testVerifyAcceptsAProductionRegistry() throws {
        try writeCalibration("panasonic/apple-v2.json", lensMode: "apple")
        try writeCalibration(
            "sony/apple-v2.json",
            make: "SONY",
            model: "ZV-E10M2",
            cameraId: "sony-zv-e10m2",
            lensMode: "embedded"
        )
        let path = try registry([
            ["make": "Panasonic", "model": "DC-S5", "file": "panasonic/apple-v2.json"],
            ["make": "SONY", "model": "ZV-E10M2", "file": "sony/apple-v2.json"],
        ])
        let verified = try CalibrationRegistry.load(path: path).verify()
        XCTAssertEqual(verified.map(\.lensMode), [.apple, .embedded])
        XCTAssertEqual(verified.map(\.entry.file), ["panasonic/apple-v2.json", "sony/apple-v2.json"])

        let line = try RegistryCommand.run(RegistryOptions(registry: path))
        XCTAssertFalse(line.contains("\n"))
        XCTAssertFalse(line.contains(directory.path), "no absolute paths")
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(object["registry"] as? String, "registry.json")
        XCTAssertEqual(object["track"] as? String, "apple")
        XCTAssertEqual(object["cameras"] as? Int, 2)
        let entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        XCTAssertEqual(entries.first?["file"] as? String, "panasonic/apple-v2.json")
        XCTAssertEqual(entries.first?["id"] as? String, "cal-panasonic-dc-s5-apple-v1")
        XCTAssertEqual(entries.first?["cameraId"] as? String, "panasonic-dc-s5")
        XCTAssertEqual(entries.first?["version"] as? String, "v1")
        XCTAssertEqual(entries.last?["lensMode"] as? String, "embedded")
    }

    func testVerifyRejectsWhatAWorkingCopyCannotUse() throws {
        let entry = ["make": "Panasonic", "model": "DC-S5", "file": "cal.json"]
        func verify(_ cameras: [[String: String]]) throws -> [CalibrationRegistry.VerifiedEntry] {
            try CalibrationRegistry.load(path: try registry(cameras)).verify()
        }
        // lens.mode off, or no lens section.
        try writeCalibration("cal.json", lensMode: "off")
        assertToolError(try verify([entry]), code: "invalid_calibration", exitCode: 4)
        try writeCalibration("cal.json")
        assertToolError(try verify([entry]), code: "invalid_calibration", exitCode: 4)
        // No camera.id (the baseVersion names it).
        try writeCalibration("cal.json", cameraId: nil, lensMode: "apple")
        assertToolError(try verify([entry]), code: "invalid_calibration", exitCode: 4)
        // The full calibration contract: hueSat is not supported (3), a bad matrix is invalid (4).
        try writeCalibration("cal.json", lensMode: "apple", extra: ["hueSat": ["table": []]])
        assertToolError(try verify([entry]), code: "unsupported_calibration_feature", exitCode: 3)
        try writeCalibration("cal.json", lensMode: "apple", extra: ["matrix": ["space": "linear-prophoto-d50", "rowMajor": [[1, 0]]]])
        assertToolError(try verify([entry]), code: "invalid_calibration", exitCode: 4)
        // The same camera twice, even under another spelling.
        try writeCalibration("cal.json", lensMode: "apple")
        assertToolError(
            try verify([entry, ["make": "PANASONIC", "model": "Panasonic DC-S5", "file": "cal.json"]]),
            code: "invalid_calibration",
            exitCode: 4
        )
        // The entry's calibration is for another camera.
        try writeCalibration("cal.json", make: "SONY", model: "ZV-E10M2", cameraId: "sony-zv-e10m2", lensMode: "embedded")
        assertToolError(try verify([entry]), code: "invalid_calibration", exitCode: 4)
        XCTAssertNoThrow(try verify([["make": "SONY", "model": "ZV-E10M2", "file": "cal.json"]]))
    }

    /// A calibration's white-balance table is part of the contract the
    /// worker checks at startup; the line says which entries carry one.
    func testVerifyChecksTheWhiteBalanceTable() throws {
        let path = try registry([["make": "Panasonic", "model": "DC-S5", "file": "cal.json"]])
        func entry() throws -> [String: Any] {
            let line = try RegistryCommand.run(RegistryOptions(registry: path))
            let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            return try XCTUnwrap((object["entries"] as? [[String: Any]])?.first)
        }
        let table: [String: Any] = [
            "schema": WhiteBalanceTable.schema,
            "space": WhiteBalanceTable.space,
            "scale": WhiteBalanceTable.scale,
            "reference": ["temperature": 5000, "tint": 0],
            "mired": [100, 200],
            "tint": [-10, 10],
            "inverseMatrices": Array(repeating: [1, 0, 0, 0, 1, 0, 0, 0, 1], count: 4),
            "measured": ["raws": 3],
        ]
        try writeCalibration("cal.json", lensMode: "apple")
        XCTAssertEqual(try entry()["whiteBalanceTable"] as? Bool, false)
        try writeCalibration("cal.json", lensMode: "apple", extra: ["whiteBalanceTable": table])
        XCTAssertEqual(try entry()["whiteBalanceTable"] as? Bool, true)
        try writeCalibration("cal.json", lensMode: "apple", extra: ["whiteBalanceTable": NSNull()])
        XCTAssertEqual(try entry()["whiteBalanceTable"] as? Bool, false)

        var wrongCount = table
        wrongCount["inverseMatrices"] = Array(repeating: [1, 0, 0, 0, 1, 0, 0, 0, 1], count: 3)
        var wrongSchema = table
        wrongSchema["schema"] = "niho-develop-wb-table/v0"
        for invalid in [wrongCount, wrongSchema] {
            try writeCalibration("cal.json", lensMode: "apple", extra: ["whiteBalanceTable": invalid])
            assertToolError(try CalibrationRegistry.load(path: path).verify(), code: "invalid_calibration", exitCode: 4)
            assertToolError(try RegistryCommand.run(RegistryOptions(registry: path)), code: "invalid_calibration", exitCode: 4)
        }
    }

    func testRegistryCommandOnTheRepositoryRegistry() throws {
        let line = try RegistryCommand.run(RegistryOptions(registry: repositoryRegistryPath()))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(object["registry"] as? String, "apple-registry.json")
        let entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        XCTAssertEqual(object["cameras"] as? Int, entries.count)
        XCTAssertGreaterThanOrEqual(entries.count, 2)
        for entry in entries {
            XCTAssertTrue(["apple", "embedded"].contains(entry["lensMode"] as? String ?? ""), "\(entry)")
            XCTAssertFalse((entry["file"] as? String ?? "/").hasPrefix("/"))
        }
        XCTAssertFalse(line.contains(repositoryRegistryPath()))
    }

    func testSignedRegistryUsesFX30V2AndLeavesLegacyFilesByteExact() throws {
        let root = repositoryCalibrationRoot()
        let signedPath = root.appendingPathComponent("apple-signed-registry.json").path
        // An unregistered camera keeps the legacy recipe (#18398: the fallback is legacy-only).
        XCTAssertNil(try CalibrationRegistry.load(path: signedPath).fallback)
        let verified = try CalibrationRegistry.load(path: signedPath).verify()
        XCTAssertEqual(verified.count, 3)
        XCTAssertEqual(
            verified.map(\.entry.file),
            [
                "panasonic-dc-s5/apple-v4.json",
                "sony-zv-e10m2/apple-v3.json",
                "sony-ilme-fx30/apple-v2.json",
            ]
        )
        let fx30v2 = try XCTUnwrap(verified.last?.calibration)
        let fx30v1 = try Calibration.load(path: root.appendingPathComponent("sony-ilme-fx30/apple-v1.json").path)
        XCTAssertEqual(fx30v2.document.version, "v2")
        XCTAssertEqual(fx30v2.document.baseVersion, "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v2")
        XCTAssertEqual(fx30v2.matrix, fx30v1.matrix)
        XCTAssertEqual(fx30v2.baselineEV, fx30v1.baselineEV)
        XCTAssertNotNil(fx30v2.whiteBalanceTable)
        XCTAssertEqual(fx30v2.document.decoder.settings?["gamutMapping"], .bool(false))
        XCTAssertEqual(fx30v2.document.decoder.settings?["nr"], .string("off"))
        XCTAssertEqual(fx30v2.document.decoder.settings?["sharpen"], .string("default"))
        guard case let .object(matrixProvenance)? = fx30v2.document.matrixProvenance else {
            return XCTFail("FX30 v2 has no matrix provenance")
        }
        XCTAssertEqual(matrixProvenance["sourceVersion"], .string("v1"))
        XCTAssertEqual(
            matrixProvenance["sourceSha256"],
            .string("404d2b641ee7bc282ba58bafa85138ac11c50aace5f3766dac3a881582c38516")
        )
        XCTAssertEqual(matrixProvenance["sourceGamutMapping"], .bool(true))
        guard case let .object(recipeProvenance)? = fx30v2.document.recipeProvenance else {
            return XCTFail("FX30 v2 has no recipe provenance")
        }
        XCTAssertEqual(recipeProvenance["processing"], .string("p3"))
        XCTAssertEqual(recipeProvenance["encoding"], .string("e4"))
        XCTAssertEqual(recipeProvenance["matrixAppliedAfterLanczos4"], .bool(true))

        // The legacy registry changed only by its fallback (#18398); the API snapshot pins the same digest.
        XCTAssertEqual(
            try sha256(root.appendingPathComponent("apple-registry.json")),
            "573c32f9d2d90fb14b64c2747ee5dbba46388a7891f5d14738533faef285ec4b"
        )
        XCTAssertEqual(
            try sha256(root.appendingPathComponent("sony-ilme-fx30/apple-v1.json")),
            "404d2b641ee7bc282ba58bafa85138ac11c50aace5f3766dac3a881582c38516"
        )
    }

    private func sha256(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }

    private func repositoryCalibrationRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // apple-raw-linearTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apple-raw-linear
            .deletingLastPathComponent() // tools
            .deletingLastPathComponent() // develop-engine
            .appendingPathComponent("calibration")
    }

    private func repositoryRegistryPath() -> String {
        repositoryCalibrationRoot().appendingPathComponent("apple-registry.json").path
    }

    // MARK: - effective lens correction

    func testAppleWithoutCoreImageSupportIsRecordedAsNone() {
        let unsupported = RenderCommand.effectiveLensCorrection(
            requested: .auto,
            mode: .apple,
            isLensCorrectionSupported: false,
            coreImageEnabled: false,
            assignedCoreImage: true
        )
        XCTAssertEqual(unsupported["mode"] as? String, "none")
        XCTAssertEqual(unsupported["reason"] as? String, "unsupported")
        XCTAssertEqual(unsupported["coreImage"] as? Bool, false)
        XCTAssertEqual(unsupported["requested"] as? String, "auto")

        // Supported but the flag did not stick: still none (read back, not assumed).
        let notEnabled = RenderCommand.effectiveLensCorrection(
            requested: .apple,
            mode: .apple,
            isLensCorrectionSupported: true,
            coreImageEnabled: false,
            assignedCoreImage: true
        )
        XCTAssertEqual(notEnabled["mode"] as? String, "none")
        XCTAssertEqual(notEnabled["reason"] as? String, "not_enabled")

        let apple = RenderCommand.effectiveLensCorrection(
            requested: .auto,
            mode: .apple,
            isLensCorrectionSupported: true,
            coreImageEnabled: true,
            assignedCoreImage: true
        )
        XCTAssertEqual(apple["mode"] as? String, "apple")
        XCTAssertEqual(apple["coreImage"] as? Bool, true)
        XCTAssertNil(apple["reason"])

        // embedded (the tool corrects) and off (measurement) keep their mode.
        let embedded = RenderCommand.effectiveLensCorrection(
            requested: .auto,
            mode: .embedded,
            isLensCorrectionSupported: false,
            coreImageEnabled: false,
            assignedCoreImage: false
        )
        XCTAssertEqual(embedded["mode"] as? String, "embedded")
        XCTAssertEqual(embedded["coreImage"] as? Bool, false)
        let off = RenderCommand.effectiveLensCorrection(
            requested: .off,
            mode: .off,
            isLensCorrectionSupported: true,
            coreImageEnabled: false,
            assignedCoreImage: false
        )
        XCTAssertEqual(off["mode"] as? String, "off")
    }

    // MARK: - render (before decoding)

    private func renderOptions(workingCopy: Bool) -> RenderOptions {
        var options = RenderOptions(
            input: directory.appendingPathComponent("not-a-raw.RW2").path,
            out: directory.appendingPathComponent(workingCopy ? "out.png" : "out.tiff").path
        )
        if workingCopy {
            options.encoding = .png16g18
            options.workingCopyMeta = directory.appendingPathComponent("out.json").path
        }
        return options
    }

    private func writeNotARaw() throws {
        try Data("not a raw file".utf8).write(to: directory.appendingPathComponent("not-a-raw.RW2"))
    }

    func testWorkingCopyRejectsLensOffFromTheCalibrationBeforeDecoding() throws {
        try writeNotARaw()
        let calibration = try writeCalibration("off.json", lensMode: "off")
        var options = renderOptions(workingCopy: true)
        options.calibration = calibration.path
        // invalid_arguments (1), not unsupported_camera (2): nothing was decoded.
        assertToolError(try RenderCommand.run(options, arguments: []), code: "invalid_arguments", exitCode: 1)
        options.lensCorrection = .apple
        assertToolError(try RenderCommand.run(options, arguments: []), code: "unsupported_camera", exitCode: 2)

        // A measurement render (no working-copy meta) still accepts off.
        var measurement = renderOptions(workingCopy: false)
        measurement.calibration = calibration.path
        assertToolError(try RenderCommand.run(measurement, arguments: []), code: "unsupported_camera", exitCode: 2)
    }

    func testRenderWithARegistry() throws {
        try writeNotARaw()
        var options = renderOptions(workingCopy: true)
        options.calibrationRegistry = directory.appendingPathComponent("missing-registry.json").path
        assertToolError(try RenderCommand.run(options, arguments: []), code: "invalid_calibration", exitCode: 4)

        // No entry matches (the file has no make / model): render uncalibrated → decoding fails.
        try writeCalibration("panasonic.json", lensMode: "apple")
        options.calibrationRegistry = try registry([["make": "Panasonic", "model": "DC-S5", "file": "panasonic.json"]])
        assertToolError(try RenderCommand.run(options, arguments: []), code: "unsupported_camera", exitCode: 2)
    }

    func testLensResolution() throws {
        XCTAssertEqual(RenderCommand.resolvedLensMode(requested: .auto, calibration: nil), .apple)
        XCTAssertEqual(RenderCommand.resolvedLensMode(requested: .auto, calibration: .embedded), .embedded)
        XCTAssertEqual(RenderCommand.resolvedLensMode(requested: .auto, calibration: .off), .off)
        XCTAssertEqual(RenderCommand.resolvedLensMode(requested: .apple, calibration: .embedded), .apple)
        XCTAssertEqual(RenderCommand.resolvedLensMode(requested: .off, calibration: .embedded), .off)
        for mode in [LensCorrectionMode.auto, .apple, .embedded] {
            XCTAssertNoThrow(try RenderCommand.requireLensCorrectionForWorkingCopy(mode))
        }
        assertToolError(try RenderCommand.requireLensCorrectionForWorkingCopy(.off), code: "invalid_arguments", exitCode: 1)
    }
}
