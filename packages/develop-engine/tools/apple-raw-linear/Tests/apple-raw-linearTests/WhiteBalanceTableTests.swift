import XCTest
@testable import apple_raw_linear

/// The calibration's `whiteBalanceTable` (`niho-develop-wb-table/v1`, S11
/// #17108): decoding, evaluation against `calibrate/wbtable.py`, `--white`,
/// the render-time check and the working-copy metadata.
final class WhiteBalanceTableTests: XCTestCase {
    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"),
            "missing fixture \(name).json"
        )
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

    // MARK: - Synthetic tables

    private static let mired: [Double] = [100, 200, 400]
    private static let tint: [Double] = [-50, 0, 50]

    /// Entry k of node n: `A_k + 0.01 · ((7n + 3k) mod 11) / 11` (not
    /// bilinear): the table the expected values below were computed from
    /// with `wbtable.WhiteBalanceTable` (Python 3.14 / numpy 2.3.5).
    private static func pythonNodes() -> [[Double]] {
        let base: [Double] = [0.9, 0.05, 0.02, 0.03, 1.0, 0.01, 0.01, 0.04, 1.1]
        return (0 ..< mired.count * tint.count).map { (n: Int) -> [Double] in
            (0 ..< 9).map { (k: Int) -> Double in
                let step = Double((7 * n + 3 * k) % 11)
                return base[k] + 0.01 * step / 11
            }
        }
    }

    private static func tableObject(
        mired: [Double] = mired,
        tint: [Double] = tint,
        inverseMatrices: [[Double]] = pythonNodes(),
        extra: [String: Any] = [:]
    ) -> [String: Any] {
        var object: [String: Any] = [
            "schema": "niho-develop-wb-table/v1",
            "space": "apple-linear-prophoto-d50",
            "scale": "lightroom",
            "reference": ["temperature": 5000, "tint": 0],
            "mired": mired,
            "tint": tint,
            "inverseMatrices": inverseMatrices,
            "measured": ["raws": ["P1012822", "DSC00012"], "residualMax": 0.0021, "macOSBuild": "26A428"],
            "note": "kept as written",
        ]
        object.merge(extra) { _, new in new }
        return object
    }

    private static func targetMapObject() -> [String: Any] {
        [
            "schema": "niho-develop-wb-target-map/v1",
            "kelvin": [4000, 5500, 7500, 10000],
            "temperatureOffsets": [0, 50, 800, 0],
            "tintOffsets": [0, -10, -10, 0],
            "fullDeltaMired": 12,
            "fullDeltaTint": 6,
        ]
    }

    /// The DC-S5 fixture (`calibration-wbmap`) with `whiteBalanceTable` =
    /// `table` (nil = absent), `decoder.settings.gamutMapping` and the map's
    /// model (nil = no map).
    private func calibration(
        table: Any?,
        gamutMapping: Bool = false,
        mapModel: String? = "uv-offset"
    ) throws -> Calibration {
        var json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: try fixture("calibration-wbmap"))) as? [String: Any]
        )
        if var decoder = json["decoder"] as? [String: Any], var settings = decoder["settings"] as? [String: Any] {
            settings["gamutMapping"] = gamutMapping
            decoder["settings"] = settings
            json["decoder"] = decoder
        }
        if let table {
            json["whiteBalanceTable"] = table
        }
        if let mapModel, var map = json["whiteBalanceMap"] as? [String: Any] {
            map["model"] = mapModel
            json["whiteBalanceMap"] = map
        } else {
            json["whiteBalanceMap"] = NSNull()
        }
        return try Calibration.parse(data: try JSONSerialization.data(withJSONObject: json), path: "wb-table.json")
    }

    private func table() throws -> WhiteBalanceTable {
        try XCTUnwrap(try calibration(table: Self.tableObject()).whiteBalanceTable)
    }

    // MARK: - Decoding

    func testTableRejectsMultipleCalibrationMatrices() throws {
        var json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: try fixture("calibration-illuminants"))) as? [String: Any]
        )
        json["whiteBalanceTable"] = Self.tableObject()
        let data = try JSONSerialization.data(withJSONObject: json)

        assertToolError(
            try Calibration.parse(data: data, path: "two-illuminant-table.json"),
            code: "unsupported_calibration_feature",
            exitCode: 3
        )
    }

    func testTableIsDecodedAndKeptAsWritten() throws {
        let calibration = try calibration(table: Self.tableObject())
        let table = try XCTUnwrap(calibration.whiteBalanceTable)
        XCTAssertEqual(table.mired, Self.mired)
        XCTAssertEqual(table.tint, Self.tint)
        XCTAssertEqual(table.inverseMatrices.count, 9)
        // Node (iMired 1, iTint 2) = index 1 * 3 + 2.
        XCTAssertEqual(table.inverseMatrices[5].flat, Self.pythonNodes()[5])
        XCTAssertEqual(table.object["note"], .string("kept as written"))
        XCTAssertNotNil(table.object["measured"])
        XCTAssertNotNil(table.object["reference"])
        XCTAssertEqual(calibration.gamutMapping, false)
        let summary = try XCTUnwrap(calibration.metadataSource["whiteBalanceTable"] as? [String: Any])
        XCTAssertEqual(summary["nodes"] as? Int, 9)
        XCTAssertEqual(summary["schema"] as? String, WhiteBalanceTable.schema)

        // null / absent → no table (every calibration before S11).
        XCTAssertNil(try self.calibration(table: NSNull()).whiteBalanceTable)
        let absent = try self.calibration(table: nil)
        XCTAssertNil(absent.whiteBalanceTable)
        XCTAssertTrue(absent.metadataSource["whiteBalanceTable"] is NSNull)
        XCTAssertNil(try Calibration.load(path: try fixture("calibration-identity").path).whiteBalanceTable)
    }

    func testMalformedTablesAreInvalid() throws {
        let nodes = Self.pythonNodes()
        var singular = nodes
        singular[5] = [1, 2, 3, 2, 4, 6, 0, 0, 1]
        var short = nodes
        short[2] = Array(nodes[2].prefix(8))
        var mixed: [Any] = nodes
        mixed[1] = (Array(nodes[1].dropLast()) as [Any]) + ["x"]
        var noSchema = Self.tableObject()
        noSchema.removeValue(forKey: "schema")
        let cases: [(fragment: String, table: Any)] = [
            (".schema", Self.tableObject(extra: ["schema": "niho-develop-wb-table/v2"])),
            (".schema", noSchema),
            (".space", Self.tableObject(extra: ["space": "apple-linear-srgb"])),
            (".scale", Self.tableObject(extra: ["scale": "apple"])),
            (".mired", Self.tableObject(mired: [100, 400, 200])),
            (".mired", Self.tableObject(mired: [100, 100, 400])),
            (".mired", Self.tableObject(mired: [0, 200, 400])),
            (".mired", Self.tableObject(mired: [-100, 200, 400])),
            (".mired", Self.tableObject(mired: [100], inverseMatrices: Array(nodes.prefix(3)))),
            (".tint", Self.tableObject(tint: [50, 0, -50])),
            (".tint", Self.tableObject(extra: ["tint": [-50, "0", 50] as [Any]])),
            (".tint", Self.tableObject(extra: ["tint": NSNull()])),
            (".inverseMatrices", Self.tableObject(inverseMatrices: Array(nodes.dropLast()))),
            (".inverseMatrices", Self.tableObject(inverseMatrices: nodes + [nodes[0]])),
            (".inverseMatrices", Self.tableObject(extra: ["inverseMatrices": "none"])),
            (".inverseMatrices[2] (mired 100.0, tint 50.0)", Self.tableObject(inverseMatrices: short)),
            (".inverseMatrices[1]", Self.tableObject(extra: ["inverseMatrices": mixed])),
            (".inverseMatrices[5] (mired 200.0, tint 50.0) is singular", Self.tableObject(inverseMatrices: singular)),
            ("whiteBalanceTable must be an object", true),
            ("whiteBalanceTable must be an object", [1, 2, 3]),
        ]
        for item in cases {
            XCTAssertThrowsError(try calibration(table: item.table), item.fragment) { error in
                let toolError = error as? ToolError
                XCTAssertEqual(toolError?.code, "invalid_calibration", item.fragment)
                XCTAssertEqual(toolError?.exitCode, 4, item.fragment)
                let message = toolError?.message ?? ""
                XCTAssertTrue(message.hasPrefix("wb-table.json: whiteBalanceTable"), message)
                XCTAssertTrue(message.contains(item.fragment), "\(item.fragment): \(message)")
            }
        }
    }

    func testTargetMapIsValidatedPreservedAndDoesNotChangeTheSelfCheckTable() throws {
        let targetMap = Self.targetMapObject()
        let legacy = try XCTUnwrap(try calibration(table: Self.tableObject()).whiteBalanceTable)
        let mapped = try XCTUnwrap(
            try calibration(table: Self.tableObject(extra: ["targetMap": targetMap])).whiteBalanceTable
        )
        let parsed = try XCTUnwrap(mapped.targetMap)
        XCTAssertEqual(parsed.kelvin, [4000, 5500, 7500, 10000])
        XCTAssertEqual(parsed.temperatureOffsets, [0, 50, 800, 0])
        XCTAssertEqual(parsed.tintOffsets, [0, -10, -10, 0])
        XCTAssertEqual(parsed.fullDeltaMired, 12)
        XCTAssertEqual(parsed.fullDeltaTint, 6)
        XCTAssertNotNil(mapped.object["targetMap"])

        // Stage 1 verifies the original Apple table. The target map is only
        // interpreted after the working copy reaches stage 2.
        let from = LightroomWhite(temperature: 4300, tint: 7)
        let target = LightroomWhite(temperature: 7500, tint: 0)
        let oldTransfer = try XCTUnwrap(legacy.transfer(from: from, to: target))
        let checkTransfer = try XCTUnwrap(mapped.transfer(from: from, to: target))
        XCTAssertLessThan(checkTransfer.maxAbsDifference(to: oldTransfer), 1e-12)

        let calibration = try self.calibration(table: Self.tableObject(extra: ["targetMap": targetMap]))
        let table = try XCTUnwrap(calibration.whiteBalanceTable)
        let check = WhiteBalanceTableCheck(white: target, asShot: from, residual: 0, pixels: 1000, ms: 1)
        let built = WorkingCopy.metadata(
            neutral: neutral,
            calibration: calibration,
            decoderVersion: "8",
            whiteBalanceTable: CheckedWhiteBalanceTable(
                table: table,
                calibrationMatrix: calibration.matrix,
                check: check
            ),
            source: [:]
        )
        let written = try XCTUnwrap(
            (try roundTrip(built.json)["whiteBalanceTable"] as? [String: Any])?["targetMap"] as? [String: Any]
        )
        XCTAssertEqual(written["schema"] as? String, "niho-develop-wb-target-map/v1")
        XCTAssertEqual(written["kelvin"] as? [Int], [4000, 5500, 7500, 10000])
    }

    func testMalformedTargetMapsAreInvalid() throws {
        func changed(_ key: String, _ value: Any) -> [String: Any] {
            var map = Self.targetMapObject()
            map[key] = value
            return map
        }
        let cases: [(fragment: String, map: Any)] = [
            (".targetMap must be an object", NSNull()),
            (".targetMap.schema", changed("schema", "niho-develop-wb-target-map/v2")),
            (".targetMap.kelvin", changed("kelvin", [4000, 4000, 10000])),
            (".targetMap.kelvin must be within", changed("kelvin", [1999, 5500, 7500, 10000])),
            (".targetMap.temperatureOffsets", changed("temperatureOffsets", [0, 50, 0])),
            (".targetMap.tintOffsets must be 0", changed("tintOffsets", [1, -10, -10, 0])),
            (
                ".targetMap mapped kelvin must be strictly ascending",
                changed("temperatureOffsets", [0, -2000, 800, 0])
            ),
            (
                ".targetMap mapped kelvin must be within",
                changed("temperatureOffsets", [0, 50, 43000, 0])
            ),
            (".targetMap.fullDeltaMired", changed("fullDeltaMired", 0)),
            (".targetMap.fullDeltaTint", changed("fullDeltaTint", "6")),
        ]
        for item in cases {
            let table = Self.tableObject(extra: ["targetMap": item.map])
            XCTAssertThrowsError(try calibration(table: table), item.fragment) { error in
                let toolError = error as? ToolError
                XCTAssertEqual(toolError?.code, "invalid_calibration", item.fragment)
                XCTAssertEqual(toolError?.exitCode, 4, item.fragment)
                XCTAssertTrue(toolError?.message.contains(item.fragment) == true, toolError?.message ?? "")
            }
        }
    }

    // MARK: - Evaluation

    func testCellIsNumpysSearchsorted() {
        let grid: [Double] = [0, 10, 20]
        func cell(_ value: Double) -> [Double] {
            let result = WhiteBalanceTable.cell(grid, value)
            return [Double(result.index), result.weight]
        }
        XCTAssertEqual(cell(5), [0, 0.5])
        XCTAssertEqual(cell(10), [1, 0])
        XCTAssertEqual(cell(20), [1, 1])
        XCTAssertEqual(cell(-5), [0, 0])
        XCTAssertEqual(cell(25), [1, 1])
    }

    func testEvaluationIsExactAtTheNodes() throws {
        let table = try table()
        let nodes = Self.pythonNodes()
        for (i, mired) in Self.mired.enumerated() {
            for (j, tint) in Self.tint.enumerated() {
                let white = LightroomWhite(temperature: 1e6 / mired, tint: tint)
                let expected = try XCTUnwrap(Matrix3(flat: nodes[i * Self.tint.count + j]))
                XCTAssertLessThan(table.inverse(white).maxAbsDifference(to: expected), 1e-12, "node (\(i), \(j))")
                let matrix = try XCTUnwrap(table.matrix(white))
                XCTAssertLessThan((matrix * expected).maxAbsDifference(to: .identity), 1e-12, "node (\(i), \(j))")
            }
        }
    }

    /// `wbtable.WhiteBalanceTable.inverse` / `transfer` on the same table.
    func testEvaluationMatchesWBTablePy() throws {
        let table = try table()
        let python: [(white: LightroomWhite, inverse: [Double])] = [
            (LightroomWhite(temperature: 3000, tint: 12), [
                0.9039757575757575, 0.05670303030303031, 0.021830303030303033,
                0.03375757575757575, 1.0048848484848485, 0.01761212121212121,
                0.01273939393939394, 0.04306666666666667, 1.1057939393939396,
            ]),
            (LightroomWhite(temperature: 6250, tint: -37.5), [
                0.9055454545454547, 0.05377272727272728, 0.024,
                0.036727272727272726, 1.0019545454545455, 0.013681818181818184,
                0.01490909090909091, 0.047636363636363636, 1.1028636363636364,
            ]),
            // Outside the grid: 50 mired → 100, tint 80 → 50.
            (LightroomWhite(temperature: 20000, tint: 80), [
                0.9027272727272727, 0.05545454545454546, 0.028181818181818183,
                0.030909090909090907, 1.0036363636363637, 0.016363636363636365,
                0.019090909090909092, 0.04181818181818182, 1.1045454545454547,
            ]),
            // 667 mired → 400, tint −70 → −50.
            (LightroomWhite(temperature: 1500, tint: -70), [
                0.9081818181818182, 0.05090909090909091, 0.023636363636363636,
                0.03636363636363636, 1.009090909090909, 0.011818181818181818,
                0.014545454545454545, 0.04727272727272727, 1.1,
            ]),
        ]
        for item in python {
            let expected = try XCTUnwrap(Matrix3(flat: item.inverse))
            XCTAssertLessThan(table.inverse(item.white).maxAbsDifference(to: expected), 1e-15, "\(item.white)")
        }
        let transfer = try XCTUnwrap(table.transfer(
            from: LightroomWhite(temperature: 3200, tint: -4.5),
            to: LightroomWhite(temperature: 5200, tint: 15.5)
        ))
        let expected = try XCTUnwrap(Matrix3(flat: [
            1.0009626637006388, -7.860805343506132e-05, -0.0024985340098256175,
            0.0008732992739897451, 1.0004660762496642, 0.000582605438964756,
            -0.002059336496933564, 0.0007720671377575466, 0.9999842228878217,
        ]))
        XCTAssertLessThan(transfer.maxAbsDifference(to: expected), 1e-12)
    }

    /// Bilinear in (mired, tint) between the nodes: a table sampled from
    /// `I(m, t) = A + m·B + t·C + m·t·D` is reproduced exactly inside the
    /// grid, and clamped to its edges outside.
    func testEvaluationIsBilinearAndClamped() throws {
        let a = Matrix3(SIMD3(0.9, 0.05, 0.02), SIMD3(0.03, 1.0, 0.01), SIMD3(0.01, 0.04, 1.1))
        let b = Matrix3(SIMD3(1e-4, 0, 2e-5), SIMD3(0, 5e-5, 0), SIMD3(-3e-5, 0, -1e-4))
        let c = Matrix3(SIMD3(5e-4, 0, 0), SIMD3(1e-4, -3e-4, 0), SIMD3(1e-4, 0, 2e-4))
        let d = Matrix3(SIMD3(1e-6, 0, 0), SIMD3(0, 1e-6, 0), SIMD3(0, 2e-7, 1e-6))
        func exact(_ m: Double, _ t: Double) -> Matrix3 {
            a + b.scaled(by: m) + c.scaled(by: t) + d.scaled(by: m * t)
        }
        let mired: [Double] = [20, 60, 140, 500]
        let tint: [Double] = [-150, -20, 0, 35, 150]
        let nodes = mired.flatMap { m in tint.map { t in exact(m, t).flat } }
        let table = try XCTUnwrap(
            try calibration(table: Self.tableObject(mired: mired, tint: tint, inverseMatrices: nodes)).whiteBalanceTable
        )
        for (m, t) in [(33.3, -100.0), (100, 10), (61, -0.5), (420, 149), (140, 35), (500, -150)] {
            let value = table.inverse(LightroomWhite(temperature: 1e6 / m, tint: t))
            XCTAssertLessThan(value.maxAbsDifference(to: exact(m, t)), 1e-12, "\(m) mired, tint \(t)")
        }
        // Outside the grid: the nearest edge.
        let outside: [(white: LightroomWhite, m: Double, t: Double)] = [
            (LightroomWhite(temperature: 100_000, tint: 250), 20, 150),
            (LightroomWhite(temperature: 1000, tint: -250), 500, -150),
            (LightroomWhite(temperature: 1e6 / 100, tint: 400), 100, 150),
            (LightroomWhite(temperature: 1e6 / 600, tint: 10), 500, 10),
        ]
        for item in outside {
            XCTAssertLessThan(table.inverse(item.white).maxAbsDifference(to: exact(item.m, item.t)), 1e-12, "\(item.white)")
        }
        // A transfer moves an output rendered at a to b: M(b) · I(a) · M(a) = M(b).
        let from = LightroomWhite(temperature: 3300, tint: -7)
        let to = LightroomWhite(temperature: 7200, tint: 25)
        let transfer = try XCTUnwrap(table.transfer(from: from, to: to))
        let fromMatrix = try XCTUnwrap(table.matrix(from))
        let toMatrix = try XCTUnwrap(table.matrix(to))
        XCTAssertLessThan((transfer * fromMatrix).maxAbsDifference(to: toMatrix), 1e-12)
        XCTAssertLessThan(try XCTUnwrap(table.transfer(from: from, to: from)).maxAbsDifference(to: .identity), 1e-12)
    }

    // MARK: - --white

    func testRenderWhite() throws {
        let white = LightroomWhite(temperature: 5000, tint: 0)
        let plain = try XCTUnwrap(RenderWhite.resolve(white, map: nil))
        XCTAssertFalse(plain.mapApplied)
        XCTAssertEqual(plain.lightroom.x, 0.34510414172851334, accuracy: 1e-12)
        XCTAssertEqual(plain.lightroom.y, 0.3516225216009751, accuracy: 1e-12)
        XCTAssertEqual(plain.apple.x, plain.lightroom.x)
        XCTAssertEqual(plain.apple.y, plain.lightroom.y)
        XCTAssertEqual(plain.neutralChromaticity, CGPoint(x: plain.apple.x, y: plain.apple.y))

        // Lightroom → Apple through the inverse map (`wbtable.lightroom_to_apple`).
        let mapped = try XCTUnwrap(RenderWhite.resolve(white, map: WhiteBalanceUVOffset(du: -0.006818, dv: 0.00005)))
        XCTAssertTrue(mapped.mapApplied)
        XCTAssertEqual(mapped.apple.x, 0.35353331360601675, accuracy: 1e-12)
        XCTAssertEqual(mapped.apple.y, 0.34890351398227576, accuracy: 1e-12)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try JSONOutput.pretty(mapped.json)) as? [String: Any]
        )
        XCTAssertEqual(Set(json.keys), ["temperature", "tint", "lightroom", "apple", "mapApplied"])
        XCTAssertEqual(json["temperature"] as? Double, 5000)
        XCTAssertEqual(json["mapApplied"] as? Bool, true)
        let apple = try XCTUnwrap(json["apple"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(apple["x"] as? Double), 0.35353331360601675, accuracy: 1e-15)

        // Below 2000 K the white is not clamped (Apple-scale grid nodes).
        let low = try XCTUnwrap(RenderWhite.resolve(LightroomWhite(temperature: 1900, tint: 12), map: nil))
        XCTAssertEqual(low.apple.x, 0.5474778487058025, accuracy: 1e-12)
        XCTAssertEqual(low.apple.y, 0.4235925125961518, accuracy: 1e-12)

        // Lightroom's corner (2000 K, +150) lies off the diagram (x + y = 1.29);
        // Core Image takes it, so it resolves (`wbtable.lightroom_to_apple`).
        let corner = try XCTUnwrap(RenderWhite.resolve(
            LightroomWhite(temperature: 2000, tint: 150),
            map: WhiteBalanceUVOffset(du: -0.006818, dv: 0.00005)
        ))
        XCTAssertEqual(corner.lightroom.x, 0.6780118729900962, accuracy: 1e-12)
        XCTAssertEqual(corner.lightroom.y, 0.6147154935586289, accuracy: 1e-12)
        XCTAssertEqual(corner.apple.x, 0.6861478404359602, accuracy: 1e-12)
        XCTAssertEqual(corner.apple.y, 0.6082229311069354, accuracy: 1e-12)
        // Every white --white accepts resolves.
        for temperature in [1000.0, 1500, 1903.25, 2000, 5000, 50000, 100_000] {
            for tint in [-250.0, -150, 0, 150, 160.04, 250] {
                XCTAssertNotNil(RenderWhite.resolve(
                    LightroomWhite(temperature: temperature, tint: tint),
                    map: WhiteBalanceUVOffset(du: -0.006818, dv: 0.00005)
                ), "\(temperature) K, tint \(tint)")
            }
        }
    }

    func testRenderRejectsWhiteForAWorkingCopyBeforeDecoding() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-raw-linear-wb-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = directory.appendingPathComponent("not-a-raw.RW2")
        try Data("not a raw file".utf8).write(to: input)
        var options = RenderOptions(input: input.path, out: directory.appendingPathComponent("out.png").path)
        options.encoding = .png16g18
        options.workingCopyMeta = directory.appendingPathComponent("out.json").path
        options.white = LightroomWhite(temperature: 5000, tint: 0)
        // invalid_arguments (1), not unsupported_camera (2): nothing was decoded.
        assertToolError(try RenderCommand.run(options, arguments: []), code: "invalid_arguments", exitCode: 1)
        // A measurement render takes --white and gets as far as decoding.
        options.workingCopyMeta = nil
        options.gamutMapping = .off
        assertToolError(try RenderCommand.run(options, arguments: []), code: "unsupported_camera", exitCode: 2)
    }

    // MARK: - The render-time check

    func testCheckWhite() {
        func white(_ temperature: Double, _ tint: Double) -> LightroomWhite {
            LightroomWhite(temperature: temperature, tint: tint)
        }
        XCTAssertEqual(WhiteBalanceTableCheck.checkWhite(asShot: white(3384.5, 4.25)), white(5384.5, 24.25))
        XCTAssertEqual(WhiteBalanceTableCheck.checkWhite(asShot: white(5000, 0)), white(3000, 20))
        XCTAssertEqual(WhiteBalanceTableCheck.checkWhite(asShot: white(6500, 140)), white(4500, 150))
        XCTAssertEqual(WhiteBalanceTableCheck.checkWhite(asShot: white(1800, -175)), white(3800, -150))
        XCTAssertEqual(WhiteBalanceTableCheck.checkWhite(asShot: white(60000, 0)), white(50000, 20))
        XCTAssertEqual(WhiteBalanceTableCheck.checkWhite(asShot: white(3000, -150)), white(5000, -130))
    }

    private static let transfer = Matrix3(
        SIMD3(1.02, -0.01, 0.0),
        SIMD3(0.005, 0.99, 0.004),
        SIMD3(-0.003, 0.01, 1.03)
    )

    /// RGBA float pixels with channels spread over (0.01, 0.7), mapped by `map`.
    private func pixels(_ count: Int, _ map: (SIMD3<Double>) -> SIMD3<Double> = { $0 }) -> [Float] {
        var values: [Float] = []
        values.reserveCapacity(count * 4)
        for index in 0 ..< count {
            let rgb = SIMD3<Double>(
                0.01 + 0.69 * Double((index * 37) % 101) / 100,
                0.01 + 0.69 * Double((index * 53 + 17) % 103) / 102,
                0.01 + 0.69 * Double((index * 71 + 5) % 107) / 106
            )
            let out = map(rgb)
            values += [Float(out.x), Float(out.y), Float(out.z), 1]
        }
        return values
    }

    private func compare(
        _ r0: [Float],
        _ r1: [Float],
        toTableSpace: Matrix3 = .identity,
        transfer: Matrix3 = transfer
    ) -> (residual: Double?, pixels: Int) {
        r0.withUnsafeBufferPointer { asShot in
            r1.withUnsafeBufferPointer { check in
                WhiteBalanceTableCheck.compare(asShot: asShot, check: check, toTableSpace: toTableSpace, transfer: transfer)
            }
        }
    }

    private let asShot = LightroomWhite(temperature: 3384.5, tint: 4.25)

    func testCheckPassesWhenTheTablePredictsTheRender() throws {
        let exact = compare(pixels(2000), pixels(2000) { Self.transfer.apply($0) })
        XCTAssertEqual(exact.pixels, 2000)
        XCTAssertLessThan(try XCTUnwrap(exact.residual), 1e-6, "only Float storage")
        let check = WhiteBalanceTableCheck(
            white: WhiteBalanceTableCheck.checkWhite(asShot: asShot),
            asShot: asShot,
            residual: exact.residual,
            pixels: exact.pixels,
            ms: 12.5
        )
        XCTAssertEqual(check.status, .ok)
        XCTAssertNil(check.reason)
        XCTAssertNil(check.warning)

        // Core Image's linear sRGB converted to the table's space (ProPhoto) first.
        let toProPhoto = ColorMath.linearSRGBToLinearProPhoto
        let fromProPhoto = ColorMath.linearProPhotoToLinearSRGB
        let converted = compare(
            pixels(2000) { fromProPhoto.apply($0) },
            pixels(2000) { fromProPhoto.apply(Self.transfer.apply($0)) },
            toTableSpace: toProPhoto
        )
        XCTAssertEqual(converted.pixels, 2000)
        XCTAssertLessThan(try XCTUnwrap(converted.residual), 1e-6)

        // Boundaries: 1000 pixels and a residual of exactly 0.01 pass.
        XCTAssertEqual(WhiteBalanceTableCheck(white: asShot, asShot: asShot, residual: 0.01, pixels: 1000, ms: 1).status, .ok)
    }

    func testCheckFailsWhenTheRenderDiffers() throws {
        // 3 % more red than the table predicts.
        let wrong = compare(pixels(2000), pixels(2000) { value in
            let predicted = Self.transfer.apply(value)
            return SIMD3(predicted.x * 1.03, predicted.y, predicted.z)
        })
        XCTAssertEqual(wrong.pixels, 2000)
        let residual = try XCTUnwrap(wrong.residual)
        XCTAssertGreaterThan(residual, 0.01)
        let check = WhiteBalanceTableCheck(white: asShot, asShot: asShot, residual: residual, pixels: wrong.pixels, ms: 12)
        XCTAssertEqual(check.status, .mismatch)
        let warning = try XCTUnwrap(check.warning)
        XCTAssertTrue(warning.hasPrefix("white-balance table check failed: residual \(residual)"), warning)

        // Too few pixels fail even with a perfect prediction.
        let few = WhiteBalanceTableCheck(white: asShot, asShot: asShot, residual: 0, pixels: 999, ms: 1)
        XCTAssertEqual(few.status, .mismatch)
        XCTAssertTrue(few.reason?.contains("999 pixels") == true, few.reason ?? "")
        // No residual.
        XCTAssertEqual(WhiteBalanceTableCheck(white: asShot, asShot: asShot, residual: nil, pixels: 5000, ms: 1).status, .mismatch)
    }

    func testCheckComparesOnlyMidTones() throws {
        var r0 = pixels(1500)
        var r1 = pixels(1500) { Self.transfer.apply($0) }
        // Excluded even where r1 is far off: a channel ≥ 0.8 in r0, ≤ 0.001 in r1, NaN.
        for index in 0 ..< 100 {
            r0[index * 4] = 0.85
            r1[index * 4 + 1] = 0.5
        }
        for index in 100 ..< 200 {
            r1[index * 4 + 2] = 0.0005
        }
        for index in 200 ..< 250 {
            r0[index * 4 + 1] = .nan
        }
        for index in 250 ..< 260 {
            r1[index * 4] = 0.8
        }
        let result = compare(r0, r1)
        XCTAssertEqual(result.pixels, 1240)
        XCTAssertLessThan(try XCTUnwrap(result.residual), 1e-6)

        let none = compare([], [])
        XCTAssertEqual(none.pixels, 0)
        XCTAssertNil(none.residual)
        // Buffers of different sizes: only the common pixels.
        XCTAssertEqual(compare(pixels(10), pixels(20) { Self.transfer.apply($0) }).pixels, 10)
    }

    // MARK: - Working-copy metadata

    /// P1012822 as Core Image reports it (as in WorkingCopyTests).
    private let neutral = NeutralReading(
        temperatureK: 3176.7542,
        tint: -4.5214148,
        x: 0.4221533238887787,
        y: 0.395207017660141,
        decoderVersion: "8"
    )

    private func roundTrip(_ json: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: try JSONOutput.pretty(json)) as? [String: Any])
    }

    func testAsShotWhiteInLightroomsScale() throws {
        // With the map: asShotWhiteAdobe (Python 3384.945072931617 K, tint 4.893304306416134).
        let mapped = try XCTUnwrap(
            WorkingCopy.asShotLightroomWhite(neutral: neutral, calibration: try calibration(table: Self.tableObject()))
        )
        XCTAssertEqual(mapped.temperature, 3384.945072931617, accuracy: 1e-6)
        XCTAssertEqual(mapped.tint, 4.893304306416134, accuracy: 1e-6)
        // Without a map: Core Image's own.
        let own = LightroomWhite(temperature: 3176.7542, tint: -4.5214148)
        let unmapped = try calibration(table: Self.tableObject(), mapModel: nil)
        XCTAssertEqual(WorkingCopy.asShotLightroomWhite(neutral: neutral, calibration: unmapped), own)
        XCTAssertEqual(WorkingCopy.asShotLightroomWhite(neutral: neutral, calibration: nil), own)
        // A map model this version does not understand: the scale is unknown.
        let unknown = try calibration(table: Self.tableObject(), mapModel: "affine-uv")
        XCTAssertNil(WorkingCopy.asShotLightroomWhite(neutral: neutral, calibration: unknown))
    }

    func testWorkingCopyCarriesACheckedTable() throws {
        let calibration = try calibration(table: Self.tableObject())
        let table = try XCTUnwrap(WorkingCopy.usableWhiteBalanceTable(calibration: calibration, gamutMapping: false))
        let asShot = try XCTUnwrap(WorkingCopy.asShotLightroomWhite(neutral: neutral, calibration: calibration))
        let check = WhiteBalanceTableCheck(
            white: WhiteBalanceTableCheck.checkWhite(asShot: asShot),
            asShot: asShot,
            residual: 0.0023,
            pixels: 52_000,
            ms: 81.5
        )
        XCTAssertEqual(check.status, .ok)
        let built = WorkingCopy.metadata(
            neutral: neutral,
            calibration: calibration,
            decoderVersion: "8",
            whiteBalanceTable: CheckedWhiteBalanceTable(table: table, calibrationMatrix: calibration.matrix, check: check),
            source: [:]
        )
        XCTAssertEqual(built.warnings, [])
        let meta = try roundTrip(built.json)
        XCTAssertEqual(meta["kind"] as? String, "raw")
        let json = try XCTUnwrap(meta["whiteBalanceTable"] as? [String: Any])
        // The table as written: every key, measured and unknown ones included.
        XCTAssertEqual(json["schema"] as? String, "niho-develop-wb-table/v1")
        XCTAssertEqual(json["space"] as? String, "apple-linear-prophoto-d50")
        XCTAssertEqual(json["scale"] as? String, "lightroom")
        XCTAssertEqual(json["note"] as? String, "kept as written")
        // Numbers are written exactly. (Read with JSONDecoder, like serde and
        // Python: JSONSerialization hands 17-digit numbers over as
        // NSDecimalNumber, whose doubleValue is not correctly rounded.)
        struct Written: Decodable {
            struct Table: Decodable {
                let mired: [Double]
                let tint: [Double]
                let inverseMatrices: [[Double]]
                let calibrationMatrix: [Double]
            }

            let whiteBalanceTable: Table
        }
        let written = try JSONDecoder().decode(Written.self, from: try JSONOutput.pretty(built.json)).whiteBalanceTable
        XCTAssertEqual(written.mired, Self.mired)
        XCTAssertEqual(written.tint, Self.tint)
        XCTAssertEqual(written.inverseMatrices, Self.pythonNodes())
        XCTAssertEqual(written.calibrationMatrix, calibration.matrix.flat)
        XCTAssertEqual((json["reference"] as? [String: Any])?["temperature"] as? Double, 5000)
        let measured = try XCTUnwrap(json["measured"] as? [String: Any])
        XCTAssertEqual(measured["raws"] as? [String], ["P1012822", "DSC00012"])
        XCTAssertEqual(measured["residualMax"] as? Double, 0.0021)
        XCTAssertNil(json["status"])
        // Plus the matrix baked into the pixels (9 numbers, above) and the check.
        XCTAssertEqual((json["calibrationMatrix"] as? [Any])?.count, 9)
        let checkJSON = try XCTUnwrap(json["check"] as? [String: Any])
        XCTAssertEqual(checkJSON["status"] as? String, "ok")
        XCTAssertEqual(checkJSON["residual"] as? Double, 0.0023)
        XCTAssertEqual(checkJSON["pixels"] as? Int, 52_000)
        XCTAssertEqual(checkJSON["ms"] as? Double, 81.5)
        XCTAssertNil(checkJSON["reason"])
        // w0 is asShotWhiteAdobe's temperature / tint; wc = w0 + (2000 K, 20).
        let adobe = try XCTUnwrap(meta["asShotWhiteAdobe"] as? [String: Any])
        let asShotJSON = try XCTUnwrap(checkJSON["asShot"] as? [String: Any])
        XCTAssertEqual(asShotJSON["temperature"] as? Double, adobe["temperature"] as? Double)
        XCTAssertEqual(asShotJSON["tint"] as? Double, adobe["tint"] as? Double)
        let white = try XCTUnwrap(checkJSON["white"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(white["temperature"] as? Double), 3384.945072931617 + 2000, accuracy: 1e-6)
        XCTAssertEqual(try XCTUnwrap(white["tint"] as? Double), 4.893304306416134 + 20, accuracy: 1e-6)
    }

    func testFailedCheckCarriesNoMatrices() throws {
        let calibration = try calibration(table: Self.tableObject())
        let table = try XCTUnwrap(calibration.whiteBalanceTable)
        let check = WhiteBalanceTableCheck(white: asShot, asShot: asShot, residual: 0.042, pixels: 52_000, ms: 80)
        XCTAssertEqual(check.status, .mismatch)
        let built = WorkingCopy.metadata(
            neutral: neutral,
            calibration: calibration,
            decoderVersion: "8",
            whiteBalanceTable: CheckedWhiteBalanceTable(table: table, calibrationMatrix: calibration.matrix, check: check),
            source: [:]
        )
        let json = try XCTUnwrap(try roundTrip(built.json)["whiteBalanceTable"] as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["schema", "status", "check"])
        XCTAssertEqual(json["schema"] as? String, "niho-develop-wb-table/v1")
        XCTAssertEqual(json["status"] as? String, "mismatch")
        let checkJSON = try XCTUnwrap(json["check"] as? [String: Any])
        XCTAssertEqual(checkJSON["status"] as? String, "mismatch")
        XCTAssertEqual(checkJSON["residual"] as? Double, 0.042)
        XCTAssertEqual(checkJSON["pixels"] as? Int, 52_000)
        XCTAssertNotNil(checkJSON["reason"] as? String)
        XCTAssertNotNil(checkJSON["white"] as? [String: Any])
        XCTAssertNotNil(checkJSON["asShot"] as? [String: Any])
        XCTAssertTrue(check.warning?.hasPrefix("white-balance table check failed: residual 0.042") == true, check.warning ?? "")

        // A check that could not compare at all.
        let unrendered = WhiteBalanceTableCheck(mismatch: "a check render failed: nil output", white: nil, asShot: asShot, ms: 3)
        XCTAssertEqual(unrendered.status, .mismatch)
        let unrenderedJSON = try roundTrip(unrendered.json)
        XCTAssertTrue(unrenderedJSON["residual"] is NSNull)
        XCTAssertTrue(unrenderedJSON["white"] is NSNull)
        XCTAssertEqual(unrenderedJSON["pixels"] as? Int, 0)
        XCTAssertEqual(unrenderedJSON["reason"] as? String, "a check render failed: nil output")
        XCTAssertTrue(unrendered.warning?.contains("residual n/a") == true, unrendered.warning ?? "")
    }

    func testNoTableOrGamutMappingOnMeansNull() throws {
        let withTable = try calibration(table: Self.tableObject())
        XCTAssertNotNil(WorkingCopy.usableWhiteBalanceTable(calibration: withTable, gamutMapping: false))
        // The table holds only without gamut mapping.
        XCTAssertNil(WorkingCopy.usableWhiteBalanceTable(calibration: withTable, gamutMapping: true))
        let withoutTable = try Calibration.load(path: try fixture("calibration-wbmap").path)
        XCTAssertNil(WorkingCopy.usableWhiteBalanceTable(calibration: withoutTable, gamutMapping: false))
        XCTAssertNil(WorkingCopy.usableWhiteBalanceTable(calibration: nil, gamutMapping: false))
        // What render then writes (no check ran): null, the rest unchanged.
        for calibration in [withTable, withoutTable, nil] as [Calibration?] {
            let built = WorkingCopy.metadata(neutral: neutral, calibration: calibration, decoderVersion: "8", source: [:])
            let meta = try roundTrip(built.json)
            XCTAssertTrue(meta["whiteBalanceTable"] is NSNull)
            XCTAssertEqual(
                Set(meta.keys),
                ["kind", "baselineEV", "asShotWhite", "dcpSha256", "lookTableIncluded", "asShotWhiteAdobe", "whiteBalanceTable", "_source"]
            )
        }
    }
}
