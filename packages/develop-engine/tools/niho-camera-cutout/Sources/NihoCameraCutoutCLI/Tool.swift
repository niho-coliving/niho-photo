enum Tool {
    static let name = "niho-camera-cutout"
    /// The sidecar version NIHO camera checks at launch (`niho-camera-cutout
    /// version` → `niho-camera-cutout 0.1.0`, the same line as
    /// apple-raw-linear). scripts/sidecar-lock.mjs reads this literal.
    /// 0.1.0: copied from Photo Bench c76775b (NIHO camera 0.4.0) unchanged,
    /// plus `version` and `help`. Masks and composition are Photo Bench's.
    /// 0.2.0: `detect` (immutable masks named by SHA-256) and `compose`
    /// (mask + strokes + background), one JSON line each. Pixels unchanged.
    static let version = "0.2.0"
}
