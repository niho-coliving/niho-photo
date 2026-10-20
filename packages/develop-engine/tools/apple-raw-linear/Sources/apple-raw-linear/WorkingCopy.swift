import Foundation

/// The stage-2 crate's working-copy contract (`niho-develop` `decode.rs`):
/// a 16-bit RGB PNG of linear ProPhoto (D50) before exposure,
/// `value = WORKING_COPY_MAX · (code / 65535)^WORKING_COPY_GAMMA` with
/// `WORKING_COPY_GAMMA = 1.8` and `WORKING_COPY_MAX = 2.0`, plus the metadata
/// JSON `WorkingCopyMeta::from_json` reads. `calibrate/make_working_copies.py`
/// writes the same files from a `tiff32f` render.
enum WorkingCopy {
    /// `WORKING_COPY_GAMMA`.
    static let gamma = 1.8
    /// `WORKING_COPY_MAX`: linear values above it are clipped.
    static let ceiling = 2.0

    static let formula = "code = round((clip(x, 0, 2) / 2)^(1/1.8) * 65535); x = 2.0 * (code / 65535)^1.8"

    static let displayNote = "Values are stored at half scale under a ROMM RGB (gamma 1.8) profile, so an ICC-aware viewer shows the image one stop dark. The working copy is stage-2 input, not for display."

    /// Reference encoder in Double (the crate's `encode_working_copy`):
    /// `round((clip(x, 0, 2) / 2)^(1/1.8) · 65535)`; NaN → 0. The render
    /// path computes the same in Float (`PixelTransform`, `quantize16`).
    static func encode(_ linear: Double) -> UInt16 {
        let unit = linear > 0 ? (linear < ceiling ? linear / ceiling : 1) : 0
        return UInt16((Foundation.pow(unit, 1 / gamma) * 65535).rounded())
    }

    /// The crate's `decode_working_copy`: `2.0 · (code / 65535)^1.8`.
    static func decode(_ code: UInt16) -> Double {
        ceiling * Foundation.pow(Double(code) / 65535, gamma)
    }

    /// `dcpSha256` without a calibration. The Apple path has no DCP, so the
    /// field carries the base's version string: the calibration's
    /// `baseVersion` (`apple-ciraw<decoderVersion>/<encoding>/cal-...`), or
    /// this when no calibration was applied.
    static func uncalibratedBaseVersion(decoderVersion: String) -> String {
        "apple-ciraw\(decoderVersion)/linear-prophoto-d50/uncalibrated"
    }

    struct Metadata {
        let json: [String: Any]
        let warnings: [String]
    }

    /// The calibration's white-balance table when this working copy can
    /// carry it: the table holds only for Core Image renders without gamut
    /// mapping, so gamut mapping on (or no table) means `whiteBalanceTable: null`.
    static func usableWhiteBalanceTable(calibration: Calibration?, gamutMapping: Bool) -> WhiteBalanceTable? {
        gamutMapping ? nil : calibration?.whiteBalanceTable
    }

    /// The as-shot white in Lightroom's scale (the table check's `w0`):
    /// `asShotWhiteAdobe`'s temperature / tint with a `whiteBalanceMap`, Core
    /// Image's own without one. nil when the map moves it off the diagram, or
    /// for a map model this version does not understand (the scale is unknown).
    static func asShotLightroomWhite(neutral: NeutralReading, calibration: Calibration?) -> LightroomWhite? {
        if let map = calibration?.whiteBalanceMap {
            guard let white = map.adobeWhite(x: neutral.x, y: neutral.y),
                  let dng = DNGTemperature.temperatureTint(x: white.x, y: white.y)
            else { return nil }
            return LightroomWhite(temperature: dng.temperature, tint: dng.tint)
        }
        guard calibration?.whiteBalanceMapModel == nil else { return nil }
        return LightroomWhite(temperature: neutral.temperatureK, tint: neutral.tint)
    }

    /// The crate's `WorkingCopyMeta` (`{"kind":"raw","baselineEV",
    /// "asShotWhite":{x,y,temperature,tint},"dcpSha256","lookTableIncluded"}`)
    /// plus `asShotWhiteAdobe` (a proposal the crate does not read yet: the
    /// white Adobe treats as as-shot, the starting point of the chromatic
    /// adaptation that reproduces Lightroom's absolute white balance),
    /// `whiteBalanceTable` (the calibration's table after this render's
    /// check, see `CheckedWhiteBalanceTable`; null without one) and `_source`
    /// (provenance; the crate ignores unknown keys).
    ///
    /// `baselineEV` is the calibration's (0 without one): the working copy
    /// holds only the calibration matrix, and stage 2 multiplies
    /// `2^(baselineEV + exposure)`.
    static func metadata(
        neutral: NeutralReading,
        calibration: Calibration?,
        decoderVersion: String,
        whiteBalanceTable: CheckedWhiteBalanceTable? = nil,
        encoding: SignedWorkingCopy.Encoding? = nil,
        source: [String: Any]
    ) -> Metadata {
        var warnings: [String] = []
        var adobe: Any = NSNull()
        if let map = calibration?.whiteBalanceMap {
            if let white = map.adobeWhite(x: neutral.x, y: neutral.y) {
                var json: [String: Any] = [
                    "x": JSONOutput.number(white.x),
                    "y": JSONOutput.number(white.y),
                    "source": "calibration.whiteBalanceMap (uv-offset from Apple as-shot)",
                    "du": JSONOutput.number(map.du),
                    "dv": JSONOutput.number(map.dv),
                ]
                if let dng = DNGTemperature.temperatureTint(x: white.x, y: white.y) {
                    json["temperature"] = JSONOutput.number(dng.temperature)
                    json["tint"] = JSONOutput.number(dng.tint)
                }
                adobe = json
            } else {
                warnings.append(
                    "whiteBalanceMap (uv-offset) moves the as-shot white (\(neutral.x), \(neutral.y)) off the chromaticity diagram; asShotWhiteAdobe is null"
                )
            }
        } else if let model = calibration?.whiteBalanceMapModel {
            warnings.append(
                "calibration whiteBalanceMap.model '\(model)' is not supported (only \(WhiteBalanceUVOffset.model)); asShotWhiteAdobe is null"
            )
        }
        var json: [String: Any] = [
            "kind": "raw",
            "baselineEV": JSONOutput.number(calibration?.baselineEV ?? 0),
            "asShotWhite": [
                "x": JSONOutput.number(neutral.x),
                "y": JSONOutput.number(neutral.y),
                "temperature": JSONOutput.number(neutral.temperatureK),
                "tint": JSONOutput.number(neutral.tint),
            ] as [String: Any],
            "dcpSha256": calibration?.document.baseVersion
                ?? uncalibratedBaseVersion(decoderVersion: decoderVersion),
            "lookTableIncluded": false,
            "asShotWhiteAdobe": adobe,
            "whiteBalanceTable": whiteBalanceTable?.json ?? NSNull(),
            "_source": source,
        ]
        // Missing means the legacy unsigned png16-g18 contract. Only the new
        // signed transport adds this object, so old readers and old metadata
        // remain distinguishable without a default migration.
        if let encoding {
            json["encoding"] = encoding.json
        }
        return Metadata(json: json, warnings: warnings)
    }
}
