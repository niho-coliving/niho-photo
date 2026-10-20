import XCTest
@testable import apple_raw_linear

final class ArgumentParserTests: XCTestCase {
    func testRenderDefaults() throws {
        let command = try ArgumentParser.parse(["render", "a.RW2", "--out", "a.tiff"])
        guard case let .render(options) = command else { return XCTFail("\(command)") }
        XCTAssertEqual(options.input, "a.RW2")
        XCTAssertEqual(options.out, "a.tiff")
        XCTAssertNil(options.meta)
        XCTAssertEqual(options.decoderVersion, "8")
        XCTAssertFalse(options.allowFallback)
        XCTAssertEqual(options.longEdge, .pixels(2560))
        XCTAssertEqual(options.space, .linearProPhoto)
        XCTAssertEqual(options.encoding, .tiff32f)
        XCTAssertEqual(options.lensCorrection, .auto)
        XCTAssertEqual(options.boost, 0)
        XCTAssertEqual(options.nr, .default)
        XCTAssertEqual(options.sharpen, .default)
        XCTAssertNil(options.calibration)
        XCTAssertNil(options.calibrationRegistry)
    }

    func testRenderOptions() throws {
        let command = try ArgumentParser.parse([
            "render", "a.RW2", "--out=a.png", "--meta", "m.json", "--decoder-version", "7",
            "--allow-fallback", "--long-edge", "full", "--encoding", "png16-g18",
            "--calibration", "c.json", "--lens-correction", "off", "--boost=0.5",
            "--nr", "off", "--sharpen", "off",
        ])
        guard case let .render(options) = command else { return XCTFail("\(command)") }
        XCTAssertEqual(options.out, "a.png")
        XCTAssertEqual(options.meta, "m.json")
        XCTAssertEqual(options.decoderVersion, "7")
        XCTAssertTrue(options.allowFallback)
        XCTAssertEqual(options.longEdge, .full)
        XCTAssertEqual(options.encoding, .png16g18)
        XCTAssertEqual(options.calibration, "c.json")
        XCTAssertEqual(options.lensCorrection, .off)
        XCTAssertEqual(options.boost, 0.5)
        XCTAssertEqual(options.nr, .off)
        XCTAssertEqual(options.sharpen, .off)

        let assigned = AssignedSettings(decoderVersion: "7", options: options, scaleFactor: 1)
        XCTAssertEqual(assigned.luminanceNoiseReductionAmount, 0)
        XCTAssertEqual(assigned.colorNoiseReductionAmount, 0)
        XCTAssertEqual(assigned.sharpnessAmount, 0)
        XCTAssertFalse(assigned.isLensCorrectionEnabled)
        XCTAssertEqual(assigned.assignmentOrder.first, "decoderVersion")
        XCTAssertEqual(assigned.assignmentOrder.last, "scaleFactor")
    }

    func testRejectsInvalidInput() {
        let cases: [[String]] = [
            ["render", "a.RW2"],
            ["render", "--out", "a.tiff"],
            ["render", "a.RW2", "b.RW2", "--out", "a.tiff"],
            ["render", "a.RW2", "--out", "a.tiff", "--long-edge", "0"],
            ["render", "a.RW2", "--out", "a.tiff", "--long-edge", "half"],
            ["render", "a.RW2", "--out", "a.tiff", "--space", "srgb"],
            ["render", "a.RW2", "--out", "a.tiff", "--boost", "1.5"],
            ["render", "a.RW2", "--out", "a.tiff", "--boost", "nan"],
            ["render", "a.RW2", "--out", "a.tiff", "--nr", "low"],
            ["render", "a.RW2", "--out", "a.tiff", "--out", "b.tiff"],
            ["render", "a.RW2", "--out", "a.tiff", "--unknown"],
            ["render", "a.RW2", "--out", "a.png", "--encoding", "png16-g18", "--space", "linear-srgb"],
            ["render", "a.RW2", "--out", "a.tiff", "--working-copy-meta", "a.json"],
            ["render", "a.RW2", "--out", "a.tiff", "--encoding", "tiff16", "--working-copy-meta", "a.json"],
            ["render", "a.RW2", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json", "--boost", "0.5"],
            ["render", "a.RW2", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta"],
            ["render", "a.RW2", "--out", "a.tiff", "--calibration", "c.json", "--calibration-registry", "r.json"],
            ["render", "a.RW2", "--out", "a.tiff", "--calibration-registry"],
            ["render", "a.RW2", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json",
             "--lens-correction", "off"],
            ["info"],
            ["cameras", "extra"],
            ["registry"],
            ["registry", "a.json", "b.json"],
            ["registry", "a.json", "--json"],
            ["unknown"],
        ]
        for arguments in cases {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments", "\(arguments)")
                XCTAssertEqual((error as? ToolError)?.exitCode, 1, "\(arguments)")
            }
        }
    }

    func testWorkingCopyMeta() throws {
        let command = try ArgumentParser.parse([
            "render", "a.RW2", "--out", "wc/a.png", "--encoding", "png16-g18",
            "--calibration", "c.json", "--working-copy-meta=wc/a.json",
        ])
        guard case let .render(options) = command else { return XCTFail("\(command)") }
        XCTAssertEqual(options.workingCopyMeta, "wc/a.json")
        XCTAssertNil(options.meta)
        XCTAssertEqual(options.encoding, .png16g18)
        XCTAssertEqual(options.calibration, "c.json")
        // Without a calibration too (baselineEV 0, no asShotWhiteAdobe).
        XCTAssertNoThrow(try ArgumentParser.parse([
            "render", "a.RW2", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json",
        ]))
        XCTAssertNil(try parseRenderOptions(["render", "a.RW2", "--out", "a.tiff"]).workingCopyMeta)
    }

    func testSignedWorkingCopyRecipeAcceptsFullAnd2560() throws {
        for longEdge in ["full", "2560"] {
            let options = try parseRenderOptions([
                "render", "a.ARW", "--out", "a.png", "--working-copy-meta", "a.json",
                "--encoding", "png16-signed-g18", "--long-edge", longEdge,
                "--nr", "off", "--gamut-mapping", "off",
                "--calibration-registry", "calibration/apple-signed-registry.json",
            ])
            XCTAssertEqual(options.encoding, .png16SignedG18)
            XCTAssertEqual(options.nr, .off)
            XCTAssertEqual(options.gamutMapping, .off)
            XCTAssertEqual(options.sharpen, .default)
            XCTAssertEqual(options.boost, 0)
            XCTAssertNil(options.white)
            XCTAssertTrue(options.encoding.isWorkingCopy)
            XCTAssertFalse(options.encoding.appliesBaselineEV)
        }
    }

    func testSignedWorkingCopyRejectsEveryRecipeMismatchBeforeRendering() {
        let valid = [
            "render", "a.ARW", "--out", "a.png", "--encoding", "png16-signed-g18",
            "--nr", "off", "--gamut-mapping", "off",
        ]
        let cases: [[String]] = [
            // The two non-default settings must be explicit.
            ["render", "a.ARW", "--out", "a.png", "--encoding", "png16-signed-g18", "--gamut-mapping", "off"],
            ["render", "a.ARW", "--out", "a.png", "--encoding", "png16-signed-g18", "--nr", "off"],
            valid + ["--space", "linear-srgb"],
            valid + ["--white", "5000,0"],
            valid + ["--boost", "0.1"],
            ["render", "a.ARW", "--out", "a.png", "--encoding", "png16-signed-g18",
             "--nr", "default", "--gamut-mapping", "off"],
            ["render", "a.ARW", "--out", "a.png", "--encoding", "png16-signed-g18",
             "--nr", "off", "--gamut-mapping", "on"],
            valid + ["--sharpen", "off"],
            valid + ["--lens-correction", "off"],
        ]
        for arguments in cases {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments", "\(arguments)")
            }
        }
    }

    func testCalibrationRegistry() throws {
        let options = try parseRenderOptions([
            "render", "a.ARW", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json",
            "--calibration-registry=calibration/apple-registry.json",
        ])
        XCTAssertEqual(options.calibrationRegistry, "calibration/apple-registry.json")
        XCTAssertNil(options.calibration)
        XCTAssertEqual(options.lensCorrection, .auto)
        // A working copy may name the correction, but never off.
        for mode in ["auto", "apple", "embedded", "on"] {
            XCTAssertNoThrow(try ArgumentParser.parse([
                "render", "a.ARW", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json",
                "--lens-correction", mode,
            ]), mode)
        }
        // Measurement renders keep accepting off.
        XCTAssertEqual(try parseRenderOptions(["render", "a.ARW", "--out", "a.tiff", "--lens-correction", "off"]).lensCorrection, .off)
    }

    func testGamutMappingAndWhite() throws {
        let defaults = try parseRenderOptions(["render", "a.ARW", "--out", "a.tiff"])
        XCTAssertEqual(defaults.gamutMapping, .auto)
        XCTAssertNil(defaults.white)
        for mode in GamutMappingMode.allCases {
            XCTAssertEqual(
                try parseRenderOptions(["render", "a.ARW", "--out", "a.tiff", "--gamut-mapping", mode.rawValue]).gamutMapping,
                mode
            )
        }
        let cases: [(String, LightroomWhite)] = [
            ("5001,10", LightroomWhite(temperature: 5001, tint: 10)),
            ("3200,-15.5", LightroomWhite(temperature: 3200, tint: -15.5)),
            (" 5500 , -3 ", LightroomWhite(temperature: 5500, tint: -3)),
            // Wider than developSettings: Apple-scale grid nodes (fit_wb_table.py).
            ("1000,-250", LightroomWhite(temperature: 1000, tint: -250)),
            ("100000,250", LightroomWhite(temperature: 100_000, tint: 250)),
            ("1903.2512,160.0417", LightroomWhite(temperature: 1903.2512, tint: 160.0417)),
        ]
        for (value, expected) in cases {
            XCTAssertEqual(try parseRenderOptions(["render", "a.ARW", "--out", "a.tiff", "--white", value]).white, expected, value)
        }
        let inline = try parseRenderOptions([
            "render", "a.ARW", "--out", "a.tiff", "--white=3200,-15.5", "--gamut-mapping=off", "--lens-correction", "off",
        ])
        XCTAssertEqual(inline.white, LightroomWhite(temperature: 3200, tint: -15.5))
        XCTAssertEqual(inline.gamutMapping, .off)
        // A png16-g18 measurement render may use --white; only the working copy may not.
        XCTAssertNoThrow(try ArgumentParser.parse([
            "render", "a.ARW", "--out", "a.png", "--encoding", "png16-g18", "--white", "5000,0",
        ]))
        // A working copy may choose the gamut mapping.
        XCTAssertEqual(try parseRenderOptions([
            "render", "a.ARW", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json",
            "--gamut-mapping", "off",
        ]).gamutMapping, .off)
    }

    func testRejectsInvalidWhiteAndGamutMapping() {
        let whites = [
            "5000", "5000,10,3", "abc,1", "5000,x", "5000,", ",10", "", "5000;10",
            "999,0", "100001,0", "5000,251", "5000,-250.5", "nan,0", "5000,nan", "inf,0", "-5000,0",
        ]
        var cases: [[String]] = whites.map { ["render", "a.ARW", "--out", "a.tiff", "--white", $0] }
        cases += [
            ["render", "a.ARW", "--out", "a.tiff", "--gamut-mapping", "maybe"],
            ["render", "a.ARW", "--out", "a.tiff", "--gamut-mapping", "true"],
            ["render", "a.ARW", "--out", "a.tiff", "--white"],
            ["render", "a.ARW", "--out", "a.tiff", "--white", "5000,0", "--white", "6000,0"],
            // A working copy is always as shot.
            ["render", "a.ARW", "--out", "a.png", "--encoding", "png16-g18", "--working-copy-meta", "a.json",
             "--white", "5000,0"],
        ]
        for arguments in cases {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments", "\(arguments)")
                XCTAssertEqual((error as? ToolError)?.exitCode, 1, "\(arguments)")
            }
        }
    }

    func testAssignedGamutMappingAndNeutral() throws {
        var options = try parseRenderOptions(["render", "a.ARW", "--out", "a.tiff"])
        let pinned = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1)
        XCTAssertTrue(pinned.isGamutMappingEnabled, "auto without a calibration = on (0.4.0)")
        XCTAssertNil(pinned.neutralChromaticity)
        XCTAssertFalse(pinned.assignmentOrder.contains("neutralChromaticity"))
        XCTAssertNil(pinned.json["neutralChromaticity"])
        XCTAssertEqual(pinned.calibrationComparable["gamutMapping"], .bool(true))

        options.gamutMapping = .off
        let off = AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1)
        XCTAssertFalse(off.isGamutMappingEnabled)
        XCTAssertEqual(off.json["isGamutMappingEnabled"] as? Bool, false)
        XCTAssertEqual(off.calibrationComparable["gamutMapping"], .bool(false))
        XCTAssertTrue(off.assignmentOrder.contains("isGamutMappingEnabled"))
        // The resolved flag wins over the options.
        XCTAssertTrue(AssignedSettings(decoderVersion: "8", options: options, scaleFactor: 1, gamutMapping: true).isGamutMappingEnabled)

        let white = AssignedSettings(
            decoderVersion: "8",
            options: options,
            scaleFactor: 0.5,
            gamutMapping: false,
            neutralChromaticity: CGPoint(x: 0.35, y: 0.36)
        )
        // After every other setting, right before scaleFactor.
        XCTAssertEqual(Array(white.assignmentOrder.suffix(2)), ["neutralChromaticity", "scaleFactor"])
        let json = try XCTUnwrap(white.json["neutralChromaticity"] as? [String: Any])
        XCTAssertEqual((json["x"] as? NSNumber)?.doubleValue, 0.35)
        XCTAssertEqual((json["y"] as? NSNumber)?.doubleValue, 0.36)
    }

    private func parseRenderOptions(_ arguments: [String]) throws -> RenderOptions {
        guard case let .render(options) = try ArgumentParser.parse(arguments) else {
            throw ToolError.invalidArguments("not a render command")
        }
        return options
    }

    func testInfoAndCameras() throws {
        XCTAssertEqual(
            try ArgumentParser.parse(["info", "a.RW2", "--json"]),
            .info(InfoOptions(input: "a.RW2", json: true, decoderVersion: nil))
        )
        XCTAssertEqual(
            try ArgumentParser.parse(["cameras", "--out", "c.txt"]),
            .cameras(CamerasOptions(out: "c.txt"))
        )
        XCTAssertEqual(try ArgumentParser.parse([]), .help)
        XCTAssertEqual(try ArgumentParser.parse(["render", "--help"]), .help)
        XCTAssertEqual(try ArgumentParser.parse(["version"]), .version)
        XCTAssertEqual(
            try ArgumentParser.parse(["registry", "calibration/apple-registry.json"]),
            .registry(RegistryOptions(registry: "calibration/apple-registry.json"))
        )
    }

    func testRasterDefaults() throws {
        let command = try ArgumentParser.parse(["raster", "IMG_0001.HEIC", "--out", "wc.jpg"])
        XCTAssertEqual(command, .raster(RasterOptions(input: "IMG_0001.HEIC", out: "wc.jpg")))
        guard case let .raster(options) = command else { return XCTFail("\(command)") }
        XCTAssertNil(options.previewOut)
        XCTAssertNil(options.meta)
        XCTAssertEqual(options.longEdge, .pixels(2560))
        XCTAssertEqual(options.quality, 0.94)
    }

    func testRasterOptions() throws {
        let command = try ArgumentParser.parse([
            "raster", "a.tif", "--out=wc.jpg", "--preview-out", "p.jpg", "--meta", "m.json",
            "--long-edge", "1200", "--quality=0.9",
        ])
        XCTAssertEqual(command, .raster(RasterOptions(
            input: "a.tif", out: "wc.jpg", previewOut: "p.jpg", meta: "m.json", longEdge: .pixels(1200), quality: 0.9
        )))
        XCTAssertEqual(
            try ArgumentParser.parse(["raster", "a.tif", "--out", "full.jpg", "--long-edge", "full"]),
            .raster(RasterOptions(input: "a.tif", out: "full.jpg", longEdge: .full))
        )
        for quality in ["0", "1", "0.5"] {
            XCTAssertNoThrow(try ArgumentParser.parse(["raster", "a.png", "--out", "o.jpg", "--quality", quality]), quality)
        }
        XCTAssertEqual(try ArgumentParser.parse(["raster", "--help"]), .help)
        // `--` ends the options: a file named like an option.
        XCTAssertEqual(
            try ArgumentParser.parse(["raster", "--out", "o.jpg", "--", "-x.png"]),
            .raster(RasterOptions(input: "-x.png", out: "o.jpg"))
        )
    }

    func testRasterRejectsInvalidInput() {
        let cases: [[String]] = [
            ["raster"],
            ["raster", "a.heic"],
            ["raster", "--out", "o.jpg"],
            ["raster", "a.heic", "b.heic", "--out", "o.jpg"],
            ["raster", "a.heic", "--out", "o.jpg", "--out", "p.jpg"],
            ["raster", "a.heic", "--out", "o.jpg", "--long-edge", "0"],
            ["raster", "a.heic", "--out", "o.jpg", "--long-edge", "-5"],
            ["raster", "a.heic", "--out", "o.jpg", "--long-edge", "2560.5"],
            ["raster", "a.heic", "--out", "o.jpg", "--quality", "1.5"],
            ["raster", "a.heic", "--out", "o.jpg", "--quality", "-0.1"],
            ["raster", "a.heic", "--out", "o.jpg", "--quality", "nan"],
            ["raster", "a.heic", "--out", "o.jpg", "--quality", "high"],
            ["raster", "a.heic", "--out", "o.jpg", "--preview-out"],
            ["raster", "a.heic", "--out", "o.jpg", "--space", "linear-srgb"],
            ["raster", "a.heic", "--out", "o.jpg", "--encoding", "png16-g18"],
            ["raster", "a.heic", "--out", "o.jpg", "--unknown"],
            ["raster", "a.heic", "--out", "o.jpg", "--json"],
        ]
        for arguments in cases {
            XCTAssertThrowsError(try ArgumentParser.parse(arguments), "\(arguments)") { error in
                XCTAssertEqual((error as? ToolError)?.code, "invalid_arguments", "\(arguments)")
                XCTAssertEqual((error as? ToolError)?.exitCode, 1, "\(arguments)")
            }
        }
    }

    func testRasterErrorCodes() {
        XCTAssertEqual(ToolError.decodeFailed("x").code, "decode_failed")
        XCTAssertEqual(ToolError.decodeFailed("x").exitCode, 4)
        XCTAssertEqual(ToolError.encodeFailed("x").code, "encode_failed")
        XCTAssertEqual(ToolError.encodeFailed("x").exitCode, 4)
        XCTAssertEqual(ToolError.unsupportedProfile("x").code, "unsupported_profile")
        XCTAssertEqual(ToolError.unsupportedProfile("x").exitCode, 3)
    }

    func testScaleFactor() {
        XCTAssertEqual(RawRenderer.scaleFactor(longEdge: .pixels(2560), nativeWidth: 6000, nativeHeight: 4000), Float(2560.0 / 6000.0))
        XCTAssertEqual(RawRenderer.scaleFactor(longEdge: .pixels(1500), nativeWidth: 4000, nativeHeight: 6000), 0.25)
        XCTAssertEqual(RawRenderer.scaleFactor(longEdge: .pixels(9000), nativeWidth: 6000, nativeHeight: 4000), 1)
        XCTAssertEqual(RawRenderer.scaleFactor(longEdge: .full, nativeWidth: 6000, nativeHeight: 4000), 1)
    }

    func testPixelBoundsDropFractionalEdges() {
        XCTAssertEqual(
            RawRenderer.pixelBounds(for: CGRect(x: 0, y: 0, width: 2560, height: 1706.67)),
            CGRect(x: 0, y: 0, width: 2560, height: 1706)
        )
        XCTAssertNil(RawRenderer.pixelBounds(for: .infinite))
        XCTAssertNil(RawRenderer.pixelBounds(for: .null))
    }

    func testErrorLineIsSingleLineJSON() throws {
        let line = ToolError.unsupportedDecoderVersion("decoderVersion 6 is not supported").jsonLine
        XCTAssertFalse(line.contains("\n"))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String]
        )
        XCTAssertEqual(object, ["error": "unsupported_decoder_version", "message": "decoderVersion 6 is not supported"])
    }

    func testJSONNumbersAreShortestDecimals() throws {
        let line = JSONOutput.singleLine(["a": JSONOutput.number(Float(0.05)), "b": JSONOutput.number(Float.nan)])
        XCTAssertEqual(line, #"{"a":0.05,"b":null}"#)
    }
}
