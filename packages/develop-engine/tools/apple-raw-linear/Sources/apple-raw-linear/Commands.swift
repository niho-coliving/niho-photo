import CoreImage
import Foundation

enum InputFile {
    /// Absolute URL of an existing regular file, or `input_not_found`.
    static func existing(_ path: String) throws -> URL {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              !isDirectory.boolValue
        else {
            throw ToolError.inputNotFound("input file not found: \(url.path)")
        }
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            throw ToolError.readFailed("input file is not readable: \(url.path)")
        }
        return url
    }

    static func json(_ url: URL) -> [String: Any] {
        [
            "path": url.path,
            "bytes": FileWriting.fileSize(url).map { $0 as Any } ?? NSNull(),
        ]
    }
}

// MARK: - info

enum InfoCommand {
    static func run(_ options: InfoOptions) throws -> String {
        let url = try InputFile.existing(options.input)
        let metadata = ImageMetadata.read(url: url)
        let inspection = try RawInspector.inspect(url: url, decoderVersion: options.decoderVersion)
        let cameras = RuntimeEnvironment.supportedCameraModels()
        let document: [String: Any] = [
            "tool": Tool.metadata,
            "input": InputFile.json(url),
            "camera": metadata.cameraJSON,
            "shooting": metadata.shootingJSON,
            "supportedDecoderVersions": inspection.supportedDecoderVersions,
            "defaultDecoderVersion": inspection.defaultDecoderVersion,
            "decoderVersion": inspection.decoderVersion,
            "nativeSize": ["width": inspection.nativeWidth, "height": inspection.nativeHeight],
            "orientation": inspection.orientation,
            "neutral": inspection.neutral?.json ?? NSNull(),
            "appleDefaults": inspection.appleDefaults,
            "supportedCameraModelsCount": cameras.models.count,
            "supportedCameraModelsSHA256": cameras.sha256,
            "environment": RuntimeEnvironment.snapshot(),
        ]
        if options.json {
            return String(decoding: try JSONOutput.pretty(document), as: UTF8.self)
        }
        return text(metadata: metadata, inspection: inspection, url: url, cameraCount: cameras.models.count)
    }

    private static func text(
        metadata: ImageMetadata,
        inspection: RawInspection,
        url: URL,
        cameraCount: Int
    ) -> String {
        func value(_ key: String) -> String {
            switch inspection.appleDefaults[key] {
            case let number as Double: String(number)
            case let flag as Bool: flag ? "true" : "false"
            case let other?: "\(other)"
            case nil: "-"
            }
        }
        var lines: [String] = []
        lines.append("file: \(url.path) (\(FileWriting.fileSize(url).map(String.init) ?? "?") bytes)")
        lines.append("camera: \(metadata.make ?? "?") \(metadata.model ?? "?")"
            + (metadata.iso.map { "  ISO \(Int($0))" } ?? ""))
        lines.append("decoder versions: \(inspection.supportedDecoderVersions.joined(separator: ", ")) "
            + "(default \(inspection.defaultDecoderVersion); values below read with \(inspection.decoderVersion))")
        lines.append("native size: \(inspection.nativeWidth) x \(inspection.nativeHeight), orientation \(inspection.orientation)")
        if let neutral = inspection.neutral {
            lines.append(String(
                format: "as-shot neutral: T %.2f K, tint %.2f, xy (%.5f, %.5f)",
                neutral.temperatureK, neutral.tint, neutral.x, neutral.y
            ))
        } else {
            lines.append("as-shot neutral: unavailable")
        }
        lines.append("apple defaults: baselineExposure \(value("baselineExposure")), shadowBias \(value("shadowBias")), "
            + "boostAmount \(value("boostAmount")), boostShadowAmount \(value("boostShadowAmount")), "
            + "EDR \(value("extendedDynamicRangeAmount"))")
        lines.append("  NR luminance \(value("luminanceNoiseReductionAmount")), color \(value("colorNoiseReductionAmount")), "
            + "sharpness \(value("sharpnessAmount")), detail \(value("detailAmount")), "
            + "moire \(value("moireReductionAmount")), contrast \(value("contrastAmount")), "
            + "localToneMap \(value("localToneMapAmount"))")
        lines.append("  lens correction supported \(value("isLensCorrectionSupported")), enabled \(value("isLensCorrectionEnabled")); "
            + "gamut mapping \(value("isGamutMappingEnabled")); highlight recovery \(value("isHighlightRecoveryEnabled"))")
        lines.append("supported camera models: \(cameraCount)")
        return lines.joined(separator: "\n") + "\n"
    }
}

// MARK: - cameras

enum CamerasCommand {
    /// First line: the count. Then one model per line, sorted.
    static func listing() -> String {
        let models = RuntimeEnvironment.supportedCameraModels().models
        return ([String(models.count)] + models).joined(separator: "\n") + "\n"
    }

    static func run(_ options: CamerasOptions) throws -> String? {
        let text = listing()
        guard let out = options.out else { return text }
        let url = URL(fileURLWithPath: out).standardizedFileURL
        try FileWriting.write(Data(text.utf8), to: url)
        FileHandle.standardError.write(Data("wrote \(url.path)\n".utf8))
        return nil
    }
}

// MARK: - registry

enum RegistryCommand {
    /// One JSON line describing a verified registry (file names relative to
    /// the registry's folder; no absolute paths).
    static func run(_ options: RegistryOptions) throws -> String {
        let registry = try CalibrationRegistry.load(path: options.registry)
        let entries = try registry.verify()
        let fallback = try registry.verifyFallback(entries: entries)
        return JSONOutput.singleLine([
            "ok": true,
            "tool": Tool.metadata,
            "registry": registry.fileName,
            "track": registry.track,
            "cameras": entries.count,
            "entries": entries.map(\.json),
            "fallback": fallback?.json ?? NSNull(),
        ] as [String: Any])
    }
}

// MARK: - render

enum RenderCommand {
    /// `x.tiff` → `x.json` (extension replaced); no extension → `x.json`.
    /// With a working-copy meta, `x.png` → `x.meta.json`: `x.json` is the
    /// working copy's own sidecar name (`make_working_copies.py`, the crate
    /// bridge), so the tool metadata moves out of its way.
    static func defaultMetaURL(for out: URL, workingCopy: Bool = false) -> URL {
        let stem = out.pathExtension.isEmpty ? out : out.deletingPathExtension()
        return workingCopy
            ? stem.appendingPathExtension("meta").appendingPathExtension("json")
            : stem.appendingPathExtension("json")
    }

    /// linear sRGB (Apple output) → output space, with the calibration
    /// (defined in linear ProPhoto) and `exposureScale` folded in
    /// (`2^baselineEV` for tiff32f / tiff16, 1 for the png16-g18 working copy).
    static func sourceToOutputMatrix(
        space: OutputSpace,
        calibration: Matrix3?,
        exposureScale: Double
    ) -> Matrix3 {
        let toProPhoto = ColorMath.linearSRGBToLinearProPhoto
        guard let calibration else {
            let base = space == .linearProPhoto ? toProPhoto : .identity
            return exposureScale == 1 ? base : base.scaled(by: exposureScale)
        }
        let inProPhoto = calibration.scaled(by: exposureScale) * toProPhoto
        return space == .linearProPhoto ? inProPhoto : ColorMath.linearProPhotoToLinearSRGB * inProPhoto
    }

    static func spaceJSON(_ space: OutputSpace, matrix: Matrix3) -> [String: Any] {
        var json: [String: Any] = [
            "name": space.rawValue,
            "transfer": "linear",
            "sourceSpace": "extended-linear-srgb-d65-as-shot",
            "sourceToOutputMatrix": JSONOutput.matrix(matrix),
        ]
        switch space {
        case .linearProPhoto:
            json["primaries"] = "ProPhoto (ROMM)"
            json["whitePoint"] = "D50"
            json["conversion"] = "inv(M_prophoto_to_xyz_d50) · M_srgb_to_xyz_d50 (Lindbloom, Bradford), no clipping"
            json["srgbToProPhotoMatrix"] = JSONOutput.matrix(ColorMath.linearSRGBToLinearProPhoto)
        case .linearSRGB:
            json["primaries"] = "sRGB (Rec. 709)"
            json["whitePoint"] = "D65"
            json["conversion"] = "none (Core Image working space values)"
        }
        return json
    }

    static func encodingJSON(
        _ encoding: OutputEncoding,
        colorSpace: OutputColorSpace,
        signed: SignedWorkingCopy.Encoding? = nil
    ) -> [String: Any] {
        switch encoding {
        case .tiff32f:
            return [
                "name": encoding.rawValue,
                "container": "tiff",
                "compression": "none",
                "channels": 3,
                "bitsPerSample": 32,
                "sampleFormat": "ieee-float",
                "clip": NSNull(),
                "transfer": "linear",
                "iccProfile": colorSpace.description,
            ]
        case .tiff16:
            return [
                "name": encoding.rawValue,
                "container": "tiff",
                "compression": "none",
                "channels": 3,
                "bitsPerSample": 16,
                "sampleFormat": "uint",
                "clip": [0, 1],
                "transfer": "linear",
                "quantization": "round(clip(x) * 65535)",
                "iccProfile": colorSpace.description,
            ]
        case .png16g18:
            return [
                "name": encoding.rawValue,
                "container": "png",
                "channels": 3,
                "bitsPerSample": 16,
                "sampleFormat": "uint",
                "clip": [0, JSONOutput.number(WorkingCopy.ceiling)],
                "ceiling": JSONOutput.number(WorkingCopy.ceiling),
                "gamma": JSONOutput.number(WorkingCopy.gamma),
                "transfer": "gamma 1.8 with a 2.0 ceiling ((x / 2)^(1/1.8))",
                "quantization": "round((clip(x, 0, 2) / 2)^(1/1.8) * 65535)",
                "decode": "x = 2.0 * (code / 65535)^1.8",
                "contract": "stage-2 working copy (niho-develop decode.rs WORKING_COPY_GAMMA 1.8 / WORKING_COPY_MAX 2.0): linear ProPhoto D50 before exposure; the calibration matrix is applied, 2^baselineEV is not",
                "iccProfile": colorSpace.description,
                "note": WorkingCopy.displayNote,
            ]
        case .png16SignedG18:
            return [
                "name": encoding.rawValue,
                "container": "png",
                "channels": 3,
                "bitsPerSample": 16,
                "sampleFormat": "uint",
                "clip": NSNull(),
                "ceiling": signed.map { JSONOutput.number($0.ceiling) } ?? NSNull(),
                "gamma": JSONOutput.number(SignedWorkingCopy.gamma),
                "zeroCode": 32_768,
                "kind": SignedWorkingCopy.kind,
                "transfer": "signed gamma 1.8 around code 32768 with a per-image power-of-two ceiling",
                "quantization": "roundToNearestEven(32768 + sign(x) * (abs(x) / ceiling)^(1/1.8) * 32767)",
                "decode": "x = sign(code - 32768) * ceiling * (abs(code - 32768) / 32767)^1.8",
                "contract": "p3/e4 signed RAW working copy; linear ProPhoto D50 after post-resize f32 calibration, before baselineEV",
                "iccProfile": colorSpace.description,
                "note": SignedWorkingCopy.displayNote,
            ]
        }
    }

    /// `auto` → the calibration's `lens.mode`, else `apple` (before the
    /// `embedded` → `apple` fallback for a RAW without its own data).
    static func resolvedLensMode(
        requested: LensCorrectionMode,
        calibration: LensCorrectionMode?
    ) -> LensCorrectionMode {
        requested == .auto ? (calibration ?? .apple) : requested
    }

    /// A working copy always corrects the lens (owner decision 2026-09-29):
    /// `off` is for color measurement renders (tiff32f) only.
    static func requireLensCorrectionForWorkingCopy(_ mode: LensCorrectionMode) throws {
        guard mode != .off else {
            throw ToolError.invalidArguments(
                "a working copy (--working-copy-meta) always corrects the lens; --lens-correction off (given, or the calibration's lens.mode) is for color measurement renders only"
            )
        }
    }

    /// A working copy is always as shot: stage 2 changes the white from
    /// `asShotWhite`, so `--white` is for measurement renders only.
    static func requireAsShotWhiteForWorkingCopy(_ white: LightroomWhite?) throws {
        guard white == nil else {
            throw ToolError.invalidArguments(
                "a working copy (--working-copy-meta) is always rendered as shot; --white is for measurement renders only"
            )
        }
    }

    /// `auto` → the calibration's `decoder.settings.gamutMapping` when it is a
    /// bool, else on (0.4.0's pinned value); `source` goes to the metadata.
    static func resolvedGamutMapping(
        requested: GamutMappingMode,
        calibration: Calibration?
    ) -> (enabled: Bool, source: String) {
        switch requested {
        case .on:
            return (true, "--gamut-mapping")
        case .off:
            return (false, "--gamut-mapping")
        case .auto:
            if let setting = calibration?.gamutMapping {
                return (setting, "calibration decoder.settings.gamutMapping")
            }
            return (true, "default")
        }
    }

    /// The table check's two renders (see `WhiteBalanceTableCheck`): the main
    /// render's decoder version, gamut mapping, NR and sharpening, boost 0,
    /// Core Image's lens correction off, at `longEdge`; `r0` as shot (neutral
    /// untouched), then `r1` from the same instance at the check white (the
    /// same pixels as a fresh instance on macOS 27.0 26A428, in about 230 ms
    /// instead of 340–550). Never throws: anything that keeps the check from
    /// comparing is a mismatch.
    static func checkWhiteBalanceTable(
        _ table: WhiteBalanceTable,
        inputURL: URL,
        decoderVersion: String,
        options: RenderOptions,
        gamutMapping: Bool,
        asShot: LightroomWhite?,
        map: WhiteBalanceUVOffset?,
        renderer: RawRenderer
    ) -> WhiteBalanceTableCheck {
        let started = ContinuousClock.now
        func mismatch(_ reason: String, white: LightroomWhite?) -> WhiteBalanceTableCheck {
            WhiteBalanceTableCheck(
                mismatch: reason,
                white: white,
                asShot: asShot,
                ms: milliseconds(from: started, to: .now)
            )
        }
        guard let asShot else {
            return mismatch("the as-shot white has no temperature / tint in Lightroom's scale", white: nil)
        }
        let white = WhiteBalanceTableCheck.checkWhite(asShot: asShot)
        guard let transfer = table.transfer(from: asShot, to: white) else {
            return mismatch("the table's matrix at the check white is singular", white: white)
        }
        guard let target = RenderWhite.resolve(white, map: map) else {
            return mismatch("the check white is not a valid chromaticity", white: white)
        }
        do {
            let filter = try RawInspector.makeFilter(url: inputURL)
            filter.decoderVersion = CIRAWDecoderVersion(rawValue: decoderVersion)
            guard let width = RawInspector.pixelDimension(filter.nativeSize.width),
                  let height = RawInspector.pixelDimension(filter.nativeSize.height)
            else {
                throw ToolError.unsupportedCamera("Core Image reports an invalid native size")
            }
            var checkOptions = options
            checkOptions.boost = 0
            AssignedSettings(
                decoderVersion: decoderVersion,
                options: checkOptions,
                scaleFactor: RawRenderer.scaleFactor(
                    longEdge: .pixels(WhiteBalanceTableCheck.longEdge),
                    nativeWidth: width,
                    nativeHeight: height
                ),
                lensMode: .off,
                gamutMapping: gamutMapping
            ).apply(to: filter)
            func render() throws -> RawRenderer.Rendered {
                guard let image = filter.outputImage else {
                    throw ToolError.unsupportedCamera("CIRAWFilter.outputImage is nil")
                }
                return try renderer.render(image: image)
            }
            let reference = try render()
            defer { reference.pixels.deallocate() }
            filter.neutralChromaticity = target.neutralChromaticity
            let checked = try render()
            defer { checked.pixels.deallocate() }
            guard reference.width == checked.width, reference.height == checked.height else {
                return mismatch(
                    "the check renders differ in size (\(reference.width)x\(reference.height), \(checked.width)x\(checked.height))",
                    white: white
                )
            }
            let count = reference.width * reference.height * 4
            let comparison = WhiteBalanceTableCheck.compare(
                asShot: UnsafeBufferPointer(start: reference.pixels, count: count),
                check: UnsafeBufferPointer(start: checked.pixels, count: count),
                toTableSpace: sourceToOutputMatrix(space: .linearProPhoto, calibration: nil, exposureScale: 1),
                transfer: transfer
            )
            return WhiteBalanceTableCheck(
                white: white,
                asShot: asShot,
                residual: comparison.residual,
                pixels: comparison.pixels,
                ms: milliseconds(from: started, to: .now)
            )
        } catch let error as ToolError {
            return mismatch("a check render failed: \(error.message)", white: white)
        } catch {
            return mismatch("a check render failed: \(error)", white: white)
        }
    }

    /// What the render actually did about the lens, for `lensCorrection` in
    /// the metadata. `mode` is the resolved mode after the `embedded` → `apple`
    /// fallback; `apple` becomes `none` (`reason: "unsupported"`) when Core
    /// Image has no correction for this RAW (a manual lens without a profile):
    /// the render still succeeds, and the metadata says nothing was corrected.
    /// `coreImage` is the flag read back from the filter after assignment.
    static func effectiveLensCorrection(
        requested: LensCorrectionMode,
        mode: LensCorrectionMode,
        isLensCorrectionSupported: Bool?,
        coreImageEnabled: Bool?,
        assignedCoreImage: Bool
    ) -> [String: Any] {
        var json: [String: Any] = [
            "requested": requested.rawValue,
            "mode": mode.rawValue,
            "coreImage": coreImageEnabled ?? assignedCoreImage,
        ]
        guard mode == .apple else { return json }
        if isLensCorrectionSupported == false || coreImageEnabled == false {
            json["mode"] = "none"
            json["reason"] = isLensCorrectionSupported == false ? "unsupported" : "not_enabled"
            json["source"] = "Core Image has no lens correction for this RAW, and it has no embedded correction data"
        } else {
            json["source"] = "Core Image isLensCorrectionEnabled (distortion only; no vignetting)"
        }
        return json
    }

    static func extensionWarning(out: URL, encoding: OutputEncoding) -> String? {
        let ext = out.pathExtension.lowercased()
        switch encoding {
        case .tiff32f, .tiff16:
            return ["tif", "tiff"].contains(ext) ? nil : "--out extension '.\(ext)' is not .tif/.tiff for \(encoding.rawValue)"
        case .png16g18, .png16SignedG18:
            return ext == "png" ? nil : "--out extension '.\(ext)' is not .png for \(encoding.rawValue)"
        }
    }

    // swiftlint:disable:next function_body_length
    static func run(_ options: RenderOptions, arguments: [String]) throws -> [String: Any] {
        let started = ContinuousClock.now
        let createdAt = JSONOutput.iso8601Now()
        var warnings: [String] = []

        let inputURL = try InputFile.existing(options.input)
        let outURL = URL(fileURLWithPath: options.out).standardizedFileURL
        let workingCopyMetaURL = options.workingCopyMeta.map { URL(fileURLWithPath: $0).standardizedFileURL }
        let metaURL = options.meta.map { URL(fileURLWithPath: $0).standardizedFileURL }
            ?? defaultMetaURL(for: outURL, workingCopy: workingCopyMetaURL != nil)
        let outputPaths = [outURL.path, metaURL.path] + (workingCopyMetaURL.map { [$0.path] } ?? [])
        guard Set(outputPaths).count == outputPaths.count else {
            throw ToolError.invalidArguments("--out, --meta and --working-copy-meta must be different files")
        }
        let protectedPaths = [inputURL.path] + [options.calibration, options.calibrationRegistry].compactMap {
            $0.map { URL(fileURLWithPath: $0).standardizedFileURL.path }
        }
        guard outputPaths.allSatisfy({ !protectedPaths.contains($0) }) else {
            throw ToolError.invalidArguments(
                "--out / --meta / --working-copy-meta must not overwrite the input RAW or the calibration"
            )
        }
        if let warning = extensionWarning(out: outURL, encoding: options.encoding) {
            warnings.append(warning)
        }

        let metadata = ImageMetadata.read(url: inputURL)
        var calibration: Calibration?
        var calibrationRegistry: CalibrationRegistry? = nil
        var registrySelection: CalibrationRegistry.Selection?
        if let registryPath = options.calibrationRegistry {
            let registry = try CalibrationRegistry.load(path: registryPath)
            calibrationRegistry = registry
            // The fallback (#18398) is for the legacy encodings only; the signed
            // working copy of an unregistered camera stays uncalibrated.
            let selected = options.encoding.isSignedWorkingCopy
                ? try registry.calibration(make: metadata.make, model: metadata.model)
                : try registry.calibration(
                    make: metadata.make,
                    model: metadata.model,
                    decoderVersion: options.decoderVersion
                )
            calibration = selected.calibration
            registrySelection = selected.selection
            if let calibration, outputPaths.contains(calibration.path) {
                throw ToolError.invalidArguments(
                    "--out / --meta / --working-copy-meta must not overwrite the input RAW or the calibration"
                )
            }
        } else {
            calibration = try options.calibration.map { try Calibration.load(path: $0) }
            registrySelection = nil
        }
        // Lens: auto → the calibration's lens.mode, else apple. A working copy
        // never renders with the correction off (checked before decoding).
        let preflightLensMode = resolvedLensMode(requested: options.lensCorrection, calibration: calibration?.lensMode)
        if workingCopyMetaURL != nil || options.encoding.isSignedWorkingCopy {
            try requireLensCorrectionForWorkingCopy(preflightLensMode)
            try requireAsShotWhiteForWorkingCopy(options.white)
        }

        // Resolve the decoder actually applied before final calibration selection.
        // --allow-fallback can change it from the requested version to Core Image's default.
        let decodeStarted = ContinuousClock.now
        let filter = try RawInspector.makeFilter(url: inputURL)
        let supportedVersions = filter.supportedDecoderVersions.map(\.rawValue)
        let defaultVersion = filter.decoderVersion.rawValue
        let appliedVersion: String
        let fallback: Bool
        if supportedVersions.contains(options.decoderVersion) {
            filter.decoderVersion = CIRAWDecoderVersion(rawValue: options.decoderVersion)
            appliedVersion = options.decoderVersion
            fallback = false
        } else if options.allowFallback {
            appliedVersion = defaultVersion
            fallback = true
            warnings.append(
                "decoderVersion \(options.decoderVersion) is not supported for this file (supported: \(supportedVersions.joined(separator: ", "))); used the default \(defaultVersion) (--allow-fallback)"
            )
        } else {
            throw ToolError.unsupportedDecoderVersion(
                "decoderVersion \(options.decoderVersion) is not supported for \(inputURL.lastPathComponent) (supported: \(supportedVersions.joined(separator: ", "))); --allow-fallback uses \(defaultVersion)"
            )
        }

        if !options.encoding.isSignedWorkingCopy, let calibrationRegistry {
            let selected = try calibrationRegistry.calibration(
                make: metadata.make,
                model: metadata.model,
                decoderVersion: appliedVersion
            )
            calibration = selected.calibration
            registrySelection = selected.selection
            if let calibration, outputPaths.contains(calibration.path) {
                throw ToolError.invalidArguments(
                    "--out / --meta / --working-copy-meta must not overwrite the input RAW or the calibration"
                )
            }
        }

        // Recheck settings with the calibration selected for the applied decoder.
        var lensMode = resolvedLensMode(requested: options.lensCorrection, calibration: calibration?.lensMode)
        if workingCopyMetaURL != nil || options.encoding.isSignedWorkingCopy {
            try requireLensCorrectionForWorkingCopy(lensMode)
            try requireAsShotWhiteForWorkingCopy(options.white)
        }
        let gamutMapping = resolvedGamutMapping(requested: options.gamutMapping, calibration: calibration)
        // --white: Lightroom's scale → the xy Core Image is given (the
        // calibration's whiteBalanceMap inverted; as is without one).
        var renderWhite: RenderWhite?
        if let white = options.white {
            let map = calibration?.whiteBalanceMap
            guard let resolved = RenderWhite.resolve(white, map: map) else {
                throw ToolError.invalidArguments(
                    "--white \(white.temperature),\(white.tint) is not a valid chromaticity\(map == nil ? "" : " after the calibration's whiteBalanceMap")"
                )
            }
            if map == nil, let model = calibration?.whiteBalanceMapModel {
                warnings.append(
                    "calibration whiteBalanceMap.model '\(model)' is not supported (only \(WhiteBalanceUVOffset.model)); --white was given to Core Image unmapped"
                )
            }
            if white.temperature < DNGTemperature.tableMinimumTemperature {
                warnings.append(
                    "--white \(white.temperature) K is below the DNG isotherm table (600 mired); its xy is extrapolated"
                )
            }
            renderWhite = resolved
        }

        // The render instance. Its neutral properties are untouched unless
        // --white sets neutralChromaticity (AssignedSettings.apply).
        if let selection = registrySelection, let selectedFile = selection.file {
            guard let selectedCalibration = calibration, let calibrationRegistry else {
                throw ToolError.invalidCalibration("calibration registry selected \(selectedFile) without a loaded calibration")
            }
            try calibrationRegistry.validateDecoderVersion(
                of: selectedCalibration,
                file: selectedFile,
                appliedVersion: appliedVersion
            )
        }

        // A separate info instance: as-shot neutral and Apple's defaults.
        let inspection = try RawInspector.inspect(url: inputURL, decoderVersion: appliedVersion)
        if workingCopyMetaURL != nil, inspection.neutral == nil {
            throw ToolError.unsupportedCamera(
                "Core Image reports no as-shot white for \(inputURL.lastPathComponent); a working-copy meta needs asShotWhite (x, y)"
            )
        }
        let resolution = try calibration?.resolve(neutralTemperatureK: inspection.neutral?.temperatureK)

        guard let nativeWidth = RawInspector.pixelDimension(filter.nativeSize.width),
              let nativeHeight = RawInspector.pixelDimension(filter.nativeSize.height)
        else {
            throw ToolError.unsupportedCamera("Core Image reports an invalid native size for \(inputURL.lastPathComponent)")
        }
        // p3 always asks Core Image for the full RAW. Its long-edge option is
        // a post-lens, post-sRGB→ProPhoto Lanczos4 downsample below.
        let scaleFactor: Float = options.encoding.isSignedWorkingCopy
            ? 1
            : RawRenderer.scaleFactor(
                longEdge: options.longEdge,
                nativeWidth: nativeWidth,
                nativeHeight: nativeHeight
            )
        // embedded needs the RAW's own data; without it the render falls back to apple.
        var lensParams: SonyLensParams?
        if lensMode == .embedded {
            lensParams = SonyLensParams.read(url: inputURL)
            if lensParams == nil {
                warnings.append(
                    "--lens-correction embedded: \(inputURL.lastPathComponent) has no embedded distortion data (Sony ARW SubIFD 0x7037); used Core Image's correction (apple)"
                )
                lensMode = .apple
            }
        }
        let lensSettings = calibration?.lensSettings ?? LensSettings.sonyDefault
        if lensMode == .embedded, calibration?.lensSettings == nil {
            warnings.append(
                "--lens-correction embedded without a calibration lens section: used the ZV-E10 II measured radius scales (distortion \(lensSettings.distortionRadiusScale), vignetting \(lensSettings.vignettingRadiusScale))"
            )
        }
        let assigned = AssignedSettings(
            decoderVersion: appliedVersion,
            options: options,
            scaleFactor: scaleFactor,
            lensMode: lensMode,
            gamutMapping: gamutMapping.enabled,
            neutralChromaticity: renderWhite?.neutralChromaticity
        )
        assigned.apply(to: filter)
        if let calibration {
            warnings += calibration.warnings(
                cameraMake: metadata.make,
                cameraModel: metadata.model,
                decoderVersion: appliedVersion,
                comparableSettings: assigned.calibrationComparable
            )
        }

        guard let image = filter.outputImage else {
            throw ToolError.unsupportedCamera(
                "CIRAWFilter.outputImage is nil for \(inputURL.lastPathComponent) (decoderVersion \(appliedVersion))"
            )
        }
        let renderer = RawRenderer()
        let rendered = try renderer.render(image: image)
        var pixels = rendered.pixels
        var outputWidth = rendered.width
        var outputHeight = rendered.height
        defer { pixels.deallocate() }
        let decodeRenderMs = milliseconds(from: decodeStarted, to: .now)
        // Read back only after rendering, so reading cannot influence pixels.
        // The neutral only for --white (as shot, it stays neither read nor written).
        var effective = RawInspector.properties(of: filter)
        if renderWhite != nil {
            effective.merge(RawInspector.neutralProperties(of: filter)) { _, new in new }
        }

        // Embedded lens correction on the linear render, before the color matrix
        // (both are linear per pixel; the warp only moves pixels).
        let lensStarted = ContinuousClock.now
        var lensJSON = effectiveLensCorrection(
            requested: options.lensCorrection,
            mode: lensMode,
            isLensCorrectionSupported: effective["isLensCorrectionSupported"] as? Bool,
            coreImageEnabled: effective["isLensCorrectionEnabled"] as? Bool,
            assignedCoreImage: assigned.isLensCorrectionEnabled
        )
        if lensMode == .embedded, let lensParams {
            let applied = EmbeddedLensCorrection.apply(
                to: pixels,
                width: rendered.width,
                height: rendered.height,
                params: lensParams,
                settings: lensSettings
            )
            lensJSON.merge(applied.json) { _, new in new }
        }
        if lensJSON["mode"] as? String == "none" {
            warnings.append(
                "Core Image has no lens correction for \(inputURL.lastPathComponent) and it has no embedded correction data; the lens is not corrected"
            )
        }
        let lensMs = milliseconds(from: lensStarted, to: .now)

        // p3 color/resize order is intentionally split. The old encodings
        // continue through the combined transform below unchanged.
        var resizeMs = 0.0
        if options.encoding.isSignedWorkingCopy {
            _ = PixelPipeline.apply(
                PixelTransform(
                    matrix: ColorMath.linearSRGBToLinearProPhoto,
                    ceiling: nil,
                    encodeExponent: nil
                ),
                to: pixels,
                width: outputWidth,
                height: outputHeight
            )
            let resizeStarted = ContinuousClock.now
            let sourceCount = try Lanczos4.elementCount(width: outputWidth, height: outputHeight, channels: 4)
            if let resized = try Lanczos4.resizeIfNeeded(
                UnsafeBufferPointer(start: pixels, count: sourceCount),
                width: outputWidth,
                height: outputHeight,
                longEdge: options.longEdge
            ) {
                // Release the full decoded/lens-corrected region immediately
                // after the downsample has completed.
                pixels.deallocate()
                pixels = resized.pixels
                outputWidth = resized.width
                outputHeight = resized.height
            }
            resizeMs = milliseconds(from: resizeStarted, to: .now)
        }

        // Color: legacy = combined matrix (+ EV) then clip/gamma. p3/e4 =
        // calibration-only f32 matrix after resize, with no clipping or EV.
        let colorStarted = ContinuousClock.now
        let appliesBaselineEV = options.encoding.appliesBaselineEV
        let exposureScale = appliesBaselineEV ? (calibration?.exposureScale ?? 1) : 1
        let matrix = sourceToOutputMatrix(
            space: options.space,
            calibration: resolution?.matrix,
            exposureScale: exposureScale
        )
        let transform = options.encoding.isSignedWorkingCopy
            ? PixelTransform(matrix: resolution?.matrix ?? .identity, ceiling: nil, encodeExponent: nil)
            : PixelTransform(matrix: matrix, encoding: options.encoding)
        let stats = PixelPipeline.apply(transform, to: pixels, width: outputWidth, height: outputHeight)
        let colorMs = milliseconds(from: colorStarted, to: .now)
        if stats.nonFinitePixelCount > 0, !options.encoding.isSignedWorkingCopy {
            warnings.append("\(stats.nonFinitePixelCount) pixels had non-finite values")
        }

        // Encode + write.
        let encodeStarted = ContinuousClock.now
        let outputColorSpace = OutputColorSpace.select(space: options.space, encoding: options.encoding)
        let pixelCount = outputWidth * outputHeight
        var signedEncoding: SignedWorkingCopy.Encoding?
        switch options.encoding {
        case .tiff32f:
            PixelPipeline.compactRGBAToRGB(pixels, pixelCount: pixelCount)
            try ImageWriter.writeFloat32RGB(
                UnsafeRawPointer(pixels),
                width: outputWidth,
                height: outputHeight,
                colorSpace: outputColorSpace.colorSpace,
                to: outURL
            )
        case .tiff16, .png16g18:
            let packed = UnsafeMutablePointer<UInt16>.allocate(capacity: pixelCount * 3)
            defer { packed.deallocate() }
            PixelPipeline.quantizeToUInt16RGB(
                pixels,
                width: outputWidth,
                height: outputHeight,
                into: packed
            )
            try ImageWriter.writeUInt16RGB(
                UnsafeRawPointer(packed),
                width: outputWidth,
                height: outputHeight,
                colorSpace: outputColorSpace.colorSpace,
                container: options.encoding == .png16g18 ? .png : .tiff,
                to: outURL
            )
        case .png16SignedG18:
            let sourceCount = try Lanczos4.elementCount(width: outputWidth, height: outputHeight, channels: 4)
            let outputCount = try Lanczos4.elementCount(width: outputWidth, height: outputHeight, channels: 3)
            let packed = UnsafeMutablePointer<UInt16>.allocate(capacity: outputCount)
            defer { packed.deallocate() }
            signedEncoding = try SignedWorkingCopy.encode(
                UnsafeBufferPointer(start: pixels, count: sourceCount),
                width: outputWidth,
                height: outputHeight,
                into: UnsafeMutableBufferPointer(start: packed, count: outputCount)
            )
            try ImageWriter.writeUInt16RGB(
                UnsafeRawPointer(packed),
                width: outputWidth,
                height: outputHeight,
                colorSpace: outputColorSpace.colorSpace,
                container: .png,
                to: outURL
            )
        }
        let encodeMs = milliseconds(from: encodeStarted, to: .now)

        // The calibration's white-balance table (gamut mapping off only),
        // checked on this RAW before the working copy carries it. A separate
        // filter instance: the pixels above are final.
        var checkedTable: CheckedWhiteBalanceTable?
        if workingCopyMetaURL != nil, let neutral = inspection.neutral,
           let table = WorkingCopy.usableWhiteBalanceTable(calibration: calibration, gamutMapping: gamutMapping.enabled) {
            let check = checkWhiteBalanceTable(
                table,
                inputURL: inputURL,
                decoderVersion: appliedVersion,
                options: options,
                gamutMapping: gamutMapping.enabled,
                asShot: WorkingCopy.asShotLightroomWhite(neutral: neutral, calibration: calibration),
                map: calibration?.whiteBalanceMap,
                renderer: renderer
            )
            if let warning = check.warning {
                warnings.append(warning)
            }
            checkedTable = CheckedWhiteBalanceTable(
                table: table,
                calibrationMatrix: resolution?.matrix ?? .identity,
                check: check
            )
        }
        let totalMs = milliseconds(from: started, to: .now)
        let peakRSS = RuntimeEnvironment.peakResidentBytes()

        var calibrationJSON: Any = NSNull()
        if let calibration, let resolution {
            var json = calibration.metadataSource
            json["matrixApplied"] = JSONOutput.matrix(resolution.matrix)
            json["resolution"] = resolution.details
            json["baselineEVApplied"] = appliesBaselineEV
            json["exposureScaleApplied"] = JSONOutput.number(exposureScale)
            if options.encoding.isSignedWorkingCopy {
                json["appliedIn"] = "linear-prophoto-d50 f32 after full-resolution sRGB→ProPhoto and Lanczos4; baselineEV is metadata only"
            } else {
                json["appliedIn"] = appliesBaselineEV
                    ? "linear-prophoto-d50, after the sRGB→ProPhoto matrix, then × 2^baselineEV"
                    : "linear-prophoto-d50, after the sRGB→ProPhoto matrix; 2^baselineEV is not applied (working copy: stage 2 multiplies 2^(baselineEV + exposure))"
            }
            calibrationJSON = json
        }

        // The crate's working-copy metadata, next to the image it describes.
        var workingCopyJSON: Any = NSNull()
        if let workingCopyMetaURL, let neutral = inspection.neutral {
            let calibrationSource: Any = calibration.map { calibration in
                [
                    "path": calibration.path,
                    "sha256": calibration.sha256,
                    "id": calibration.id,
                    "cameraId": JSONOutput.optional(calibration.document.camera.id),
                    "track": calibration.document.track,
                    "version": calibration.document.version,
                    "baseVersion": calibration.document.baseVersion,
                    "registry": registrySelection?.json ?? NSNull(),
                ] as [String: Any]
            } ?? NSNull()
            var source: [String: Any] = [
                "tool": Tool.metadata,
                "createdAt": createdAt,
                "input": InputFile.json(inputURL),
                "camera": metadata.cameraJSON,
                "decoderVersion": appliedVersion,
                "calibration": calibrationSource,
                "matrixApplied": calibration != nil,
                "baselineEVApplied": false,
                "encoding": "png16 gamma 1.8 ceiling 2.0 linear ProPhoto D50, before exposure (\(WorkingCopy.formula))",
                "clippedAbove2Fraction": JSONOutput.number(stats.aboveCeilingPixelFraction),
                "negativeFraction": JSONOutput.number(stats.negativePixelFraction),
                "outputSize": ["width": outputWidth, "height": outputHeight],
                "lensCorrectionEnabled": effective["isLensCorrectionEnabled"] ?? NSNull(),
                "lensCorrection": lensJSON,
                "output": outURL.path,
                "toolMeta": metaURL.path,
                "note": WorkingCopy.displayNote,
            ]
            if options.encoding.isSignedWorkingCopy, let signedEncoding {
                source["recipe"] = [
                    "id": SignedWorkingCopy.recipe,
                    "processing": "p3",
                    "encoding": "e4",
                    "order": [
                        "Core Image scaleFactor=1 linear sRGB f32",
                        "lens correction at full decoded resolution",
                        "f32 sRGB→linear ProPhoto",
                        "Lanczos4 long-edge downsample (or full)",
                        "f32 camera calibration matrix",
                        "signed-gamma18-v1 PNG16",
                    ],
                ] as [String: Any]
                source["encoding"] = signedEncoding.json
                source["sourceSize"] = ["width": nativeWidth, "height": nativeHeight]
                source["decodedSize"] = ["width": rendered.width, "height": rendered.height]
                source["requestedLongEdge"] = options.longEdge.jsonValue
                source["noiseReduction"] = ["requested": options.nr.rawValue, "resolved": "off"]
                source["gamutMapping"] = [
                    "requested": options.gamutMapping.rawValue,
                    "resolved": gamutMapping.enabled ? "on" : "off",
                    "source": gamutMapping.source,
                ]
                source["sharpen"] = ["requested": options.sharpen.rawValue, "resolved": "apple-default"]
                source["calibrationMatrixOrder"] = "post-Lanczos4 f32; baselineEV metadata only"
                source["calibrationProvenance"] = calibration.map { calibration in
                    [
                        "path": calibration.path,
                        "sha256": calibration.sha256,
                        "matrix": calibration.document.matrixProvenance?.foundationValue ?? NSNull(),
                        "recipe": calibration.document.recipeProvenance?.foundationValue ?? NSNull(),
                    ] as [String: Any]
                } ?? NSNull()
                source["note"] = SignedWorkingCopy.displayNote
                source.removeValue(forKey: "clippedAbove2Fraction")
            }
            let built = WorkingCopy.metadata(
                neutral: neutral,
                calibration: calibration,
                decoderVersion: appliedVersion,
                whiteBalanceTable: checkedTable,
                encoding: signedEncoding,
                source: source
            )
            warnings += built.warnings
            try FileWriting.write(try JSONOutput.pretty(built.json), to: workingCopyMetaURL)
            workingCopyJSON = [
                "path": workingCopyMetaURL.path,
                "baselineEV": built.json["baselineEV"] ?? NSNull(),
                "dcpSha256": built.json["dcpSha256"] ?? NSNull(),
                "asShotWhiteAdobe": built.json["asShotWhiteAdobe"] ?? NSNull(),
                "whiteBalanceTableCheck": checkedTable?.check.json ?? NSNull(),
            ] as [String: Any]
        }
        var timing: [String: Any] = [
            "decodeRender": JSONOutput.number(decodeRenderMs),
            "lens": JSONOutput.number(lensMs),
            "color": JSONOutput.number(colorMs),
            "encode": JSONOutput.number(encodeMs),
            "total": JSONOutput.number(totalMs),
        ]
        if let checkedTable {
            timing["whiteBalanceTableCheck"] = JSONOutput.number(checkedTable.check.ms)
        }
        if options.encoding.isSignedWorkingCopy {
            timing["lanczos4"] = JSONOutput.number(resizeMs)
        }

        var meta: [String: Any] = [
            "tool": Tool.metadata,
            "createdAt": createdAt,
            "arguments": arguments,
            "input": InputFile.json(inputURL),
            "camera": metadata.cameraJSON,
            "shooting": metadata.shootingJSON,
            "decoderVersion": appliedVersion,
            "decoderVersionRequested": options.decoderVersion,
            "decoderVersionFallback": fallback,
            "defaultDecoderVersion": defaultVersion,
            "supportedDecoderVersions": supportedVersions,
            "appliedSettings": [
                "options": [
                    "longEdge": options.longEdge.jsonValue,
                    "boost": JSONOutput.number(options.boost),
                    "nr": options.nr.rawValue,
                    "sharpen": options.sharpen.rawValue,
                    "lensCorrection": options.lensCorrection.rawValue,
                    "gamutMapping": options.gamutMapping.rawValue,
                    "white": options.white?.json ?? NSNull(),
                ] as [String: Any],
                "lensCorrection": lensJSON,
                "gamutMapping": [
                    "requested": options.gamutMapping.rawValue,
                    "resolved": gamutMapping.enabled ? GamutMappingMode.on.rawValue : GamutMappingMode.off.rawValue,
                    "source": gamutMapping.source,
                ],
                "assigned": assigned.json,
                "assignmentOrder": assigned.assignmentOrder,
                "effective": effective,
            ] as [String: Any],
            "appleDefaults": inspection.appleDefaults,
            "neutral": inspection.neutral?.json ?? NSNull(),
            "renderedWhite": renderWhite?.json ?? NSNull(),
            "orientation": inspection.orientation,
            "nativeSize": ["width": nativeWidth, "height": nativeHeight],
            "outputSize": ["width": outputWidth, "height": outputHeight],
            "decoderExtent": [
                "x": JSONOutput.number(rendered.extent.minX),
                "y": JSONOutput.number(rendered.extent.minY),
                "width": JSONOutput.number(rendered.extent.width),
                "height": JSONOutput.number(rendered.extent.height),
            ],
            "scaleFactor": JSONOutput.number(scaleFactor),
            "space": spaceJSON(options.space, matrix: matrix),
            "encoding": encodingJSON(options.encoding, colorSpace: outputColorSpace, signed: signedEncoding),
            "calibration": calibrationJSON,
            "calibrationRegistry": registrySelection?.json ?? NSNull(),
            "workingCopyMeta": workingCopyJSON,
            "stats": stats.json,
            "warnings": warnings,
            "timingMs": timing,
            "peakRSSBytes": peakRSS.map { $0 as Any } ?? NSNull(),
            "environment": RuntimeEnvironment.snapshot(),
            "output": [
                "path": outURL.path,
                "bytes": FileWriting.fileSize(outURL).map { $0 as Any } ?? NSNull(),
            ],
        ]
        if options.encoding.isSignedWorkingCopy {
            meta["recipe"] = [
                "id": SignedWorkingCopy.recipe,
                "processing": "p3",
                "encoding": "e4",
                "decodeScaleFactor": 1,
                "resize": "custom Lanczos4, 8 taps, half-pixel f32 coordinates/weights, replicated border",
                "calibrationAfterResize": true,
                "baselineEVApplied": false,
            ] as [String: Any]
        }
        try FileWriting.write(try JSONOutput.pretty(meta), to: metaURL)

        for warning in warnings {
            FileHandle.standardError.write(Data("warning: \(warning)\n".utf8))
        }
        var summary: [String: Any] = [
            "ok": true,
            "out": outURL.path,
            "meta": metaURL.path,
            "width": outputWidth,
            "height": outputHeight,
            "decoderVersion": appliedVersion,
            "space": options.space.rawValue,
            "encoding": options.encoding.rawValue,
            "totalMs": JSONOutput.number(totalMs),
            "warnings": warnings.count,
        ]
        if let workingCopyMetaURL {
            summary["workingCopyMeta"] = workingCopyMetaURL.path
        }
        return summary
    }
}
