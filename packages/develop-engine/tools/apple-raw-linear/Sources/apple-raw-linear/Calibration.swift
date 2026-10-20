import CryptoKit
import Foundation

/// Loosely typed JSON value for calibration fields this version only records
/// or compares (`decoder.settings`, `fit`, `hueSat`).
enum JSONValue: Decodable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "unsupported JSON value"
            )
        }
    }

    /// Foundation value for `JSONSerialization` (metadata output).
    var foundationValue: Any {
        switch self {
        case .null: NSNull()
        case let .bool(value): value
        case let .number(value): JSONOutput.number(value)
        case let .string(value): value
        case let .array(values): values.map(\.foundationValue)
        case let .object(values): values.mapValues(\.foundationValue)
        }
    }
}

/// The on-disk calibration format `niho-develop-calibration/v1`, written by the
/// Python side (`calibrate/fit_base.py`). This tool only reads it.
struct CalibrationDocument: Decodable {
    struct Camera: Decodable {
        let make: String?
        let model: String?
        let id: String?
    }

    struct DecoderInfo: Decodable {
        let kind: String
        /// Accepts `"8"` or `8`.
        let decoderVersion: String
        let settings: [String: JSONValue]?

        private enum CodingKeys: String, CodingKey {
            case kind, decoderVersion, settings
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try container.decode(String.self, forKey: .kind)
            if let text = try? container.decode(String.self, forKey: .decoderVersion) {
                decoderVersion = text
            } else {
                let number = try container.decode(Int.self, forKey: .decoderVersion)
                decoderVersion = String(number)
            }
            settings = try container.decodeIfPresent([String: JSONValue].self, forKey: .settings)
        }
    }

    struct MatrixSpec: Decodable {
        let space: String
        let rowMajor: [[Double]]
        let whitePreserving: Bool?
    }

    struct Illuminant: Decodable {
        let neutralTemperatureK: Double
        let matrix: [[Double]]
    }

    /// `whiteBalanceMap` (optional; `calibrate/fit_wb_map.py`): where Adobe
    /// (Lightroom) puts the as-shot white relative to Apple's. Other keys
    /// (`schema`, `description`, `fit`, ...) are ignored.
    struct WhiteBalanceMapSpec: Decodable {
        let model: String
        let du: Double?
        let dv: Double?
    }

    /// `lens` (optional; S10 #17031): how this camera's working copy corrects
    /// the lens. `mode` = apple | embedded | off; the radius scales are the
    /// measured normalization of the embedded data (tools/lens-check).
    struct LensSpec: Decodable {
        let mode: String
        let distortionRadiusScale: Double?
        let vignettingRadiusScale: Double?
        let vignetting: Bool?
    }

    let schema: String
    /// Optional explicit id; when absent the id is derived (see `Calibration.id`).
    let id: String?
    let track: String
    let camera: Camera
    let decoder: DecoderInfo
    let inputSpace: String
    let workingSpace: String
    let matrix: MatrixSpec
    let baselineEV: Double
    /// `null` / absent → nil.
    let illuminants: [Illuminant]?
    /// `null` / absent → nil. Anything else is rejected by this version.
    let hueSat: JSONValue?
    let version: String
    let createdAt: String?
    let fit: JSONValue?
    let baseVersion: String
    /// `null` / absent → nil (files written before the map existed).
    let whiteBalanceMap: WhiteBalanceMapSpec?
    /// `null` / absent → nil (the renderer's default, Core Image's correction).
    let lens: LensSpec?
    /// `whiteBalanceTable` (optional; `calibrate/fit_wb_table.py`), kept as
    /// written and validated by `WhiteBalanceTable.parse`. `null` / absent → nil.
    let whiteBalanceTable: JSONValue?
    /// Optional provenance carried by versioned product calibration files.
    /// It never changes pixels; signed working-copy metadata records it.
    let matrixProvenance: JSONValue?
    let recipeProvenance: JSONValue?
}

/// A validated `whiteBalanceMap` with `model == "uv-offset"`:
/// `uv_adobe = uv_apple + (du, dv)` in CIE 1960 uv. It predicts the white
/// Adobe treats as as-shot from Apple's as-shot xy; stage 2 starts its
/// chromatic adaptation there to reproduce Lightroom's absolute white balance.
/// It never changes pixels (it goes to the working-copy metadata only).
struct WhiteBalanceUVOffset: Equatable, Sendable {
    static let model = "uv-offset"

    let du: Double
    let dv: Double

    /// Apple's as-shot xy → the white Adobe treats as as-shot (the same
    /// arithmetic as `calibrate/make_working_copies.py`). nil when the result
    /// is not a valid chromaticity.
    func adobeWhite(x: Double, y: Double) -> (x: Double, y: Double)? {
        let apple = ColorMath.uv(x: x, y: y)
        let adobe = ColorMath.xy(u: apple.u + du, v: apple.v + dv)
        guard adobe.x.isFinite, adobe.y.isFinite, adobe.x > 0, adobe.y > 0, adobe.x + adobe.y < 1 else {
            return nil
        }
        return adobe
    }

    /// The inverse, `uv_apple = uv_adobe − (du, dv)` (`wbtable.lightroom_to_apple`):
    /// a white in Lightroom's scale → the white to give Core Image
    /// (`neutralChromaticity`). Extreme whites lie off the diagram (the DNG
    /// model puts 2000 K, tint +150 at x + y = 1.29) and Core Image takes
    /// them as they are, so only a non-finite or non-positive xy is nil.
    func appleWhite(x: Double, y: Double) -> (x: Double, y: Double)? {
        let adobe = ColorMath.uv(x: x, y: y)
        let apple = ColorMath.xy(u: adobe.u - du, v: adobe.v - dv)
        guard apple.x.isFinite, apple.y.isFinite, apple.x > 0, apple.y > 0 else {
            return nil
        }
        return apple
    }
}

/// A validated calibration: a 3x3 matrix in linear ProPhoto (D50) applied to
/// the as-shot white balanced Core Image output, then `× 2^baselineEV` (the
/// measurement encodings; the working copy `png16-g18` leaves `baselineEV`
/// to its metadata, see `OutputEncoding.appliesBaselineEV`).
struct Calibration {
    static let schema = "niho-develop-calibration/v1"
    static let track = "apple"
    static let decoderKind = "apple-cirawfilter"
    static let inputSpace = "extended-linear-srgb-d65-as-shot"
    static let workingSpace = "linear-prophoto-d50"

    struct Illuminant: Equatable {
        let temperatureK: Double
        let mired: Double
        let matrix: Matrix3
    }

    struct Resolution {
        let matrix: Matrix3
        /// Metadata describing how `matrix` was chosen.
        let details: [String: Any]
    }

    let document: CalibrationDocument
    let path: String
    let sha256: String
    /// `document.id`, or `cal-<camera.id>-<track>-<version>` (the last
    /// segment of the sample `baseVersion`).
    let id: String
    let matrix: Matrix3
    /// Sorted by mired ascending (i.e. temperature descending); nil = none.
    let illuminants: [Illuminant]?
    /// `whiteBalanceMap` with the `uv-offset` model; nil = no map, or a model
    /// this version does not understand (see `whiteBalanceMapModel`).
    let whiteBalanceMap: WhiteBalanceUVOffset?
    /// `lens.mode` (nil = no `lens` section) and its settings.
    let lensMode: LensCorrectionMode?
    let lensSettings: LensSettings?
    /// The validated `whiteBalanceTable`; nil = none.
    let whiteBalanceTable: WhiteBalanceTable?

    var baselineEV: Double { document.baselineEV }
    var exposureScale: Double { pow(2, document.baselineEV) }
    /// The `whiteBalanceMap.model` as written (nil = no map).
    var whiteBalanceMapModel: String? { document.whiteBalanceMap?.model }

    /// `decoder.settings.gamutMapping` when it is a bool (what
    /// `--gamut-mapping auto` renders with); nil otherwise.
    var gamutMapping: Bool? {
        guard case let .bool(value)? = document.decoder.settings?["gamutMapping"] else { return nil }
        return value
    }

    static func load(path: String) throws -> Calibration {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ToolError.inputNotFound("calibration file not found: \(url.path)")
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw ToolError.readFailed("cannot read calibration \(url.path): \(error.localizedDescription)")
        }
        return try parse(data: data, path: url.standardizedFileURL.path)
    }

    static func parse(data: Data, path: String) throws -> Calibration {
        let document: CalibrationDocument
        do {
            document = try JSONDecoder().decode(CalibrationDocument.self, from: data)
        } catch {
            throw ToolError.invalidCalibration("\(path): \(describe(decodingError: error))")
        }

        // Valid JSON asking for something this version does not do → exit 3.
        guard document.schema == schema else {
            throw ToolError.unsupportedCalibrationFeature(
                "calibration schema '\(document.schema)' is not supported (expected '\(schema)')"
            )
        }
        if document.hueSat != nil {
            throw ToolError.unsupportedCalibrationFeature(
                "hueSat is not supported by \(Tool.name) \(Tool.version); only matrix, baselineEV and illuminants are applied"
            )
        }
        guard document.track == track else {
            throw ToolError.unsupportedCalibrationFeature(
                "calibration track '\(document.track)' is not '\(track)'; it was not fit against Core Image output"
            )
        }
        guard document.decoder.kind == decoderKind else {
            throw ToolError.unsupportedCalibrationFeature(
                "decoder.kind '\(document.decoder.kind)' is not '\(decoderKind)'"
            )
        }
        guard document.inputSpace == inputSpace else {
            throw ToolError.unsupportedCalibrationFeature(
                "inputSpace '\(document.inputSpace)' is not supported (expected '\(inputSpace)')"
            )
        }
        guard document.workingSpace == workingSpace, document.matrix.space == workingSpace else {
            throw ToolError.unsupportedCalibrationFeature(
                "workingSpace / matrix.space must be '\(workingSpace)' (got '\(document.workingSpace)' / '\(document.matrix.space)')"
            )
        }

        // Malformed numbers → exit 4 (bad input file).
        guard let matrix = Matrix3(rowMajor: document.matrix.rowMajor) else {
            throw ToolError.invalidCalibration("\(path): matrix.rowMajor must be 3x3 finite numbers")
        }
        guard document.baselineEV.isFinite else {
            throw ToolError.invalidCalibration("\(path): baselineEV must be a finite number")
        }
        var illuminants: [Illuminant]?
        if let entries = document.illuminants {
            guard !entries.isEmpty else {
                throw ToolError.invalidCalibration("\(path): illuminants must be null or a non-empty array")
            }
            var parsed: [Illuminant] = []
            for (index, entry) in entries.enumerated() {
                guard entry.neutralTemperatureK.isFinite, entry.neutralTemperatureK > 0 else {
                    throw ToolError.invalidCalibration(
                        "\(path): illuminants[\(index)].neutralTemperatureK must be a positive number"
                    )
                }
                guard let entryMatrix = Matrix3(rowMajor: entry.matrix) else {
                    throw ToolError.invalidCalibration(
                        "\(path): illuminants[\(index)].matrix must be 3x3 finite numbers"
                    )
                }
                parsed.append(Illuminant(
                    temperatureK: entry.neutralTemperatureK,
                    mired: ColorMath.mired(kelvin: entry.neutralTemperatureK),
                    matrix: entryMatrix
                ))
            }
            parsed.sort { $0.mired < $1.mired }
            for (a, b) in zip(parsed, parsed.dropFirst()) where b.mired - a.mired < 1e-9 {
                throw ToolError.invalidCalibration(
                    "\(path): illuminants contain the same temperature twice (\(a.temperatureK) K)"
                )
            }
            illuminants = parsed
        }
        // An unknown model is kept as information only (it never changes
        // pixels); `render` warns when a working-copy meta needs it.
        var whiteBalanceMap: WhiteBalanceUVOffset?
        if let spec = document.whiteBalanceMap, spec.model == WhiteBalanceUVOffset.model {
            guard let du = spec.du, let dv = spec.dv, du.isFinite, dv.isFinite else {
                throw ToolError.invalidCalibration(
                    "\(path): whiteBalanceMap (uv-offset) needs finite numbers du and dv"
                )
            }
            whiteBalanceMap = WhiteBalanceUVOffset(du: du, dv: dv)
        }

        var lensMode: LensCorrectionMode?
        var lensSettings: LensSettings?
        if let spec = document.lens {
            guard let mode = LensCorrectionMode(rawValue: spec.mode), mode != .auto else {
                throw ToolError.invalidCalibration("\(path): lens.mode must be apple, embedded or off (got '\(spec.mode)')")
            }
            let distortion = spec.distortionRadiusScale ?? LensSettings.sonyDefault.distortionRadiusScale
            let vignetting = spec.vignettingRadiusScale ?? LensSettings.sonyDefault.vignettingRadiusScale
            guard distortion.isFinite, distortion > 0, vignetting.isFinite, vignetting > 0 else {
                throw ToolError.invalidCalibration("\(path): lens radius scales must be finite positive numbers")
            }
            lensMode = mode
            lensSettings = LensSettings(
                distortionRadiusScale: distortion,
                vignettingRadiusScale: vignetting,
                vignetting: spec.vignetting ?? true
            )
        }

        var whiteBalanceTable: WhiteBalanceTable?
        if let value = document.whiteBalanceTable, value != .null {
            whiteBalanceTable = try WhiteBalanceTable.parse(value, path: path)
        }
        if whiteBalanceTable != nil, let illuminants, illuminants.count > 1 {
            throw ToolError.unsupportedCalibrationFeature(
                "\(path): whiteBalanceTable needs a single calibration matrix; multiple illuminants need WB-specific matrices"
            )
        }

        let id = document.id
            ?? "cal-\(document.camera.id ?? "unknown")-\(document.track)-\(document.version)"
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return Calibration(
            document: document,
            path: path,
            sha256: digest,
            id: id,
            matrix: matrix,
            illuminants: illuminants,
            whiteBalanceMap: whiteBalanceMap,
            lensMode: lensMode,
            lensSettings: lensSettings,
            whiteBalanceTable: whiteBalanceTable
        )
    }

    /// The matrix for this photo. With `illuminants`, linear interpolation in
    /// mired (1e6 / K) between the two bracketing entries of the as-shot
    /// neutral temperature, clamped to the end entries outside their range
    /// (the DNG dual-illuminant rule). Without, `matrix.rowMajor`.
    func resolve(neutralTemperatureK: Double?) throws -> Resolution {
        guard let illuminants else {
            return Resolution(matrix: matrix, details: ["method": "matrix"])
        }
        guard let temperature = neutralTemperatureK, temperature.isFinite, temperature > 0 else {
            throw ToolError.unsupportedCalibrationFeature(
                "illuminants need the as-shot neutral temperature, which Core Image did not report for this file"
            )
        }
        let mired = ColorMath.mired(kelvin: temperature)
        func weight(_ entry: Illuminant, _ value: Double) -> [String: Any] {
            ["neutralTemperatureK": JSONOutput.number(entry.temperatureK), "weight": JSONOutput.number(value)]
        }
        var details: [String: Any] = [
            "method": "illuminants-mired-linear",
            "neutralTemperatureK": JSONOutput.number(temperature),
            "mired": JSONOutput.number(mired),
        ]
        guard let first = illuminants.first, let last = illuminants.last else {
            return Resolution(matrix: matrix, details: ["method": "matrix"])
        }
        if illuminants.count == 1 {
            details["clamped"] = false
            details["weights"] = [weight(first, 1)]
            return Resolution(matrix: first.matrix, details: details)
        }
        if mired <= first.mired {
            details["clamped"] = mired != first.mired
            details["weights"] = [weight(first, 1)]
            return Resolution(matrix: first.matrix, details: details)
        }
        if mired >= last.mired {
            details["clamped"] = mired != last.mired
            details["weights"] = [weight(last, 1)]
            return Resolution(matrix: last.matrix, details: details)
        }
        guard let upperIndex = illuminants.firstIndex(where: { $0.mired >= mired }), upperIndex > 0 else {
            details["clamped"] = true
            details["weights"] = [weight(first, 1)]
            return Resolution(matrix: first.matrix, details: details)
        }
        let lower = illuminants[upperIndex - 1]
        let upper = illuminants[upperIndex]
        let t = (mired - lower.mired) / (upper.mired - lower.mired)
        details["clamped"] = false
        details["weights"] = [weight(lower, 1 - t), weight(upper, t)]
        return Resolution(matrix: .interpolate(lower.matrix, upper.matrix, t: t), details: details)
    }

    /// Non-fatal mismatches recorded in the render metadata `warnings`.
    ///
    /// - `decoder.decoderVersion` ≠ applied version for explicit `--calibration` (warn, never reject; registry selections reject first)
    /// - camera make/model ≠ the RAW's (warn; the owner decides per experiment)
    /// - `decoder.settings` ≠ the settings this render assigned
    /// - `matrix.whitePreserving == true` but a matrix does not keep (1,1,1)
    func warnings(
        cameraMake: String?,
        cameraModel: String?,
        decoderVersion: String,
        comparableSettings: [String: JSONValue]
    ) -> [String] {
        var warnings: [String] = []
        if document.decoder.decoderVersion != decoderVersion {
            warnings.append(
                "calibration decoder.decoderVersion \(document.decoder.decoderVersion) differs from the applied decoderVersion \(decoderVersion)"
            )
        }
        if !Self.sameCamera(
            calibrationMake: document.camera.make,
            calibrationModel: document.camera.model,
            rawMake: cameraMake,
            rawModel: cameraModel
        ) {
            warnings.append(
                "calibration camera \(document.camera.make ?? "?") \(document.camera.model ?? "?") differs from the RAW's \(cameraMake ?? "?") \(cameraModel ?? "?")"
            )
        }
        for (key, expected) in (document.decoder.settings ?? [:]).sorted(by: { $0.key < $1.key }) {
            guard let actual = comparableSettings[key] else {
                warnings.append("calibration decoder.settings.\(key) is not recognized and was not compared")
                continue
            }
            if !Self.settingMatches(expected, actual) {
                warnings.append(
                    "calibration decoder.settings.\(key) = \(Self.render(expected)) but this render used \(Self.render(actual))"
                )
            }
        }
        if document.matrix.whitePreserving == true {
            var matrices: [(String, Matrix3)] = [("matrix.rowMajor", matrix)]
            for entry in illuminants ?? [] {
                matrices.append(("illuminants[\(entry.temperatureK) K]", entry.matrix))
            }
            for (label, candidate) in matrices {
                let sums = candidate.rowSums
                let error = Swift.max(Swift.abs(sums.x - 1), Swift.max(Swift.abs(sums.y - 1), Swift.abs(sums.z - 1)))
                if error > 1e-3 {
                    warnings.append(
                        "matrix.whitePreserving is true but \(label) maps white to (\(sums.x), \(sums.y), \(sums.z))"
                    )
                }
            }
        }
        return warnings
    }

    var metadataSource: [String: Any] {
        [
            "id": id,
            "baseVersion": document.baseVersion,
            "version": document.version,
            "path": path,
            "sha256": sha256,
            "camera": [
                "make": JSONOutput.optional(document.camera.make),
                "model": JSONOutput.optional(document.camera.model),
                "id": JSONOutput.optional(document.camera.id),
            ],
            "decoderVersion": document.decoder.decoderVersion,
            "createdAt": JSONOutput.optional(document.createdAt),
            "baselineEV": JSONOutput.number(document.baselineEV),
            "exposureScale": JSONOutput.number(exposureScale),
            "whitePreserving": JSONOutput.optional(document.matrix.whitePreserving),
            "illuminantCount": illuminants?.count ?? 0,
            "whiteBalanceMap": whiteBalanceMapJSON,
            "lens": lensMode.map { mode -> Any in
                [
                    "mode": mode.rawValue,
                    "distortionRadiusScale": JSONOutput.number(lensSettings?.distortionRadiusScale ?? 0),
                    "vignettingRadiusScale": JSONOutput.number(lensSettings?.vignettingRadiusScale ?? 0),
                    "vignetting": lensSettings?.vignetting ?? false,
                ] as [String: Any]
            } ?? NSNull(),
            "whiteBalanceTable": whiteBalanceTable?.summaryJSON ?? NSNull(),
        ]
    }

    /// `{"model","du","dv"}` of the map, `{"model","supported":false}` for an
    /// unknown model, or `null`.
    var whiteBalanceMapJSON: Any {
        if let whiteBalanceMap {
            return [
                "model": WhiteBalanceUVOffset.model,
                "du": JSONOutput.number(whiteBalanceMap.du),
                "dv": JSONOutput.number(whiteBalanceMap.dv),
            ] as [String: Any]
        }
        if let model = whiteBalanceMapModel {
            return ["model": model, "supported": false] as [String: Any]
        }
        return NSNull()
    }

    // MARK: - Helpers

    static func normalizedMake(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Lowercased, trimmed, without a leading make ("Panasonic DC-S5" → "dc-s5").
    static func normalizedModel(_ value: String?, make: String?) -> String {
        var model = normalizedMake(value)
        let makeText = normalizedMake(make)
        if !makeText.isEmpty, model.hasPrefix(makeText + " ") {
            model = String(model.dropFirst(makeText.count + 1))
        }
        return model
    }

    static func sameCamera(
        calibrationMake: String?,
        calibrationModel: String?,
        rawMake: String?,
        rawModel: String?
    ) -> Bool {
        let calMake = normalizedMake(calibrationMake)
        let rawMakeText = normalizedMake(rawMake)
        let makeMatches = calMake.isEmpty || rawMakeText.isEmpty
            || calMake.contains(rawMakeText) || rawMakeText.contains(calMake)
        let calModel = normalizedModel(calibrationModel, make: calibrationMake)
        let rawModelText = normalizedModel(rawModel, make: rawMake)
        let modelMatches = calModel.isEmpty || calModel == rawModelText
        return makeMatches && modelMatches
    }

    static func settingMatches(_ expected: JSONValue, _ actual: JSONValue) -> Bool {
        switch (expected, actual) {
        case let (.number(a), .number(b)): Swift.abs(a - b) <= 1e-6
        case let (.bool(a), .bool(b)): a == b
        case let (.string(a), .string(b)): a == b
        default: expected == actual
        }
    }

    static func render(_ value: JSONValue) -> String {
        switch value {
        case .null: "null"
        case let .bool(v): v ? "true" : "false"
        case let .number(v): String(v)
        case let .string(v): "\"\(v)\""
        case .array, .object: "<structured>"
        }
    }

    static func describe(decodingError error: Error) -> String {
        guard let decoding = error as? DecodingError else { return error.localizedDescription }
        func path(_ context: DecodingError.Context) -> String {
            let keys = context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }
            return keys.isEmpty ? "(root)" : keys.joined(separator: ".")
        }
        switch decoding {
        case let .keyNotFound(key, context):
            return "missing key '\(key.stringValue)' at \(path(context))"
        case let .typeMismatch(_, context), let .valueNotFound(_, context):
            return "wrong type at \(path(context)): \(context.debugDescription)"
        case let .dataCorrupted(context):
            return "malformed JSON at \(path(context)): \(context.debugDescription)"
        @unknown default:
            return error.localizedDescription
        }
    }
}
