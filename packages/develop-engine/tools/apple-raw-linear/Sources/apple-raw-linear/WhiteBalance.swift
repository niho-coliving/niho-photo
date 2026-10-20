import CoreGraphics
import Foundation

/// A white in Lightroom's scale: (temperature K, tint) of the DNG model, as
/// developSettings / XMP carry it. With a calibration `whiteBalanceMap` it is
/// not Core Image's own scale (see `WhiteBalanceUVOffset`).
struct LightroomWhite: Equatable, Sendable {
    let temperature: Double
    let tint: Double

    var json: [String: Any] {
        ["temperature": JSONOutput.number(temperature), "tint": JSONOutput.number(tint)]
    }
}

/// `render --white` (and the table check's second render): a Lightroom-scale
/// white made into the xy Core Image is given (`neutralChromaticity`). The
/// DNG model's xy is evaluated unclamped, so the Apple-scale whites
/// `calibrate/fit_wb_table.py` asks for below 2000 K stay exact; then the
/// inverse `whiteBalanceMap` when the calibration has one, else the xy as is.
/// Strong tints land off the diagram (x + y > 1); Core Image takes them and
/// reports the same temperature / tint back.
struct RenderWhite {
    let requested: LightroomWhite
    /// The DNG model's xy of `requested`.
    let lightroom: (x: Double, y: Double)
    /// The xy Core Image is given.
    let apple: (x: Double, y: Double)
    let mapApplied: Bool

    /// nil when an xy (before or after the map) is not finite and positive
    /// (never within `--white`'s range).
    static func resolve(_ white: LightroomWhite, map: WhiteBalanceUVOffset?) -> RenderWhite? {
        let lightroom = DNGTemperature.xy(temperature: white.temperature, tint: white.tint, minimumTemperature: nil)
        guard lightroom.x.isFinite, lightroom.y.isFinite, lightroom.x > 0, lightroom.y > 0 else { return nil }
        guard let map else {
            return RenderWhite(requested: white, lightroom: lightroom, apple: lightroom, mapApplied: false)
        }
        guard let apple = map.appleWhite(x: lightroom.x, y: lightroom.y) else { return nil }
        return RenderWhite(requested: white, lightroom: lightroom, apple: apple, mapApplied: true)
    }

    var neutralChromaticity: CGPoint {
        CGPoint(x: apple.x, y: apple.y)
    }

    /// `renderedWhite` in the tool metadata.
    var json: [String: Any] {
        [
            "temperature": JSONOutput.number(requested.temperature),
            "tint": JSONOutput.number(requested.tint),
            "lightroom": ["x": JSONOutput.number(lightroom.x), "y": JSONOutput.number(lightroom.y)],
            "apple": ["x": JSONOutput.number(apple.x), "y": JSONOutput.number(apple.y)],
            "mapApplied": mapApplied,
        ]
    }
}

/// Optional camera-specific mapping from a requested Lightroom target white
/// to the white-balance table coordinate that best reproduces it. Stage 1
/// validates and preserves it for the working-copy metadata; its render-time
/// table self-check deliberately continues to use the unmapped table.
struct WhiteBalanceTargetMap: Sendable {
    static let schema = "niho-develop-wb-target-map/v1"
    static let minimumKelvin = 2000.0
    static let maximumKelvin = 50000.0

    let kelvin: [Double]
    let temperatureOffsets: [Double]
    let tintOffsets: [Double]
    let fullDeltaMired: Double
    let fullDeltaTint: Double

    static func parse(
        _ value: JSONValue,
        invalid: (String) -> ToolError
    ) throws -> WhiteBalanceTargetMap {
        guard case let .object(object) = value else {
            throw invalid(".targetMap must be an object")
        }
        guard object["schema"] == .string(schema) else {
            throw invalid(
                ".targetMap.schema must be '\(schema)' (got \(Calibration.render(object["schema"] ?? .null)))"
            )
        }
        let kelvin = try array("kelvin", in: object, invalid: invalid)
        guard kelvin.count >= 2,
              zip(kelvin, kelvin.dropFirst()).allSatisfy({ $0 < $1 })
        else {
            throw invalid(".targetMap.kelvin must be a strictly ascending list of at least 2 finite numbers")
        }
        guard kelvin.allSatisfy({ minimumKelvin ... maximumKelvin ~= $0 }) else {
            throw invalid(".targetMap.kelvin must be within 2000..50000")
        }
        let temperatureOffsets = try offsets("temperatureOffsets", count: kelvin.count, in: object, invalid: invalid)
        let tintOffsets = try offsets("tintOffsets", count: kelvin.count, in: object, invalid: invalid)
        for (key, values) in [("temperatureOffsets", temperatureOffsets), ("tintOffsets", tintOffsets)]
            where values.first != 0 || values.last != 0 {
            throw invalid(".targetMap.\(key) must be 0 at both endpoints")
        }
        let mappedKelvin = zip(kelvin, temperatureOffsets).map { $0.0 + $0.1 }
        guard mappedKelvin.allSatisfy({ minimumKelvin ... maximumKelvin ~= $0 }) else {
            throw invalid(".targetMap mapped kelvin must be within 2000..50000")
        }
        guard zip(mappedKelvin, mappedKelvin.dropFirst()).allSatisfy({ $0 < $1 }) else {
            throw invalid(".targetMap mapped kelvin must be strictly ascending")
        }
        func positive(_ key: String) throws -> Double {
            guard case let .number(value)? = object[key], value.isFinite, value > 0 else {
                throw invalid(".targetMap.\(key) must be a positive finite number")
            }
            return value
        }
        return try WhiteBalanceTargetMap(
            kelvin: kelvin,
            temperatureOffsets: temperatureOffsets,
            tintOffsets: tintOffsets,
            fullDeltaMired: positive("fullDeltaMired"),
            fullDeltaTint: positive("fullDeltaTint")
        )
    }

    private static func offsets(
        _ key: String,
        count: Int,
        in object: [String: JSONValue],
        invalid: (String) -> ToolError
    ) throws -> [Double] {
        let values = try array(key, in: object, invalid: invalid)
        guard values.count == count else {
            throw invalid(".targetMap.\(key) must be \(count) finite numbers")
        }
        return values
    }

    private static func array(
        _ key: String,
        in object: [String: JSONValue],
        invalid: (String) -> ToolError
    ) throws -> [Double] {
        guard case let .array(items)? = object[key] else {
            throw invalid(".targetMap.\(key) must be an array of finite numbers")
        }
        return try items.map { item in
            guard case let .number(value) = item, value.isFinite else {
                throw invalid(".targetMap.\(key) must be an array of finite numbers")
            }
            return value
        }
    }
}

/// A calibration's `whiteBalanceTable` (`niho-develop-wb-table/v1`, S11
/// #17108; measured by `calibrate/fit_wb_table.py`, reference
/// `calibrate/wbtable.py`).
///
/// With gamut mapping off, Core Image's linear ProPhoto output of one RAW
/// rendered at white w (before the calibration matrix) is exactly
/// `out(w) = M(w) · out(reference)`, and the 3x3 `M(w)` depends only on the
/// camera model and w. The table holds `I(w) = M(w)^-1` at Lightroom-scale
/// whites on a (mired, tint) grid, interpolated bilinearly in between.
/// `M(b) · I(a)` moves an output rendered at white a to white b.
struct WhiteBalanceTable: Sendable {
    static let schema = "niho-develop-wb-table/v1"
    static let space = "apple-linear-prophoto-d50"
    static let scale = "lightroom"
    /// An inverse matrix with |det| at or below this is singular.
    static let minimumDeterminant = 1e-9

    /// 1e6 / K: strictly ascending, positive.
    let mired: [Double]
    /// Strictly ascending.
    let tint: [Double]
    /// `I` at node (iMired, iTint) = `inverseMatrices[iMired * tint.count + iTint]`.
    let inverseMatrices: [Matrix3]
    /// Optional target correction, validated here but evaluated only by
    /// stage 2. The stage-1 self-check stays on the original table.
    let targetMap: WhiteBalanceTargetMap?
    /// The object as written (every key, `measured` included): what a
    /// working copy carries when its self-check passes.
    let object: [String: JSONValue]

    /// Validates the calibration's `whiteBalanceTable`; every problem is
    /// `invalid_calibration`. Keys this version does not read are kept.
    static func parse(_ value: JSONValue, path: String) throws -> WhiteBalanceTable {
        func invalid(_ message: String) -> ToolError {
            .invalidCalibration("\(path): whiteBalanceTable\(message)")
        }
        guard case let .object(object) = value else {
            throw invalid(" must be an object or null")
        }
        for (key, expected) in [("schema", schema), ("space", space), ("scale", scale)]
            where object[key] != .string(expected) {
            throw invalid(".\(key) must be '\(expected)' (got \(Calibration.render(object[key] ?? .null)))")
        }
        let mired = try grid("mired", in: object, invalid: invalid)
        guard mired.allSatisfy({ $0 > 0 }) else {
            throw invalid(".mired must be positive (1e6 / K)")
        }
        let tint = try grid("tint", in: object, invalid: invalid)
        guard case let .array(entries)? = object["inverseMatrices"] else {
            throw invalid(".inverseMatrices must be an array")
        }
        let nodes = mired.count * tint.count
        guard entries.count == nodes else {
            throw invalid(
                ".inverseMatrices has \(entries.count) entries; \(mired.count) mired x \(tint.count) tint nodes need \(nodes)"
            )
        }
        var matrices: [Matrix3] = []
        matrices.reserveCapacity(nodes)
        for (index, entry) in entries.enumerated() {
            let node = ".inverseMatrices[\(index)] (mired \(mired[index / tint.count]), tint \(tint[index % tint.count]))"
            guard let values = numbers(entry), let matrix = Matrix3(flat: values) else {
                throw invalid("\(node) must be 9 finite numbers (a row-major 3x3)")
            }
            let determinant = matrix.determinant
            guard determinant.isFinite, Swift.abs(determinant) > minimumDeterminant else {
                throw invalid("\(node) is singular (det \(determinant))")
            }
            matrices.append(matrix)
        }
        let targetMap = try object["targetMap"].map { try WhiteBalanceTargetMap.parse($0, invalid: invalid) }
        return WhiteBalanceTable(
            mired: mired,
            tint: tint,
            inverseMatrices: matrices,
            targetMap: targetMap,
            object: object
        )
    }

    /// A strictly ascending list of at least 2 finite numbers.
    private static func grid(
        _ key: String,
        in object: [String: JSONValue],
        invalid: (String) -> ToolError
    ) throws -> [Double] {
        guard let value = object[key], let values = numbers(value), values.count >= 2,
              values.allSatisfy(\.isFinite),
              zip(values, values.dropFirst()).allSatisfy({ $0 < $1 })
        else {
            throw invalid(".\(key) must be a strictly ascending list of at least 2 finite numbers")
        }
        return values
    }

    /// The numbers of a JSON array of numbers; nil for anything else.
    private static func numbers(_ value: JSONValue) -> [Double]? {
        guard case let .array(items) = value else { return nil }
        var values: [Double] = []
        values.reserveCapacity(items.count)
        for item in items {
            guard case let .number(number) = item else { return nil }
            values.append(number)
        }
        return values
    }

    /// The cell of `value` on `grid` (clamped to the grid) and the weight of
    /// its upper node (`wbtable.WhiteBalanceTable._cell`).
    static func cell(_ grid: [Double], _ value: Double) -> (index: Int, weight: Double) {
        let clamped = Swift.min(Swift.max(value, grid[0]), grid[grid.count - 1])
        // numpy searchsorted(side="right") - 1: the last node at or below the value.
        let above = grid.firstIndex { $0 > clamped } ?? grid.count
        let index = Swift.min(Swift.max(above - 1, 0), grid.count - 2)
        return (index, (clamped - grid[index]) / (grid[index + 1] - grid[index]))
    }

    /// `I(w)`: the inverse matrices interpolated bilinearly (entry-wise) in
    /// (1e6 / K, tint), clamped to the grid; the arithmetic of `wbtable.py`.
    func inverse(_ white: LightroomWhite) -> Matrix3 {
        let (i, a) = Self.cell(mired, 1e6 / white.temperature)
        let (j, b) = Self.cell(tint, white.tint)
        func node(_ m: Int, _ t: Int) -> Matrix3 {
            inverseMatrices[m * tint.count + t]
        }
        return node(i, j).scaled(by: (1 - a) * (1 - b))
            + node(i + 1, j).scaled(by: a * (1 - b))
            + node(i, j + 1).scaled(by: (1 - a) * b)
            + node(i + 1, j + 1).scaled(by: a * b)
    }

    /// `M(w) = I(w)^-1`: the output rendered at the reference white → at w.
    func matrix(_ white: LightroomWhite) -> Matrix3? {
        inverse(white).inverse()
    }

    /// `M(b) · I(a)`: Core Image output rendered at white a → at white b.
    func transfer(from a: LightroomWhite, to b: LightroomWhite) -> Matrix3? {
        matrix(b).map { $0 * inverse(a) }
    }

    /// The grid, for the tool metadata's calibration section.
    var summaryJSON: [String: Any] {
        [
            "schema": Self.schema,
            "nodes": inverseMatrices.count,
            "miredRange": [JSONOutput.number(mired[0]), JSONOutput.number(mired[mired.count - 1])],
            "tintRange": [JSONOutput.number(tint[0]), JSONOutput.number(tint[tint.count - 1])],
        ]
    }
}

/// The render-time self-check before a working copy carries a table: the
/// table was measured on other RAWs, and a macOS update can change Core
/// Image. The same RAW is rendered twice more, small and without lens
/// correction: `r0` at the as-shot white `w0` (neutral untouched) and `r1` at
/// a check white `wc`; the table must predict `r1` as `M(wc) · I(w0) · r0`
/// in its space (linear ProPhoto, no calibration matrix).
struct WhiteBalanceTableCheck {
    enum Status: String, Sendable {
        case ok
        case mismatch
    }

    /// Long edge of the two check renders.
    static let longEdge = 384
    /// Compared pixels: every channel of both renders in this open interval.
    static let lowerValue = 0.001
    static let upperValue = 0.8
    static let minimumPixels = 1000
    static let maximumResidual = 0.01

    let status: Status
    /// The check white `wc` (Lightroom's scale); nil when it was not reached.
    let white: LightroomWhite?
    /// The as-shot white `w0` (Lightroom's scale); nil when unknown.
    let asShot: LightroomWhite?
    let residual: Double?
    let pixels: Int
    let ms: Double
    /// Why the check failed; nil when ok.
    let reason: String?

    /// ok when at least `minimumPixels` were compared and the residual is at
    /// most `maximumResidual`.
    init(white: LightroomWhite, asShot: LightroomWhite, residual: Double?, pixels: Int, ms: Double) {
        self.white = white
        self.asShot = asShot
        self.residual = residual
        self.pixels = pixels
        self.ms = ms
        if pixels < Self.minimumPixels {
            status = .mismatch
            reason = "only \(pixels) pixels have every channel in (\(Self.lowerValue), \(Self.upperValue)) in both renders (needs \(Self.minimumPixels))"
        } else if let residual, residual <= Self.maximumResidual {
            status = .ok
            reason = nil
        } else {
            status = .mismatch
            reason = "the residual is above \(Self.maximumResidual)"
        }
    }

    /// A check that could not compare (no residual).
    init(mismatch reason: String, white: LightroomWhite?, asShot: LightroomWhite?, ms: Double) {
        status = .mismatch
        self.white = white
        self.asShot = asShot
        residual = nil
        pixels = 0
        self.ms = ms
        self.reason = reason
    }

    /// `wc`: 2000 K towards the middle (K0 + 2000 below 5000 K, else
    /// K0 − 2000; clamped to [2000, 50000]) and tint0 + 20 (clamped to ±150).
    static func checkWhite(asShot: LightroomWhite) -> LightroomWhite {
        let temperature = asShot.temperature < 5000 ? asShot.temperature + 2000 : asShot.temperature - 2000
        return LightroomWhite(
            temperature: Swift.min(Swift.max(temperature, 2000), 50000),
            tint: Swift.min(Swift.max(asShot.tint + 20, -150), 150)
        )
    }

    /// `sqrt(mean((p − r1)²)) / sqrt(mean(r1²))` over every channel of the
    /// pixels whose channels are all in (`lowerValue`, `upperValue`) in both
    /// renders, `p = transfer · r0`. `r0` and `r1` are Core Image RGBA float
    /// buffers of one size, converted by `toTableSpace` first. The residual
    /// is nil when no pixel qualifies.
    static func compare(
        asShot r0: UnsafeBufferPointer<Float>,
        check r1: UnsafeBufferPointer<Float>,
        toTableSpace: Matrix3,
        transfer: Matrix3
    ) -> (residual: Double?, pixels: Int) {
        @inline(__always)
        func inRange(_ v: SIMD3<Double>) -> Bool {
            v.x > lowerValue && v.x < upperValue
                && v.y > lowerValue && v.y < upperValue
                && v.z > lowerValue && v.z < upperValue
        }
        var squaredError = 0.0
        var squaredTarget = 0.0
        var pixels = 0
        let count = Swift.min(r0.count, r1.count) / 4
        for index in 0 ..< count {
            let base = index * 4
            let reference = toTableSpace.apply(SIMD3(Double(r0[base]), Double(r0[base + 1]), Double(r0[base + 2])))
            let target = toTableSpace.apply(SIMD3(Double(r1[base]), Double(r1[base + 1]), Double(r1[base + 2])))
            guard inRange(reference), inRange(target) else { continue }
            let difference = transfer.apply(reference) - target
            squaredError += (difference * difference).sum()
            squaredTarget += (target * target).sum()
            pixels += 1
        }
        guard pixels > 0, squaredTarget > 0 else { return (nil, pixels) }
        return ((squaredError / squaredTarget).squareRoot(), pixels)
    }

    /// `check` in the working-copy metadata.
    var json: [String: Any] {
        var json: [String: Any] = [
            "status": status.rawValue,
            "white": white?.json ?? NSNull(),
            "asShot": asShot?.json ?? NSNull(),
            "residual": residual.map { JSONOutput.number($0) } ?? NSNull(),
            "pixels": pixels,
            "ms": JSONOutput.number(ms),
        ]
        if let reason {
            json["reason"] = reason
        }
        return json
    }

    /// The render warning for a failed check; nil when ok.
    var warning: String? {
        guard status == .mismatch else { return nil }
        let value = residual.map { String($0) } ?? "n/a"
        return "white-balance table check failed: residual \(value) over \(pixels) pixels (\(reason ?? "mismatch")); the working copy's whiteBalanceTable carries no matrices"
    }
}

/// A table with this render's check: the working-copy metadata's
/// `whiteBalanceTable` (only for renders with gamut mapping off; see
/// `WorkingCopy.usableWhiteBalanceTable`).
struct CheckedWhiteBalanceTable {
    let table: WhiteBalanceTable
    /// The calibration matrix applied to the working copy's pixels
    /// (the resolved one; identity without a calibration).
    let calibrationMatrix: Matrix3
    let check: WhiteBalanceTableCheck

    /// ok: the table as written plus `calibrationMatrix` (9 numbers,
    /// row-major) and `check`. mismatch: `{schema, status, check}` without
    /// `inverseMatrices`, so stage 2 falls back to its approximation.
    var json: [String: Any] {
        switch check.status {
        case .ok:
            var json = table.object.mapValues(\.foundationValue)
            json["calibrationMatrix"] = calibrationMatrix.flat.map { JSONOutput.number($0) }
            json["check"] = check.json
            return json
        case .mismatch:
            return [
                "schema": WhiteBalanceTable.schema,
                "status": WhiteBalanceTableCheck.Status.mismatch.rawValue,
                "check": check.json,
            ]
        }
    }
}
