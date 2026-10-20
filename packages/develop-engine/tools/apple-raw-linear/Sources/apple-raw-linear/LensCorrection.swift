import Foundation

/// How the working copy's lens distortion / vignetting is corrected
/// (Epic #16939 S10 #17031).
///
/// - `apple`: Core Image's own correction (`isLensCorrectionEnabled`). It
///   matches Lightroom within 0.3 px on the DC-S5 (RW2 embedded data) but
///   never corrects vignetting, and leaves 30-40 px at the edges on the
///   ZV-E10 II kit lens.
/// - `embedded`: Core Image's correction off, then the RAW's own correction
///   data applied here (Sony ARW `DistortionCorrParams` / `VignettingCorrParams`).
///   Matches Lightroom's lens profile within 1 px on the ZV-E10 II 16-17 mm.
/// - `auto`: the calibration's `lens.mode`, else `apple`.
enum LensCorrectionMode: String, CaseIterable, Sendable {
    case auto
    case apple
    case embedded
    case off

    /// `on` (0.2.x) is accepted as `apple`.
    static func parse(_ value: String) -> LensCorrectionMode? {
        value == "on" ? .apple : LensCorrectionMode(rawValue: value)
    }
}

/// `lens` in the calibration JSON (the measured normalization for the camera).
struct LensSettings: Equatable, Sendable {
    /// Measured against Lightroom's lens profiles (tools/lens-check, S10b):
    /// the distortion radius is taken after the frame scale (see
    /// `EmbeddedLensCorrection.frameScale`), and 1.01 fits the ZV-E10 II +
    /// E PZ 16-50mm at 16, 17 and 49 mm and the FX30 + E 16-55mm G at 16 and
    /// 55 mm within 0.3 px. Used when `embedded` is requested without a
    /// calibration `lens` section.
    static let sonyDefault = LensSettings(distortionRadiusScale: 1.01, vignettingRadiusScale: 1.146, vignetting: true)

    /// Half-diagonal multiplier for the distortion knots (the knot radius is
    /// measured on the frame-scaled output position |p| * k).
    let distortionRadiusScale: Double
    /// Half-diagonal multiplier for the vignetting knots.
    let vignettingRadiusScale: Double
    let vignetting: Bool
}

/// Sony ARW lens correction data in the plaintext SubIFD (IFD0 → 0x014A):
/// 0x7037 DistortionCorrParams, 0x7032 VignettingCorrParams,
/// 0x7035 ChromaticAberrationCorrParams (the encrypted SR2SubIFD holds the
/// same values as 0x7982 / 0x797D / 0x7980). Each is int16s `[n, v0 ... v(n-1), padding]`.
struct SonyLensParams: Equatable, Sendable {
    static let distortionTag: UInt16 = 0x7037
    static let vignettingTag: UInt16 = 0x7032
    static let chromaticAberrationTag: UInt16 = 0x7035

    let distortion: [Int]
    let vignetting: [Int]?
    let chromaticAberration: [Int]?

    /// Reads the tags from IFD0 → SubIFD (0x014A) of a TIFF-based RAW.
    /// nil when the file is not TIFF-structured or has no distortion data.
    static func read(url: URL) -> SonyLensParams? {
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else { return nil }
        return parse(data: data)
    }

    static func parse(data: Data) -> SonyLensParams? {
        guard let tiff = TIFFReader(data: data),
              let ifd0 = tiff.ifd(at: tiff.firstIFDOffset),
              let subIFDs = ifd0[0x014A].flatMap(tiff.unsignedValues)
        else { return nil }
        for offset in subIFDs {
            guard let sub = tiff.ifd(at: offset),
                  let distortion = sub[distortionTag].flatMap(tiff.signedValues).flatMap(counted)
            else { continue }
            return SonyLensParams(
                distortion: distortion,
                vignetting: sub[vignettingTag].flatMap(tiff.signedValues).flatMap(counted),
                chromaticAberration: sub[chromaticAberrationTag].flatMap(tiff.signedValues).flatMap(counted)
            )
        }
        return nil
    }

    /// `[n, v0 ... v(n-1), ...]` → `[v0 ... v(n-1)]` (n >= 2).
    static func counted(_ values: [Int]) -> [Int]? {
        guard let n = values.first, n >= 2, values.count >= n + 1 else { return nil }
        return Array(values[1 ... n])
    }
}

/// Minimal TIFF IFD reader (both byte orders), only what the lens tags need.
struct TIFFReader {
    struct Entry {
        let type: UInt16
        let count: Int
        /// Offset of the value bytes (inline for <= 4 bytes).
        let valueOffset: Int
    }

    let data: Data
    let littleEndian: Bool
    let firstIFDOffset: Int

    init?(data: Data) {
        guard data.count >= 8 else { return nil }
        let b0 = data[data.startIndex], b1 = data[data.startIndex + 1]
        let littleEndian: Bool
        if b0 == 0x49, b1 == 0x49 {
            littleEndian = true
        } else if b0 == 0x4D, b1 == 0x4D {
            littleEndian = false
        } else {
            return nil
        }
        guard Self.u16(data, littleEndian, 2) == 42, let first = Self.u32(data, littleEndian, 4) else { return nil }
        self.data = data
        self.littleEndian = littleEndian
        firstIFDOffset = Int(first)
    }

    static func u16(_ data: Data, _ littleEndian: Bool, _ offset: Int) -> UInt16? {
        guard offset >= 0, offset + 2 <= data.count else { return nil }
        let a = UInt16(data[data.startIndex + offset]), b = UInt16(data[data.startIndex + offset + 1])
        return littleEndian ? a | (b << 8) : (a << 8) | b
    }

    static func u32(_ data: Data, _ littleEndian: Bool, _ offset: Int) -> UInt32? {
        guard let lo = u16(data, littleEndian, littleEndian ? offset : offset + 2),
              let hi = u16(data, littleEndian, littleEndian ? offset + 2 : offset)
        else { return nil }
        return UInt32(lo) | (UInt32(hi) << 16)
    }

    func u16(_ offset: Int) -> UInt16? { Self.u16(data, littleEndian, offset) }
    func u32(_ offset: Int) -> UInt32? { Self.u32(data, littleEndian, offset) }

    func ifd(at offset: Int) -> [UInt16: Entry]? {
        guard offset > 0, let count = u16(offset), count > 0, offset + 2 + Int(count) * 12 <= data.count else {
            return nil
        }
        var entries: [UInt16: Entry] = [:]
        for index in 0 ..< Int(count) {
            let base = offset + 2 + index * 12
            guard let tag = u16(base), let type = u16(base + 2), let n = u32(base + 4) else { return nil }
            let size = Self.size(of: type) * Int(n)
            let valueOffset: Int
            if size <= 4 {
                valueOffset = base + 8
            } else {
                guard let pointer = u32(base + 8) else { return nil }
                valueOffset = Int(pointer)
            }
            entries[tag] = Entry(type: type, count: Int(n), valueOffset: valueOffset)
        }
        return entries
    }

    static func size(of type: UInt16) -> Int {
        switch type {
        case 1, 2, 6, 7: return 1   // BYTE ASCII SBYTE UNDEFINED
        case 3, 8: return 2         // SHORT SSHORT
        case 4, 9, 13: return 4     // LONG SLONG IFD
        default: return 8           // RATIONAL etc. (not read here)
        }
    }

    /// SHORT / LONG / IFD values.
    func unsignedValues(_ entry: Entry) -> [Int]? {
        guard entry.count > 0, entry.valueOffset + Self.size(of: entry.type) * entry.count <= data.count else { return nil }
        switch entry.type {
        case 3: return (0 ..< entry.count).compactMap { u16(entry.valueOffset + $0 * 2).map(Int.init) }
        case 4, 13: return (0 ..< entry.count).compactMap { u32(entry.valueOffset + $0 * 4).map(Int.init) }
        default: return nil
        }
    }

    /// SSHORT (and SHORT reinterpreted as signed) values.
    func signedValues(_ entry: Entry) -> [Int]? {
        guard entry.type == 3 || entry.type == 8, entry.count > 0,
              entry.valueOffset + 2 * entry.count <= data.count
        else { return nil }
        return (0 ..< entry.count).compactMap { u16(entry.valueOffset + $0 * 2).map { Int(Int16(bitPattern: $0)) } }
    }
}

/// The embedded (Sony) correction on the rendered RGBA float buffer.
enum EmbeddedLensCorrection {
    /// Distortion magnification per knot: 1 + v * 2^-14. A first value that
    /// breaks the series (seen once: 834 among -1 .. -2027) is taken as 0;
    /// the centre barely moves pixels, so this only avoids a spurious zoom.
    static func distortionFactors(_ values: [Int]) -> [Double] {
        var v = values.map(Double.init)
        if v.count >= 2, abs(v[0]) > 4 * max(1, abs(v[1])) {
            v[0] = 0
        }
        return v.map { 1 + $0 * pow(2, -14) }
    }

    /// Vignetting gain per knot: 2^-(0.5 - 2^(v * 2^-13 - 1)) (1 at v = 0),
    /// the form darktable uses for the same data.
    static func vignettingGains(_ values: [Int]) -> [Double] {
        values.map { pow(2, -(0.5 - pow(2, Double($0) * pow(2, -13) - 1))) }
    }

    /// Catmull-Rom through knots at i / (n - 1), r clamped to [0, 1].
    static func catmullRom(_ f: [Double], _ r: Double) -> Double {
        let n = f.count
        guard n >= 2 else { return f.first ?? 1 }
        let t = min(max(r, 0), 1) * Double(n - 1)
        let i = min(Int(t.rounded(.down)), n - 2)
        let u = t - Double(i)
        let p0 = i == 0 ? 2 * f[0] - f[1] : f[i - 1]
        let p1 = f[i], p2 = f[i + 1]
        let p3 = i + 2 < n ? f[i + 2] : 2 * f[n - 1] - f[n - 2]
        return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
            + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
    }

    /// Linear interpolation through knots at i / (n - 1), r clamped to [0, 1].
    static func linear(_ g: [Double], _ r: Double) -> Double {
        let n = g.count
        guard n >= 2 else { return g.first ?? 1 }
        let t = min(max(r, 0), 1) * Double(n - 1)
        let i = min(Int(t.rounded(.down)), n - 2)
        let u = t - Double(i)
        return g[i] * (1 - u) + g[i + 1] * u
    }

    /// The output pixel p (from the centre) reads the source at
    /// p * k * f(|p| * k / R): the knots are looked up at the frame-scaled
    /// radius. Measured against Lightroom (S10b), this keeps one R for every
    /// focal length; looking the knots up at |p| / R needed R to change with
    /// the focal length (0.955 at 16 mm, 1.0 at 49 mm, 1.03 at 55 mm).
    static func sourceScale(factors: [Double], radius: Double, frameScale k: Double, distance: Double) -> Double {
        catmullRom(factors, distance * k / radius) * k
    }

    /// The largest overall magnification k such that every output border
    /// pixel p reads inside the source (p * k * f(|p| * k / R)), i.e. no empty
    /// corners, as the camera and Lightroom crop. k appears on both sides, so
    /// it is the fixed point of the border fit (a few iterations).
    static func frameScale(width: Int, height: Int, radius: Double, factors: [Double]) -> Double {
        let cx = Double(width - 1) / 2, cy = Double(height - 1) / 2
        func fit(_ current: Double) -> Double {
            var k = Double.infinity
            func visit(_ x: Double, _ y: Double) {
                let px = x - cx, py = y - cy
                let fr = catmullRom(factors, hypot(px, py) * current / radius)
                if abs(px * fr) > 1e-9 { k = min(k, cx / abs(px * fr)) }
                if abs(py * fr) > 1e-9 { k = min(k, cy / abs(py * fr)) }
            }
            for x in 0 ..< width {
                visit(Double(x), 0)
                visit(Double(x), Double(height - 1))
            }
            for y in 0 ..< height {
                visit(0, Double(y))
                visit(Double(width - 1), Double(y))
            }
            return k.isFinite ? k : 1
        }
        var k = 1.0
        for _ in 0 ..< 50 {
            let next = fit(k)
            if abs(next - k) < 1e-12 { return next }
            k = next
        }
        return k
    }

    struct Applied {
        let frameScale: Double
        let json: [String: Any]
    }

    /// Vignetting (at the source radius), then distortion (Catmull-Rom
    /// bicubic resampling, reflected border) in place on `width * height * 4`
    /// RGBA floats. Alpha is kept.
    static func apply(
        to pixels: UnsafeMutablePointer<Float>,
        width: Int,
        height: Int,
        params: SonyLensParams,
        settings: LensSettings
    ) -> Applied {
        let count = width * height * 4
        let source = UnsafeMutablePointer<Float>.allocate(capacity: count)
        defer { source.deallocate() }
        source.update(from: pixels, count: count)

        let cx = Double(width - 1) / 2, cy = Double(height - 1) / 2
        let halfDiagonal = hypot(Double(width) / 2, Double(height) / 2)
        let radius = halfDiagonal * settings.distortionRadiusScale
        let factors = distortionFactors(params.distortion)

        var vignettingJSON: Any = NSNull()
        if settings.vignetting, let values = params.vignetting {
            let gains = vignettingGains(values)
            let vRadius = halfDiagonal * settings.vignettingRadiusScale
            let rows = SharedPointer(source)
            DispatchQueue.concurrentPerform(iterations: height) { y in
                let py = Double(y) - cy
                for x in 0 ..< width {
                    let g = Float(linear(gains, hypot(Double(x) - cx, py) / vRadius))
                    let base = (y * width + x) * 4
                    rows.pointer[base] *= g
                    rows.pointer[base + 1] *= g
                    rows.pointer[base + 2] *= g
                }
            }
            vignettingJSON = [
                "knots": values.count,
                "radiusScale": JSONOutput.number(settings.vignettingRadiusScale),
                "maxGain": JSONOutput.number(gains.max() ?? 1),
            ] as [String: Any]
        }

        let k = frameScale(width: width, height: height, radius: radius, factors: factors)
        let src = SharedPointer(source)
        let dst = SharedPointer(pixels)
        DispatchQueue.concurrentPerform(iterations: height) { y in
            let py = Double(y) - cy
            for x in 0 ..< width {
                let px = Double(x) - cx
                let fr = sourceScale(factors: factors, radius: radius, frameScale: k, distance: hypot(px, py))
                let value = sampleBicubic(src.pointer, width: width, height: height, x: cx + px * fr, y: cy + py * fr)
                let base = (y * width + x) * 4
                dst.pointer[base] = value.x
                dst.pointer[base + 1] = value.y
                dst.pointer[base + 2] = value.z
                dst.pointer[base + 3] = 1
            }
        }
        return Applied(frameScale: k, json: [
            "source": "sony-arw-subifd (0x7037 DistortionCorrParams, 0x7032 VignettingCorrParams)",
            "distortion": [
                "knots": params.distortion.count,
                "radiusScale": JSONOutput.number(settings.distortionRadiusScale),
                "radiusBasis": "frame-scaled output radius (|p| * frameScale)",
                "frameScale": JSONOutput.number(k),
                "edgeFactor": JSONOutput.number(factors.last ?? 1),
            ] as [String: Any],
            "vignetting": vignettingJSON,
            "chromaticAberration": "not applied",
            "resampling": "Catmull-Rom bicubic, reflected border",
        ])
    }

    /// Catmull-Rom bicubic sample of RGB at a fractional position.
    static func sampleBicubic(_ p: UnsafeMutablePointer<Float>, width: Int, height: Int, x: Double, y: Double) -> SIMD3<Float> {
        let x0 = Int(x.rounded(.down)), y0 = Int(y.rounded(.down))
        let wx = weights(Float(x - Double(x0))), wy = weights(Float(y - Double(y0)))
        var sum = SIMD3<Float>(repeating: 0)
        for j in 0 ..< 4 {
            let yy = reflect(y0 - 1 + j, height)
            var row = SIMD3<Float>(repeating: 0)
            for i in 0 ..< 4 {
                let base = (yy * width + reflect(x0 - 1 + i, width)) * 4
                row += SIMD3(p[base], p[base + 1], p[base + 2]) * wx[i]
            }
            sum += row * wy[j]
        }
        return sum
    }

    static func weights(_ t: Float) -> SIMD4<Float> {
        let t2 = t * t, t3 = t2 * t
        return SIMD4(
            -0.5 * t3 + t2 - 0.5 * t,
            1.5 * t3 - 2.5 * t2 + 1,
            -1.5 * t3 + 2 * t2 + 0.5 * t,
            0.5 * t3 - 0.5 * t2
        )
    }

    static func reflect(_ i: Int, _ n: Int) -> Int {
        guard n > 1 else { return 0 }
        var v = i
        while v < 0 || v >= n {
            v = v < 0 ? -v : 2 * (n - 1) - v
        }
        return v
    }
}

private struct SharedPointer: @unchecked Sendable {
    let pointer: UnsafeMutablePointer<Float>
    init(_ pointer: UnsafeMutablePointer<Float>) { self.pointer = pointer }
}
