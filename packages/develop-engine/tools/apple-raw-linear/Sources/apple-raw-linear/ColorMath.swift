import Foundation

/// Row-major 3x3 matrix in Double precision. `apply(_:)` computes `M · v` for
/// a column vector `v` (`out[i] = Σ_j m[i][j] · v[j]`), the convention of the
/// calibration JSON's `rowMajor` and of the Python measurement tools.
struct Matrix3: Equatable, Sendable, CustomStringConvertible {
    var r0: SIMD3<Double>
    var r1: SIMD3<Double>
    var r2: SIMD3<Double>

    init(_ r0: SIMD3<Double>, _ r1: SIMD3<Double>, _ r2: SIMD3<Double>) {
        self.r0 = r0
        self.r1 = r1
        self.r2 = r2
    }

    /// `nil` unless `rowMajor` is exactly 3x3 and every entry is finite.
    init?(rowMajor: [[Double]]) {
        guard rowMajor.count == 3,
              rowMajor.allSatisfy({ $0.count == 3 && $0.allSatisfy(\.isFinite) })
        else { return nil }
        self.init(
            SIMD3(rowMajor[0][0], rowMajor[0][1], rowMajor[0][2]),
            SIMD3(rowMajor[1][0], rowMajor[1][1], rowMajor[1][2]),
            SIMD3(rowMajor[2][0], rowMajor[2][1], rowMajor[2][2])
        )
    }

    /// `nil` unless `flat` is exactly 9 finite numbers (row-major, the
    /// white-balance table's `inverseMatrices` entries).
    init?(flat: [Double]) {
        guard flat.count == 9, flat.allSatisfy(\.isFinite) else { return nil }
        self.init(
            SIMD3(flat[0], flat[1], flat[2]),
            SIMD3(flat[3], flat[4], flat[5]),
            SIMD3(flat[6], flat[7], flat[8])
        )
    }

    static let identity = Matrix3(SIMD3(1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, 0, 1))

    var rowMajor: [[Double]] {
        [[r0.x, r0.y, r0.z], [r1.x, r1.y, r1.z], [r2.x, r2.y, r2.z]]
    }

    /// The 9 entries, row-major.
    var flat: [Double] {
        [r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, r2.x, r2.y, r2.z]
    }

    var description: String {
        rowMajor.map { row in
            "[" + row.map { String(format: "%.7f", $0) }.joined(separator: ", ") + "]"
        }.joined(separator: "\n")
    }

    var transposed: Matrix3 {
        Matrix3(SIMD3(r0.x, r1.x, r2.x), SIMD3(r0.y, r1.y, r2.y), SIMD3(r0.z, r1.z, r2.z))
    }

    var determinant: Double {
        r0.x * (r1.y * r2.z - r1.z * r2.y)
            - r0.y * (r1.x * r2.z - r1.z * r2.x)
            + r0.z * (r1.x * r2.y - r1.y * r2.x)
    }

    /// Row sums, i.e. `M · (1, 1, 1)`: where the white `(1,1,1)` goes.
    var rowSums: SIMD3<Double> {
        SIMD3(r0.sum(), r1.sum(), r2.sum())
    }

    var isFinite: Bool {
        [r0, r1, r2].allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }
    }

    func apply(_ v: SIMD3<Double>) -> SIMD3<Double> {
        SIMD3((r0 * v).sum(), (r1 * v).sum(), (r2 * v).sum())
    }

    static func * (a: Matrix3, b: Matrix3) -> Matrix3 {
        let bt = b.transposed
        func row(_ r: SIMD3<Double>) -> SIMD3<Double> {
            SIMD3((r * bt.r0).sum(), (r * bt.r1).sum(), (r * bt.r2).sum())
        }
        return Matrix3(row(a.r0), row(a.r1), row(a.r2))
    }

    func scaled(by factor: Double) -> Matrix3 {
        Matrix3(r0 * factor, r1 * factor, r2 * factor)
    }

    /// Element-wise sum.
    static func + (a: Matrix3, b: Matrix3) -> Matrix3 {
        Matrix3(a.r0 + b.r0, a.r1 + b.r1, a.r2 + b.r2)
    }

    /// Adjugate / determinant. `nil` for a (numerically) singular matrix.
    func inverse() -> Matrix3? {
        let det = determinant
        guard det.isFinite, abs(det) > 1e-12 else { return nil }
        let c00 = r1.y * r2.z - r1.z * r2.y
        let c01 = -(r1.x * r2.z - r1.z * r2.x)
        let c02 = r1.x * r2.y - r1.y * r2.x
        let c10 = -(r0.y * r2.z - r0.z * r2.y)
        let c11 = r0.x * r2.z - r0.z * r2.x
        let c12 = -(r0.x * r2.y - r0.y * r2.x)
        let c20 = r0.y * r1.z - r0.z * r1.y
        let c21 = -(r0.x * r1.z - r0.z * r1.x)
        let c22 = r0.x * r1.y - r0.y * r1.x
        return Matrix3(
            SIMD3(c00, c10, c20) / det,
            SIMD3(c01, c11, c21) / det,
            SIMD3(c02, c12, c22) / det
        )
    }

    /// `(1 - t) · a + t · b`, element-wise.
    static func interpolate(_ a: Matrix3, _ b: Matrix3, t: Double) -> Matrix3 {
        Matrix3(
            a.r0 + (b.r0 - a.r0) * t,
            a.r1 + (b.r1 - a.r1) * t,
            a.r2 + (b.r2 - a.r2) * t
        )
    }

    func maxAbsDifference(to other: Matrix3) -> Double {
        func largest(_ v: SIMD3<Double>) -> Double {
            Swift.max(Swift.abs(v.x), Swift.max(Swift.abs(v.y), Swift.abs(v.z)))
        }
        return Swift.max(
            largest(r0 - other.r0),
            Swift.max(largest(r1 - other.r1), largest(r2 - other.r2))
        )
    }
}

/// Color-space constants shared with the Python measurement tools. The
/// numbers are used exactly as given (Lindbloom, Bradford-adapted to D50);
/// nothing is renormalized.
enum ColorMath {
    /// Linear sRGB (D65) → XYZ (D50), Bradford-adapted (Lindbloom).
    static let linearSRGBToXYZD50 = Matrix3(
        SIMD3(0.4360747, 0.3850649, 0.1430804),
        SIMD3(0.2225045, 0.7168786, 0.0606169),
        SIMD3(0.0139322, 0.0971045, 0.7141733)
    )

    /// Linear ProPhoto / ROMM RGB (D50) → XYZ (D50) (Lindbloom).
    static let linearProPhotoToXYZD50 = Matrix3(
        SIMD3(0.7976749, 0.1351917, 0.0313534),
        SIMD3(0.2880402, 0.7118741, 0.0000857),
        SIMD3(0.0, 0.0, 0.8252100)
    )

    /// `inv(M_pp_to_xyz_d50) · M_srgb_to_xyz_d50`.
    static let linearSRGBToLinearProPhoto: Matrix3 = {
        guard let inverse = linearProPhotoToXYZD50.inverse() else {
            preconditionFailure("ProPhoto matrix is singular")
        }
        return inverse * linearSRGBToXYZD50
    }()

    static let linearProPhotoToLinearSRGB: Matrix3 = {
        guard let inverse = linearSRGBToLinearProPhoto.inverse() else {
            preconditionFailure("sRGB→ProPhoto matrix is singular")
        }
        return inverse
    }()

    /// D50 white of the ProPhoto matrix (its row sums), used for the
    /// calibrated linear ProPhoto `CGColorSpace` attached to TIFF output.
    static var proPhotoWhiteXYZ: SIMD3<Double> { linearProPhotoToXYZD50.rowSums }

    /// Mired (micro reciprocal degrees) of a correlated color temperature.
    static func mired(kelvin: Double) -> Double {
        1_000_000 / kelvin
    }

    /// CIE 1931 xy → CIE 1960 uv: `u = 2x / (1.5 − x + 6y)`,
    /// `v = 3y / (1.5 − x + 6y)` (`calibrate/fit_wb_map.py` `xy_to_uv`).
    static func uv(x: Double, y: Double) -> (u: Double, v: Double) {
        let d = 1.5 - x + 6 * y
        return (2 * x / d, 3 * y / d)
    }

    /// CIE 1960 uv → CIE 1931 xy: `x = 1.5u / (u − 4v + 2)`,
    /// `y = v / (u − 4v + 2)` (`calibrate/fit_wb_map.py` `uv_to_xy`).
    static func xy(u: Double, v: Double) -> (x: Double, y: Double) {
        let d = u - 4 * v + 2
        return (1.5 * u / d, v / d)
    }
}

/// The DNG SDK temperature model (`dng_temperature`): Robertson isotherms in
/// CIE 1960 uv, tint = the distance from the locus × −3000. The same table
/// and arithmetic as `calibrate/wbmodel.py` (and the stage-2 crate). Apple's
/// `CIRAWFilter` neutral temperature / tint follow the same model.
enum DNGTemperature {
    struct Row {
        let mired: Double
        let u: Double
        let v: Double
        let slope: Double
    }

    static let tintScale = -3000.0

    // swiftlint:disable comma
    static let table: [Row] = [
        Row(mired: 0,   u: 0.18006, v: 0.26352, slope: -0.24341),
        Row(mired: 10,  u: 0.18066, v: 0.26589, slope: -0.25479),
        Row(mired: 20,  u: 0.18133, v: 0.26846, slope: -0.26876),
        Row(mired: 30,  u: 0.18208, v: 0.27119, slope: -0.28539),
        Row(mired: 40,  u: 0.18293, v: 0.27407, slope: -0.30470),
        Row(mired: 50,  u: 0.18388, v: 0.27709, slope: -0.32675),
        Row(mired: 60,  u: 0.18494, v: 0.28021, slope: -0.35156),
        Row(mired: 70,  u: 0.18611, v: 0.28342, slope: -0.37915),
        Row(mired: 80,  u: 0.18740, v: 0.28668, slope: -0.40955),
        Row(mired: 90,  u: 0.18880, v: 0.28997, slope: -0.44278),
        Row(mired: 100, u: 0.19032, v: 0.29326, slope: -0.47888),
        Row(mired: 125, u: 0.19462, v: 0.30141, slope: -0.58204),
        Row(mired: 150, u: 0.19962, v: 0.30921, slope: -0.70471),
        Row(mired: 175, u: 0.20525, v: 0.31647, slope: -0.84901),
        Row(mired: 200, u: 0.21142, v: 0.32312, slope: -1.0182),
        Row(mired: 225, u: 0.21807, v: 0.32909, slope: -1.2168),
        Row(mired: 250, u: 0.22511, v: 0.33439, slope: -1.4512),
        Row(mired: 275, u: 0.23247, v: 0.33904, slope: -1.7298),
        Row(mired: 300, u: 0.24010, v: 0.34308, slope: -2.0637),
        Row(mired: 325, u: 0.24702, v: 0.34655, slope: -2.4681),
        Row(mired: 350, u: 0.25591, v: 0.34951, slope: -2.9641),
        Row(mired: 375, u: 0.26400, v: 0.35200, slope: -3.5814),
        Row(mired: 400, u: 0.27218, v: 0.35407, slope: -4.3633),
        Row(mired: 425, u: 0.28039, v: 0.35577, slope: -5.3762),
        Row(mired: 450, u: 0.28863, v: 0.35714, slope: -6.7262),
        Row(mired: 475, u: 0.29685, v: 0.35823, slope: -8.5955),
        Row(mired: 500, u: 0.30505, v: 0.35907, slope: -11.324),
        Row(mired: 525, u: 0.31320, v: 0.35968, slope: -15.628),
        Row(mired: 550, u: 0.32129, v: 0.36011, slope: -23.325),
        Row(mired: 575, u: 0.32931, v: 0.36038, slope: -40.770),
        Row(mired: 600, u: 0.33724, v: 0.36051, slope: -116.45),
    ]
    // swiftlint:enable comma

    /// The references (`wbmodel.xy_from_temperature`, the crate's
    /// `xy_from_temperature`) clamp temperatures below this to it.
    static let referenceMinimumTemperature = 2000.0

    /// Below this (the last isotherm, 600 mired) `xy` extrapolates.
    static let tableMinimumTemperature = 1e6 / 600

    /// `dng_temperature::Get_xy_coord` (`LegacyGetXY`;
    /// `wbmodel.xy_from_temperature`, the crate's `xy_from_temperature`): the
    /// chromaticity of (temperature K, tint), the inverse of `temperatureTint`.
    /// Temperatures below `minimumTemperature` are clamped to it like the
    /// references (the default); nil evaluates the SDK formula as is, which
    /// follows the isotherms down to 1667 K and extrapolates the last pair below.
    static func xy(
        temperature: Double,
        tint: Double,
        minimumTemperature: Double? = referenceMinimumTemperature
    ) -> (x: Double, y: Double) {
        let kelvin = minimumTemperature.map { Swift.max(temperature, $0) } ?? temperature
        let r = 1e6 / kelvin
        let offset = tint * (1 / tintScale)
        for index in 0 ..< table.count - 1 {
            guard r < table[index + 1].mired || index == table.count - 2 else { continue }
            let a = table[index]
            let b = table[index + 1]
            let f = (b.mired - r) / (b.mired - a.mired)
            var u = a.u * f + b.u * (1 - f)
            var v = a.v * f + b.v * (1 - f)
            let length1 = (1 + a.slope * a.slope).squareRoot()
            let length2 = (1 + b.slope * b.slope).squareRoot()
            let uu1 = 1 / length1
            let vv1 = a.slope / length1
            let uu2 = 1 / length2
            let vv2 = b.slope / length2
            var uu3 = uu1 * f + uu2 * (1 - f)
            var vv3 = vv1 * f + vv2 * (1 - f)
            let length3 = (uu3 * uu3 + vv3 * vv3).squareRoot()
            uu3 /= length3
            vv3 /= length3
            u += uu3 * offset
            v += vv3 * offset
            return (1.5 * u / (u - 4 * v + 2), v / (u - 4 * v + 2))
        }
        // Not reached (the last pair always returns); D50 like the references.
        return (0.3457, 0.3585)
    }

    /// `dng_temperature::Set_xy_coord` (`wbmodel.temperature_from_xy`):
    /// (temperature K, tint) of a chromaticity. nil for a non-finite result.
    static func temperatureTint(x: Double, y: Double) -> (temperature: Double, tint: Double)? {
        guard x.isFinite, y.isFinite else { return nil }
        let (u, v) = ColorMath.uv(x: x, y: y)
        var lastDt = 0.0
        var lastDu = 0.0
        var lastDv = 0.0
        for index in 1 ..< table.count {
            var du = 1.0
            var dv = table[index].slope
            var length = (1 + dv * dv).squareRoot()
            du /= length
            dv /= length
            var uu = u - table[index].u
            var vv = v - table[index].v
            var dt = -uu * dv + vv * du
            guard dt <= 0 || index == table.count - 1 else {
                lastDt = dt
                lastDu = du
                lastDv = dv
                continue
            }
            dt = -Swift.min(dt, 0)
            let f = index == 1 ? 0 : dt / (lastDt + dt)
            let temperature = 1e6 / (table[index - 1].mired * f + table[index].mired * (1 - f))
            uu = u - (table[index - 1].u * f + table[index].u * (1 - f))
            vv = v - (table[index - 1].v * f + table[index].v * (1 - f))
            du = du * (1 - f) + lastDu * f
            dv = dv * (1 - f) + lastDv * f
            length = (du * du + dv * dv).squareRoot()
            du /= length
            dv /= length
            let tint = (uu * du + vv * dv) * tintScale
            guard temperature.isFinite, tint.isFinite else { return nil }
            return (temperature, tint)
        }
        return nil
    }
}
