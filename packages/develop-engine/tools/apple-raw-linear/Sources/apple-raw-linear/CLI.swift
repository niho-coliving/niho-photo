import Foundation

enum Tool {
    static let name = "apple-raw-linear"
    /// 0.2.0: `png16-g18` follows the stage-2 working-copy contract (2.0
    /// ceiling, no `2^baselineEV` in the pixels); `--working-copy-meta`.
    /// 0.4.0: `--calibration-registry`; a working copy never renders with the
    /// lens correction `off`. Pixels of the existing options are unchanged.
    /// 0.4.1: `encode-jpeg` (the full-size export's JPEG). A patch version
    /// (0.4.x) never changes the pixels of `render`.
    /// 0.4.2: `--gamut-mapping`, `--white`, the calibration's
    /// `whiteBalanceTable` (checked per working copy and copied to its meta).
    /// A patch version: without the new options and with no calibration or
    /// one saying `gamutMapping: true`, the pixels of `render` are 0.4.1's.
    /// 0.4.3: `raster` (the raster working copy as an 8-bit JPEG with the
    /// source's ICC, and its sRGB preview; K5-c1 #17153). `render` unchanged.
    /// W2b-1 #17145 (still 0.4.3: `render` / `raster` unchanged):
    /// `encode-jpeg` carries the capture time only, and `retag-jpeg`.
    /// 0.5.0: opt-in p3/e4 `png16-signed-g18`. Existing encodings retain
    /// their 0.4.3 decode, color, resize and metadata paths byte-for-byte.
    /// 0.5.1: the registry's `fallback` (#18398): a camera without an entry
    /// renders with it (legacy encodings, its decoder version). A patch
    /// version: with a registry without a fallback, and for every camera with
    /// an entry, the pixels are 0.5.0's; the fallback's working copy has its
    /// own baseVersion (`cal-<its camera.id>-…`).
    /// 0.5.2: `raster --long-edge full` preserves source dimensions when a
    /// JPEG can represent them; larger dimensions fail explicitly. A patch
    /// version: `render` and the default (2560px) `raster` are unchanged.
    static let version = "0.5.2"

    static var metadata: [String: Any] {
        ["name": name, "version": version]
    }
}

enum LongEdge: Equatable, Sendable {
    case pixels(Int)
    case full

    var jsonValue: Any {
        switch self {
        case let .pixels(value): value
        case .full: "full"
        }
    }
}

enum OutputSpace: String, CaseIterable, Sendable {
    case linearProPhoto = "linear-prophoto"
    case linearSRGB = "linear-srgb"
}

enum OutputEncoding: String, CaseIterable, Sendable {
    /// 32-bit float RGB TIFF, unclipped (measurement).
    case tiff32f
    /// 16-bit linear RGB TIFF, clipped to [0, 1].
    case tiff16
    /// The stage-2 working copy (crate `decode.rs`): 16-bit RGB PNG,
    /// `code = round((clip(x, 0, 2) / 2)^(1/1.8) · 65535)`, ROMM RGB ICC,
    /// before exposure (the calibration matrix only; `baselineEV` goes to
    /// the metadata).
    case png16g18 = "png16-g18"
    /// p3/e4 signed RAW working copy. The full-resolution linear ProPhoto
    /// image is Lanczos4-downsampled before the calibration matrix and then
    /// encoded around the zero code 32768 with a per-image power-of-two range.
    case png16SignedG18 = "png16-signed-g18"

    var isSignedWorkingCopy: Bool { self == .png16SignedG18 }
    var isWorkingCopy: Bool { self == .png16g18 || isSignedWorkingCopy }

    /// Linear values are clipped to `[0, ceiling]` and stored as
    /// `x / ceiling`; nil = unclipped float.
    var ceiling: Double? {
        switch self {
        case .tiff32f, .png16SignedG18: nil
        case .tiff16: 1
        case .png16g18: WorkingCopy.ceiling
        }
    }

    /// Encoding gamma (`(x / ceiling)^(1/gamma)`); nil = linear.
    var gamma: Double? {
        self == .png16g18 ? WorkingCopy.gamma : nil
    }

    /// Whether the calibration's `2^baselineEV` is multiplied into the
    /// pixels. The working copy is defined before exposure: stage 2
    /// multiplies `2^(baselineEV + exposure)` from its metadata.
    var appliesBaselineEV: Bool {
        !isWorkingCopy
    }
}

enum DefaultOrOff: String, CaseIterable, Sendable {
    case `default`
    case off
}

/// `--gamut-mapping`: Core Image's `isGamutMappingEnabled`. `auto` = the
/// calibration's `decoder.settings.gamutMapping` when it is a bool, else on.
enum GamutMappingMode: String, CaseIterable, Sendable {
    case auto
    case on
    case off
}

struct InfoOptions: Equatable {
    var input: String
    var json = false
    /// nil → the decoder version a fresh `CIRAWFilter` picks (Apple default).
    var decoderVersion: String?
}

struct CamerasOptions: Equatable {
    var out: String?
}

struct RegistryOptions: Equatable {
    var registry: String
}

struct EncodeJPEGOptions: Equatable {
    /// An 8-bit sRGB image (niho-develop-render's PNG), written as it is.
    var pixels: String
    /// The original (RAW / JPEG / PNG / HEIC / TIFF) whose capture time is written.
    var metadataFrom: String
    var out: String
    var quality = JPEGExport.defaultQuality
}

struct RetagJPEGOptions: Equatable {
    /// An encoded JPEG; its capture time is kept, its image is not re-encoded.
    var input: String
    /// May be `input`.
    var out: String
}

struct RasterOptions: Equatable {
    /// A HEIC / HEIF, TIFF, PNG or JPEG original.
    var input: String
    /// The working copy (8-bit JPEG).
    var out: String
    /// The preview (long edge 1024, sRGB JPEG); nil = none.
    var previewOut: String?
    /// The metadata JSON; nil = stdout only.
    var meta: String?
    /// Never enlarges; `.full` uses the decoded source's long edge.
    var longEdge: LongEdge = .pixels(RasterWorkingCopy.defaultLongEdge)
    var quality = RasterWorkingCopy.defaultQuality
}

struct RenderOptions: Equatable {
    var input: String
    var out: String
    var meta: String?
    /// The crate's `WorkingCopyMeta` JSON (one of the working-copy PNG encodings only).
    var workingCopyMeta: String?
    var decoderVersion = "8"
    var allowFallback = false
    var longEdge: LongEdge = .pixels(2560)
    var space: OutputSpace = .linearProPhoto
    var encoding: OutputEncoding = .tiff32f
    var calibration: String?
    /// `niho-develop-calibration-registry/v1`: the calibration is picked by the
    /// RAW's make / model (exclusive with `calibration`).
    var calibrationRegistry: String?
    /// `auto` = the calibration's `lens.mode`, else `apple` (see LensCorrection.swift).
    var lensCorrection: LensCorrectionMode = .auto
    var gamutMapping: GamutMappingMode = .auto
    /// `--white` (Lightroom's scale); nil = as shot. Never for a working copy.
    var white: LightroomWhite?
    var boost: Float = 0
    var nr: DefaultOrOff = .default
    var sharpen: DefaultOrOff = .default
}

enum Command: Equatable {
    case info(InfoOptions)
    case cameras(CamerasOptions)
    case registry(RegistryOptions)
    case render(RenderOptions)
    case encodeJPEG(EncodeJPEGOptions)
    case retagJPEG(RetagJPEGOptions)
    case raster(RasterOptions)
    case version
    case help
}

/// Hand-rolled parser (no ArgumentParser dependency). Options accept both
/// `--name value` and `--name=value`; `--` ends option parsing.
enum ArgumentParser {
    static let usage = """
    apple-raw-linear \(Tool.version) — Core Image RAW decode to linear ProPhoto (D50) / linear sRGB

    USAGE
      apple-raw-linear info <raw> [--json] [--decoder-version <n>]
      apple-raw-linear cameras [--out <file>]
      apple-raw-linear registry <registry.json>
      apple-raw-linear render <raw> --out <file> [--meta <file.json>]
          [--decoder-version <n>] [--allow-fallback]
          [--long-edge <px|full>]                       (default 2560)
          [--space linear-prophoto|linear-srgb]         (default linear-prophoto)
          [--encoding tiff32f|tiff16|png16-g18|png16-signed-g18]         (default tiff32f)
          [--calibration <json> | --calibration-registry <json>]
          [--working-copy-meta <file.json>]             (working-copy PNG only)
          [--lens-correction auto|apple|embedded|off]   (default auto; on = apple)
          [--gamut-mapping auto|on|off]                 (default auto)
          [--white <temperatureK>,<tint>]               (default as shot)
          [--boost <0..1>]                              (default 0 = linear)
          [--nr default|off] [--sharpen default|off]    (default default)
      apple-raw-linear encode-jpeg --pixels <srgb.png> --metadata-from <original> --out <file.jpg>
          [--quality <0..1>]                            (default 0.92)
      apple-raw-linear retag-jpeg --in <file.jpg> --out <file.jpg>
      apple-raw-linear raster <image> --out <working.jpg> [--preview-out <preview.jpg>] [--meta <file.json>]
          [--long-edge <px|full>]                       (default 2560; never enlarges)
          [--quality <0..1>]                            (default 0.94)
      apple-raw-linear version

    png16-g18 is the stage-2 working copy: linear ProPhoto (D50) before
    exposure, code = round((clip(x, 0, 2) / 2)^(1/1.8) * 65535), ROMM RGB ICC
    (a viewer shows it one stop dark; it is not for display). The calibration
    matrix is applied to the pixels; baselineEV is not (it goes to the
    --working-copy-meta JSON, the crate's WorkingCopyMeta). With
    --working-copy-meta and no --meta, the tool metadata goes to <out>.meta.json.

    png16-signed-g18 is the opt-in p3/e4 RAW recipe. It requires linear-prophoto,
    as-shot white, boost 0, explicit --nr off and --gamut-mapping off, Apple's
    default sharpening, and lens correction on. It always decodes at scale 1,
    applies lens correction and sRGB→ProPhoto at full size, downsamples with
    Lanczos4, then applies the f32 calibration matrix. Signed gamma 1.8 codes
    are centered at 32768 and are an internal representation, not for display.

    Lens correction: apple = Core Image's own (no vignetting); embedded = Core
    Image's off and the RAW's own correction data (Sony ARW distortion and
    vignetting) applied by this tool, falling back to apple when the RAW has
    none; auto = the calibration's lens.mode, else apple. A working copy
    (--working-copy-meta) always corrects the lens: off, given or from the
    calibration's lens.mode, is rejected (off is for color measurement only).

    --gamut-mapping sets Core Image's isGamutMappingEnabled; auto = the
    calibration's decoder.settings.gamutMapping when it is a bool, else on.
    --white renders at a white in Lightroom's scale (temperature 1000..100000
    K, tint -250..250): the DNG temperature model's xy, moved to Apple's scale
    by the calibration's whiteBalanceMap when there is one, is set as the
    render's neutralChromaticity. A working copy is always as shot: --white
    with --working-copy-meta is rejected.

    A calibration's whiteBalanceTable (niho-develop-wb-table/v1) is copied to
    the working-copy meta only for gamut mapping off and after a self-check on
    this RAW (two small extra renders); a failed check writes status
    "mismatch" without matrices and a warning, and never fails the render.

    --calibration-registry takes niho-develop-calibration-registry/v1 (track,
    cameras: [{make, model, file}], file relative to the registry's folder) and
    applies the one entry whose make and model match the RAW's; no entry means
    uncalibrated. Registry problems are invalid_calibration.

    registry checks a registry as the production worker needs it: every entry
    loads as a calibration for its camera and track, no camera twice, a
    camera.id, and lens.mode apple or embedded. It prints one JSON line
    ({"registry","track","cameras","entries":[{make,model,file,id,cameraId,
    version,lensMode,whiteBalanceTable}]}); problems are invalid_calibration
    (4) or unsupported_calibration_feature (3).

    encode-jpeg writes the pixels as they are (no resampling, tagged sRGB) with
    the capture time only (Epic #17114 Decision 10, like the crate's exif.rs):
    EXIF DateTimeOriginal (and OffsetTimeOriginal / SubsecTimeOriginal when
    the original has them) from --metadata-from, the pixel size, ColorSpace 1
    and Orientation 1. No GPS, camera (TIFF Make / Model / Software / ...),
    ExifAux, IPTC, XMP, maker notes or thumbnail. An original that is
    unreadable or has no capture time gives a JPEG without EXIF
    ("metadata": false = no capture time written). The file appears only
    when complete (temporary file, then rename).

    retag-jpeg puts the same metadata on an encoded JPEG without re-encoding
    it (the capture time from the JPEG itself): every metadata segment is
    dropped (JFIF, ICC and Adobe stay) and ImageIO copies the image
    (CGImageDestinationCopyImageSource). The tables and scan stay byte for
    byte. Both read the JPEG back and write nothing (write_failed) if it
    would carry anything else. --in may be --out. Not a JPEG, or an
    orientation other than 1: read_failed.

    raster writes the raster working copy (K5 #17153): the ImageIO primary
    image of a HEIC / HEIF, TIFF, PNG or JPEG (SDR, no gain map; on macOS 15
    and later an HDR primary is read as SDR), its orientation applied,
    downscaled in linear light (Core Image, Lanczos) to the long edge, as an
    8-bit JPEG. An RGB source keeps its color space and the JPEG carries the
    same ICC only when stage 2 reads that ICC: RGB with rXYZ / gXYZ / bXYZ and
    rTRC / gTRC / bTRC, no TRC nearly linear (curv with 0 points, or a gamma
    under 1.3). Every other RGB source (LUT-only or linear ICC, ITU-R 2100
    PQ / HLG, extended range, an HDR original) is converted to Display P3
    with the Display P3 ICC. sRGB and RGB without an ICC are written as sRGB
    without an ICC; gray / CMYK / Lab / indexed are converted to sRGB. The
    JPEG carries the ICC only (no EXIF, GPS, TIFF, IPTC, XMP, thumbnail) and
    the same input gives the same bytes. --preview-out writes the preview:
    long edge 1024, sRGB, no metadata, at most 1 MiB (quality 0.85, 0.72,
    0.6, 0.45 until it fits). It prints one JSON line ({"kind":"raster",
    "encoding":"jpeg8","width","height","iccSha256" (the embedded ICC's
    SHA-256, null for sRGB),"colorSpace","converted" ("displayP3" | "srgb" |
    null = the source's own color),"sourceWidth","sourceHeight" (stored,
    before orientation),"orientationApplied","bytes",
    "preview":{width,height,bytes}|null,"tool"}); --meta also writes it to a
    file. Nothing is written unless every output encodes.

    Errors are one JSON line on stdout: {"error":"<code>","message":"..."}.
    Exit codes: 0 ok, 1 invalid_arguments, 2 unsupported_camera,
    3 unsupported_decoder_version / unsupported_calibration_feature /
    unsupported_profile, 4 input_not_found / read_failed / invalid_calibration /
    write_failed / decode_failed / encode_failed.
    """

    static func parse(_ arguments: [String]) throws -> Command {
        guard let subcommand = arguments.first else { return .help }
        let rest = Array(arguments.dropFirst())
        switch subcommand {
        case "-h", "--help", "help":
            return .help
        case "-V", "--version", "version":
            return .version
        case "info":
            return try parseInfo(rest)
        case "cameras":
            return try parseCameras(rest)
        case "registry":
            return try parseRegistry(rest)
        case "render":
            return try parseRender(rest)
        case "encode-jpeg":
            return try parseEncodeJPEG(rest)
        case "retag-jpeg":
            return try parseRetagJPEG(rest)
        case "raster":
            return try parseRaster(rest)
        default:
            throw ToolError.invalidArguments("unknown subcommand '\(subcommand)' (see --help)")
        }
    }

    struct Parsed {
        var positionals: [String] = []
        var values: [String: String] = [:]
        var flags: Set<String> = []
        var help = false
    }

    static func tokenize(
        _ arguments: [String],
        valueOptions: Set<String>,
        flagOptions: Set<String>
    ) throws -> Parsed {
        var parsed = Parsed()
        var index = 0
        var optionsEnded = false
        while index < arguments.count {
            let token = arguments[index]
            index += 1
            if optionsEnded || !token.hasPrefix("-") || token == "-" {
                parsed.positionals.append(token)
                continue
            }
            if token == "--" {
                optionsEnded = true
                continue
            }
            if token == "-h" || token == "--help" {
                parsed.help = true
                continue
            }
            var name = token
            var inlineValue: String?
            if let equals = token.firstIndex(of: "=") {
                name = String(token[..<equals])
                inlineValue = String(token[token.index(after: equals)...])
            }
            if flagOptions.contains(name) {
                guard inlineValue == nil else {
                    throw ToolError.invalidArguments("\(name) does not take a value")
                }
                parsed.flags.insert(name)
            } else if valueOptions.contains(name) {
                let value: String
                if let inlineValue {
                    value = inlineValue
                } else {
                    guard index < arguments.count else {
                        throw ToolError.invalidArguments("\(name) needs a value")
                    }
                    value = arguments[index]
                    index += 1
                }
                guard parsed.values[name] == nil else {
                    throw ToolError.invalidArguments("\(name) was given more than once")
                }
                guard !value.isEmpty else {
                    throw ToolError.invalidArguments("\(name) needs a non-empty value")
                }
                parsed.values[name] = value
            } else {
                throw ToolError.invalidArguments("unknown option \(name) (see --help)")
            }
        }
        return parsed
    }

    static func parseInfo(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(arguments, valueOptions: ["--decoder-version"], flagOptions: ["--json"])
        if parsed.help { return .help }
        guard parsed.positionals.count == 1 else {
            throw ToolError.invalidArguments("info needs exactly one RAW path")
        }
        return .info(InfoOptions(
            input: parsed.positionals[0],
            json: parsed.flags.contains("--json"),
            decoderVersion: parsed.values["--decoder-version"]
        ))
    }

    static func parseCameras(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(arguments, valueOptions: ["--out"], flagOptions: [])
        if parsed.help { return .help }
        guard parsed.positionals.isEmpty else {
            throw ToolError.invalidArguments("cameras takes no positional arguments")
        }
        return .cameras(CamerasOptions(out: parsed.values["--out"]))
    }

    static func parseRegistry(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(arguments, valueOptions: [], flagOptions: [])
        if parsed.help { return .help }
        guard parsed.positionals.count == 1 else {
            throw ToolError.invalidArguments("registry needs exactly one registry JSON path")
        }
        return .registry(RegistryOptions(registry: parsed.positionals[0]))
    }

    static func parseRender(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            valueOptions: [
                "--out", "--meta", "--working-copy-meta", "--decoder-version", "--long-edge", "--space",
                "--encoding", "--calibration", "--calibration-registry", "--lens-correction", "--gamut-mapping",
                "--white", "--boost", "--nr", "--sharpen",
            ],
            flagOptions: ["--allow-fallback"]
        )
        if parsed.help { return .help }
        guard parsed.positionals.count == 1 else {
            throw ToolError.invalidArguments("render needs exactly one RAW path")
        }
        guard let out = parsed.values["--out"] else {
            throw ToolError.invalidArguments("render needs --out <file>")
        }
        var options = RenderOptions(input: parsed.positionals[0], out: out)
        options.meta = parsed.values["--meta"]
        options.workingCopyMeta = parsed.values["--working-copy-meta"]
        options.allowFallback = parsed.flags.contains("--allow-fallback")
        options.calibration = parsed.values["--calibration"]
        options.calibrationRegistry = parsed.values["--calibration-registry"]
        if options.calibration != nil, options.calibrationRegistry != nil {
            throw ToolError.invalidArguments("--calibration and --calibration-registry cannot be used together")
        }
        if let value = parsed.values["--decoder-version"] {
            options.decoderVersion = value
        }
        if let value = parsed.values["--long-edge"] {
            options.longEdge = try parseLongEdge(value)
        }
        if let value = parsed.values["--space"] {
            options.space = try parseEnum(value, option: "--space")
        }
        if let value = parsed.values["--encoding"] {
            options.encoding = try parseEnum(value, option: "--encoding")
        }
        if let value = parsed.values["--lens-correction"] {
            guard let mode = LensCorrectionMode.parse(value) else {
                let allowed = LensCorrectionMode.allCases.map(\.rawValue).joined(separator: "|")
                throw ToolError.invalidArguments("--lens-correction must be one of \(allowed) or on (got '\(value)')")
            }
            options.lensCorrection = mode
        }
        if let value = parsed.values["--gamut-mapping"] {
            options.gamutMapping = try parseEnum(value, option: "--gamut-mapping")
        }
        if let value = parsed.values["--white"] {
            options.white = try parseWhite(value)
        }
        if let value = parsed.values["--nr"] {
            options.nr = try parseEnum(value, option: "--nr")
        }
        if let value = parsed.values["--sharpen"] {
            options.sharpen = try parseEnum(value, option: "--sharpen")
        }
        if let value = parsed.values["--boost"] {
            guard let boost = Float(value), boost.isFinite, (0 ... 1).contains(boost) else {
                throw ToolError.invalidArguments("--boost must be a number in 0...1 (got '\(value)')")
            }
            options.boost = boost
        }
        if options.encoding.isWorkingCopy, options.space != .linearProPhoto {
            throw ToolError.invalidArguments(
                "--encoding \(options.encoding.rawValue) is defined only for --space linear-prophoto (ROMM RGB)"
            )
        }
        if options.encoding.isSignedWorkingCopy {
            guard options.white == nil else {
                throw ToolError.invalidArguments("--encoding png16-signed-g18 requires the as-shot white; --white is not allowed")
            }
            guard options.boost == 0 else {
                throw ToolError.invalidArguments("--encoding png16-signed-g18 requires --boost 0")
            }
            guard options.nr == .off, parsed.values["--nr"] != nil else {
                throw ToolError.invalidArguments("--encoding png16-signed-g18 requires explicit --nr off")
            }
            guard options.gamutMapping == .off, parsed.values["--gamut-mapping"] != nil else {
                throw ToolError.invalidArguments("--encoding png16-signed-g18 requires explicit --gamut-mapping off")
            }
            guard options.sharpen == .default else {
                throw ToolError.invalidArguments("--encoding png16-signed-g18 keeps Apple's default sharpening")
            }
            try RenderCommand.requireLensCorrectionForWorkingCopy(options.lensCorrection)
        }
        if options.workingCopyMeta != nil {
            guard options.encoding.isWorkingCopy else {
                throw ToolError.invalidArguments(
                    "--working-copy-meta describes a working copy and needs a working-copy PNG encoding"
                )
            }
            guard options.boost == 0 else {
                throw ToolError.invalidArguments(
                    "--working-copy-meta needs a linear render (--boost 0); the working copy is linear ProPhoto"
                )
            }
            try RenderCommand.requireLensCorrectionForWorkingCopy(options.lensCorrection)
            try RenderCommand.requireAsShotWhiteForWorkingCopy(options.white)
        }
        return .render(options)
    }

    static func parseEncodeJPEG(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            valueOptions: ["--pixels", "--metadata-from", "--out", "--quality"],
            flagOptions: []
        )
        if parsed.help { return .help }
        guard parsed.positionals.isEmpty else {
            throw ToolError.invalidArguments("encode-jpeg takes no positional arguments")
        }
        guard let pixels = parsed.values["--pixels"] else {
            throw ToolError.invalidArguments("encode-jpeg needs --pixels <srgb.png>")
        }
        guard let metadataFrom = parsed.values["--metadata-from"] else {
            throw ToolError.invalidArguments("encode-jpeg needs --metadata-from <original>")
        }
        guard let out = parsed.values["--out"] else {
            throw ToolError.invalidArguments("encode-jpeg needs --out <file.jpg>")
        }
        var options = EncodeJPEGOptions(pixels: pixels, metadataFrom: metadataFrom, out: out)
        if let value = parsed.values["--quality"] {
            options.quality = try parseQuality(value)
        }
        return .encodeJPEG(options)
    }

    static func parseRetagJPEG(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(arguments, valueOptions: ["--in", "--out"], flagOptions: [])
        if parsed.help { return .help }
        guard parsed.positionals.isEmpty else {
            throw ToolError.invalidArguments("retag-jpeg takes no positional arguments")
        }
        guard let input = parsed.values["--in"] else {
            throw ToolError.invalidArguments("retag-jpeg needs --in <file.jpg>")
        }
        guard let out = parsed.values["--out"] else {
            throw ToolError.invalidArguments("retag-jpeg needs --out <file.jpg>")
        }
        return .retagJPEG(RetagJPEGOptions(input: input, out: out))
    }

    /// `--white` accepts whites a little outside developSettings' (2000..50000
    /// K, tint ±150): `calibrate/fit_wb_table.py` passes grid nodes moved to
    /// Apple's scale, which can land at ~1900 K or tint ±160.
    static let whiteTemperatureRange: ClosedRange<Double> = 1000 ... 100_000
    static let whiteTintRange: ClosedRange<Double> = -250 ... 250

    /// `<temperatureK>,<tint>` (Lightroom's scale), e.g. `5001,10`, `3200,-15.5`.
    static func parseWhite(_ value: String) throws -> LightroomWhite {
        let parts = value.split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2,
              let temperature = Double(parts[0]), let tint = Double(parts[1]),
              temperature.isFinite, tint.isFinite,
              whiteTemperatureRange.contains(temperature), whiteTintRange.contains(tint)
        else {
            throw ToolError.invalidArguments(
                "--white must be <temperatureK>,<tint> with temperature in \(Int(whiteTemperatureRange.lowerBound))...\(Int(whiteTemperatureRange.upperBound)) K and tint in \(Int(whiteTintRange.lowerBound))...\(Int(whiteTintRange.upperBound)) (got '\(value)')"
            )
        }
        return LightroomWhite(temperature: temperature, tint: tint)
    }

    static func parseRaster(_ arguments: [String]) throws -> Command {
        let parsed = try tokenize(
            arguments,
            valueOptions: ["--out", "--preview-out", "--meta", "--long-edge", "--quality"],
            flagOptions: []
        )
        if parsed.help { return .help }
        guard parsed.positionals.count == 1 else {
            throw ToolError.invalidArguments("raster needs exactly one image path")
        }
        guard let out = parsed.values["--out"] else {
            throw ToolError.invalidArguments("raster needs --out <working.jpg>")
        }
        var options = RasterOptions(input: parsed.positionals[0], out: out)
        options.previewOut = parsed.values["--preview-out"]
        options.meta = parsed.values["--meta"]
        if let value = parsed.values["--long-edge"] {
            options.longEdge = try parseLongEdge(value)
        }
        if let value = parsed.values["--quality"] {
            options.quality = try parseQuality(value)
        }
        return .raster(options)
    }

    static func parseQuality(_ value: String) throws -> Double {
        guard let quality = Double(value), quality.isFinite, (0 ... 1).contains(quality) else {
            throw ToolError.invalidArguments("--quality must be a number in 0...1 (got '\(value)')")
        }
        return quality
    }

    static func parseLongEdge(_ value: String) throws -> LongEdge {
        if value == "full" { return .full }
        guard let pixels = Int(value), pixels > 0 else {
            throw ToolError.invalidArguments("--long-edge must be a positive integer or 'full' (got '\(value)')")
        }
        return .pixels(pixels)
    }

    static func parseEnum<T: RawRepresentable & CaseIterable>(
        _ value: String,
        option: String
    ) throws -> T where T.RawValue == String {
        guard let parsed = T(rawValue: value) else {
            let allowed = T.allCases.map(\.rawValue).joined(separator: "|")
            throw ToolError.invalidArguments("\(option) must be one of \(allowed) (got '\(value)')")
        }
        return parsed
    }
}
