import Foundation

/// The per-camera calibration registry `niho-develop-calibration-registry/v1`
/// (`packages/develop-engine/calibration/apple-registry.json`, Epic #16939
/// S4b #17034): one calibration file per camera for the production working
/// copy. `render --calibration-registry` picks the entry whose make / model
/// match the RAW strictly and loads it like `--calibration`; no match renders
/// with the registry's `fallback` when it has one, else uncalibrated.
///
/// The optional `fallback` (`{"file": ...}`, #18398) is one calibration for
/// every camera without an entry, fitted on the calibrated cameras together
/// (`calibrate/fit_generic.py`). Its contract keeps everything but the color
/// as an uncalibrated render: no camera (`camera.make` / `model` empty, a
/// `camera.id` for the baseVersion), `lens.mode` apple, gamut mapping on, no
/// white-balance map or table (both are measured per camera). It applies
/// only to the decoder version it was fitted on (DNG's `8.DNG` stays
/// uncalibrated) and never to the signed working copy (its registry has no
/// fallback: an unregistered camera keeps the legacy recipe).
///
/// Every problem with the registry itself (missing, unreadable, malformed, an
/// entry pointing outside the registry's folder or at a missing file, two
/// entries matching one RAW, a calibration for another camera or track) is
/// `invalid_calibration` (exit 4), never `input_not_found` / `read_failed`:
/// those name the RAW, and the production worker treats them as a broken
/// original.
struct CalibrationRegistry {
    static let schema = "niho-develop-calibration-registry/v1"

    struct Entry: Equatable, Sendable {
        let make: String
        let model: String
        /// Relative to the registry's folder (never absolute, never `..`).
        let file: String
    }

    /// What `render` records: the registry's file name and the chosen entry's
    /// `file` (nil = no entry matched the RAW and no fallback applied);
    /// `fallback` = the file is the registry's fallback.
    struct Selection: Equatable, Sendable {
        let registry: String
        let file: String?
        var fallback = false

        var json: [String: Any] {
            ["registry": registry, "file": JSONOutput.optional(file), "fallback": fallback]
        }
    }

    private struct Document: Decodable {
        struct Camera: Decodable {
            let make: String
            let model: String
            let file: String
        }

        struct Fallback: Decodable {
            let file: String
        }

        let schema: String
        let track: String
        let cameras: [Camera]
        let fallback: Fallback?
    }

    let path: String
    let directory: URL
    let track: String
    let cameras: [Entry]
    /// The fallback's `file` (relative to the registry's folder), nil = none.
    var fallback: String? = nil

    /// The registry's file name (recorded instead of its absolute path).
    var fileName: String { URL(fileURLWithPath: path).lastPathComponent }

    static func load(path: String) throws -> CalibrationRegistry {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ToolError.invalidCalibration("calibration registry not found: \(url.path)")
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw ToolError.invalidCalibration("cannot read calibration registry \(url.path): \(error.localizedDescription)")
        }
        return try parse(data: data, path: url.path)
    }

    static func parse(data: Data, path: String) throws -> CalibrationRegistry {
        let document: Document
        do {
            document = try JSONDecoder().decode(Document.self, from: data)
        } catch {
            throw ToolError.invalidCalibration("\(path): \(Calibration.describe(decodingError: error))")
        }
        guard document.schema == schema else {
            throw ToolError.unsupportedCalibrationFeature(
                "calibration registry schema '\(document.schema)' is not supported (expected '\(schema)')"
            )
        }
        guard !document.track.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ToolError.invalidCalibration("\(path): track must be a non-empty string")
        }
        guard !document.cameras.isEmpty else {
            throw ToolError.invalidCalibration("\(path): cameras must be a non-empty array")
        }
        let directory = URL(fileURLWithPath: path).standardizedFileURL.deletingLastPathComponent()
        var entries: [Entry] = []
        for (index, camera) in document.cameras.enumerated() {
            let make = camera.make.trimmingCharacters(in: .whitespacesAndNewlines)
            let model = camera.model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !make.isEmpty, !model.isEmpty, !camera.file.isEmpty else {
                throw ToolError.invalidCalibration("\(path): cameras[\(index)] needs a non-empty make, model and file")
            }
            guard isInside(directory: directory, relativePath: camera.file) else {
                throw ToolError.invalidCalibration(
                    "\(path): cameras[\(index)].file '\(camera.file)' must be a relative path inside the registry's folder"
                )
            }
            entries.append(Entry(make: make, model: model, file: camera.file))
        }
        if let fallback = document.fallback {
            guard !fallback.file.isEmpty, isInside(directory: directory, relativePath: fallback.file) else {
                throw ToolError.invalidCalibration(
                    "\(path): fallback.file '\(fallback.file)' must be a relative path inside the registry's folder"
                )
            }
        }
        return CalibrationRegistry(
            path: path,
            directory: directory,
            track: document.track,
            cameras: entries,
            fallback: document.fallback?.file
        )
    }

    /// A relative path without `..` that resolves inside `directory`.
    static func isInside(directory: URL, relativePath: String) -> Bool {
        guard !relativePath.hasPrefix("/"), !relativePath.hasPrefix("~") else { return false }
        let components = relativePath.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(where: { $0 == ".." }), components.last.map({ !$0.isEmpty }) == true else {
            return false
        }
        let resolved = directory.appendingPathComponent(relativePath).standardizedFileURL.path
        let base = directory.standardizedFileURL.path
        return resolved.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    /// Strict camera identity for the registry: both makes non-empty and
    /// matching as in `Calibration.sameCamera` (case-insensitive, one contains
    /// the other), and the normalized models non-empty and equal.
    static func strictlySameCamera(make: String?, model: String?, otherMake: String?, otherModel: String?) -> Bool {
        let makeText = Calibration.normalizedMake(make)
        let otherMakeText = Calibration.normalizedMake(otherMake)
        guard !makeText.isEmpty, !otherMakeText.isEmpty,
              makeText.contains(otherMakeText) || otherMakeText.contains(makeText)
        else { return false }
        let modelText = Calibration.normalizedModel(model, make: make)
        return !modelText.isEmpty && modelText == Calibration.normalizedModel(otherModel, make: otherMake)
    }

    /// The entry for this RAW's camera; nil = none (render uncalibrated).
    /// More than one match is `invalid_calibration`.
    func entry(make: String?, model: String?) throws -> Entry? {
        let matches = cameras.filter {
            Self.strictlySameCamera(make: $0.make, model: $0.model, otherMake: make, otherModel: model)
        }
        guard matches.count <= 1 else {
            let files = matches.map(\.file).joined(separator: ", ")
            throw ToolError.invalidCalibration(
                "\(path): \(matches.count) entries match \(make ?? "?") \(model ?? "?") (\(files)); a camera needs exactly one"
            )
        }
        return matches.first
    }

    /// Loads the entry's calibration like `--calibration` and requires its own
    /// `camera` to match the entry strictly and its `track` to be the registry's.
    func loadCalibration(for entry: Entry) throws -> Calibration {
        let url = directory.appendingPathComponent(entry.file).standardizedFileURL
        let calibration: Calibration
        do {
            calibration = try Calibration.load(path: url.path)
        } catch let error as ToolError where error.code == "input_not_found" || error.code == "read_failed" {
            throw ToolError.invalidCalibration("\(path): entry \(entry.file): \(error.message)")
        }
        let camera = calibration.document.camera
        guard Self.strictlySameCamera(
            make: camera.make,
            model: camera.model,
            otherMake: entry.make,
            otherModel: entry.model
        ) else {
            throw ToolError.invalidCalibration(
                "\(path): entry \(entry.file) is for \(camera.make ?? "?") \(camera.model ?? "?"), not \(entry.make) \(entry.model)"
            )
        }
        guard calibration.document.track == track else {
            throw ToolError.invalidCalibration(
                "\(path): entry \(entry.file) has track '\(calibration.document.track)', not the registry's '\(track)'"
            )
        }
        return calibration
    }

    /// A registry-selected calibration is a versioned decoder contract. Unlike
    /// an explicitly supplied `--calibration`, a registry must not silently
    /// apply it to a RAW rendered by a different decoder version.
    func validateDecoderVersion(of calibration: Calibration, file: String, appliedVersion: String) throws {
        let calibratedVersion = calibration.document.decoder.decoderVersion
        guard calibratedVersion == appliedVersion else {
            throw ToolError.invalidCalibration(
                "\(path): entry \(file) targets decoderVersion \(calibratedVersion), but the RAW uses \(appliedVersion)"
            )
        }
    }

    /// Selects and loads the calibration for this RAW's camera.
    func calibration(make: String?, model: String?) throws -> (calibration: Calibration?, selection: Selection) {
        guard let entry = try entry(make: make, model: model) else {
            return (nil, Selection(registry: fileName, file: nil))
        }
        return (try loadCalibration(for: entry), Selection(registry: fileName, file: entry.file))
    }

    /// `calibration(make:model:)`, then the fallback for a camera without an
    /// entry when the fallback was fitted on `decoderVersion` (the version the
    /// render will apply, after resolving `--allow-fallback`).
    func calibration(
        make: String?,
        model: String?,
        decoderVersion: String
    ) throws -> (calibration: Calibration?, selection: Selection) {
        let selected = try calibration(make: make, model: model)
        guard selected.calibration == nil, let file = fallback else { return selected }
        let calibration = try loadFallbackCalibration()
        guard calibration.document.decoder.decoderVersion == decoderVersion else { return selected }
        return (calibration, Selection(registry: fileName, file: file, fallback: true))
    }

    /// Loads the fallback like `--calibration` and checks its contract (see
    /// the type's comment). A registry without a fallback is a caller error.
    func loadFallbackCalibration() throws -> Calibration {
        guard let file = fallback else {
            throw ToolError.invalidCalibration("\(path): has no fallback")
        }
        let url = directory.appendingPathComponent(file).standardizedFileURL
        let calibration: Calibration
        do {
            calibration = try Calibration.load(path: url.path)
        } catch let error as ToolError where error.code == "input_not_found" || error.code == "read_failed" {
            throw ToolError.invalidCalibration("\(path): fallback \(file): \(error.message)")
        }
        let document = calibration.document
        func invalid(_ reason: String) -> ToolError {
            ToolError.invalidCalibration("\(path): fallback \(file) \(reason)")
        }
        guard Calibration.normalizedMake(document.camera.make).isEmpty,
              Calibration.normalizedMake(document.camera.model).isEmpty
        else {
            throw invalid("is for \(document.camera.make ?? "?") \(document.camera.model ?? "?"); a fallback has no camera")
        }
        guard let cameraId = document.camera.id, !cameraId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw invalid("has no camera.id (the working copy's baseVersion names it)")
        }
        guard document.track == track else {
            throw invalid("has track '\(document.track)', not the registry's '\(track)'")
        }
        guard calibration.lensMode == .apple else {
            throw invalid("has lens.mode \(calibration.lensMode?.rawValue ?? "(none)"); a fallback corrects the lens as an uncalibrated render (apple)")
        }
        guard calibration.gamutMapping ?? true else {
            throw invalid("turns gamut mapping off; a fallback renders as an uncalibrated render (on)")
        }
        guard calibration.whiteBalanceMap == nil, calibration.whiteBalanceMapModel == nil,
              calibration.whiteBalanceTable == nil
        else {
            throw invalid("has a white-balance map or table; both are measured per camera")
        }
        return calibration
    }

    /// Lens modes a production working copy may use (`off` is for color
    /// measurement only; owner decision 2026-09-29).
    static let workingCopyLensModes: Set<LensCorrectionMode> = [.apple, .embedded]

    /// One verified entry (`registry` subcommand; no absolute paths).
    struct VerifiedEntry {
        let entry: Entry
        let calibration: Calibration
        let lensMode: LensCorrectionMode

        var json: [String: Any] {
            [
                "make": entry.make,
                "model": entry.model,
                "file": entry.file,
                "id": calibration.id,
                "cameraId": JSONOutput.optional(calibration.document.camera.id),
                "version": calibration.document.version,
                "lensMode": lensMode.rawValue,
                "whiteBalanceTable": calibration.whiteBalanceTable != nil,
            ]
        }
    }

    /// The fallback as the startup check reports it (no absolute paths).
    struct VerifiedFallback {
        let file: String
        let calibration: Calibration

        var json: [String: Any] {
            [
                "file": file,
                "id": calibration.id,
                "cameraId": JSONOutput.optional(calibration.document.camera.id),
                "version": calibration.document.version,
                "decoderVersion": calibration.document.decoder.decoderVersion,
                "lensMode": LensCorrectionMode.apple.rawValue,
            ]
        }
    }

    /// The startup check of the fallback: its contract
    /// (`loadFallbackCalibration`) and a `camera.id` no entry uses (the
    /// baseVersion must tell them apart). nil = the registry has none.
    func verifyFallback(entries: [VerifiedEntry]) throws -> VerifiedFallback? {
        guard let file = fallback else { return nil }
        let calibration = try loadFallbackCalibration()
        let cameraId = calibration.document.camera.id
        if let clash = entries.first(where: { $0.calibration.document.camera.id == cameraId }) {
            throw ToolError.invalidCalibration(
                "\(path): fallback \(file) has camera.id \(cameraId ?? "?"), the same as entry \(clash.entry.file)"
            )
        }
        return VerifiedFallback(file: file, calibration: calibration)
    }

    /// The production worker's startup check: every entry loads with the full
    /// calibration contract (`loadCalibration`: schema, decoder, matrix,
    /// baselineEV, lens, white-balance table, camera and track), no two entries are the same camera
    /// (the selection's strict rule), each has a `camera.id` (the working
    /// copy's baseVersion names it) and a `lens.mode` of apple or embedded.
    /// The fallback is checked by `verifyFallback(entries:)`.
    func verify() throws -> [VerifiedEntry] {
        for (index, entry) in cameras.enumerated() {
            for other in cameras[(index + 1)...] where Self.strictlySameCamera(
                make: entry.make,
                model: entry.model,
                otherMake: other.make,
                otherModel: other.model
            ) {
                throw ToolError.invalidCalibration(
                    "\(path): \(entry.file) and \(other.file) are the same camera (\(entry.make) \(entry.model)); a camera needs exactly one entry"
                )
            }
        }
        return try cameras.map { entry in
            let calibration = try loadCalibration(for: entry)
            guard let lensMode = calibration.lensMode, Self.workingCopyLensModes.contains(lensMode) else {
                throw ToolError.invalidCalibration(
                    "\(path): entry \(entry.file) has lens.mode \(calibration.lensMode?.rawValue ?? "(none)"); a working copy needs apple or embedded"
                )
            }
            guard let cameraId = calibration.document.camera.id,
                  !cameraId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                throw ToolError.invalidCalibration("\(path): entry \(entry.file) has no camera.id")
            }
            return VerifiedEntry(entry: entry, calibration: calibration, lensMode: lensMode)
        }
    }
}
