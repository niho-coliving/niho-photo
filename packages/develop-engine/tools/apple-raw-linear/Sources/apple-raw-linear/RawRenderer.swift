import CoreImage
import Foundation
import ImageIO

/// The as-shot white point Core Image reports for a RAW. Read only from a
/// separate "info" `CIRAWFilter` that is never rendered, so the render
/// instance's neutral properties are neither read nor written (the same
/// purity as Photo Bench's As Shot path) unless `--white` asks for another
/// white.
struct NeutralReading {
    let temperatureK: Double
    let tint: Double
    let x: Double
    let y: Double
    let decoderVersion: String

    var json: [String: Any] {
        [
            "temperatureK": JSONOutput.number(temperatureK),
            "tint": JSONOutput.number(tint),
            "x": JSONOutput.number(x),
            "y": JSONOutput.number(y),
            "decoderVersion": decoderVersion,
            "source": "separate CIRAWFilter instance (never rendered)",
        ]
    }
}

/// Facts and Apple defaults read from an info instance.
struct RawInspection {
    let supportedDecoderVersions: [String]
    let defaultDecoderVersion: String
    /// The decoder version active while the values below were read.
    let decoderVersion: String
    let nativeWidth: Int
    let nativeHeight: Int
    let orientation: UInt32
    /// nil when Core Image reports a non-finite or out-of-range white point.
    let neutral: NeutralReading?
    let appleDefaults: [String: Any]
}

enum RawInspector {
    /// A filter for a file Core Image can decode as RAW. `CIRAWFilter` also
    /// opens non-RAW files (JPEG, even JSON) with `supportedDecoderVersions ==
    /// ["None"]`; those are reported as `unsupported_camera` too.
    static func makeFilter(url: URL) throws -> CIRAWFilter {
        guard let filter = CIRAWFilter(imageURL: url) else {
            throw ToolError.unsupportedCamera(
                "Core Image cannot open \(url.lastPathComponent) as RAW (CIRAWFilter(imageURL:) returned nil)"
            )
        }
        let versions = filter.supportedDecoderVersions.map(\.rawValue)
        let rawDecoders = versions.filter { !$0.isEmpty && $0 != CIRAWDecoderVersion.none.rawValue }
        guard !rawDecoders.isEmpty else {
            throw ToolError.unsupportedCamera(
                "Core Image has no RAW decoder for \(url.lastPathComponent) (supportedDecoderVersions: [\(versions.joined(separator: ", "))])"
            )
        }
        return filter
    }

    /// Opens a fresh filter, optionally selects `decoderVersion`, and reads
    /// decoder facts, Apple defaults and the as-shot neutral. The filter is
    /// discarded without ever producing pixels.
    static func inspect(url: URL, decoderVersion: String?) throws -> RawInspection {
        let filter = try makeFilter(url: url)
        let supported = filter.supportedDecoderVersions.map(\.rawValue)
        let defaultVersion = filter.decoderVersion.rawValue
        if let decoderVersion {
            guard supported.contains(decoderVersion) else {
                throw ToolError.unsupportedDecoderVersion(
                    "decoderVersion \(decoderVersion) is not supported for \(url.lastPathComponent) (supported: \(supported.joined(separator: ", ")))"
                )
            }
            filter.decoderVersion = CIRAWDecoderVersion(rawValue: decoderVersion)
        }
        let activeVersion = filter.decoderVersion.rawValue
        guard let nativeWidth = pixelDimension(filter.nativeSize.width),
              let nativeHeight = pixelDimension(filter.nativeSize.height)
        else {
            throw ToolError.unsupportedCamera("Core Image reports an invalid native size for \(url.lastPathComponent)")
        }
        let appleDefaults = properties(of: filter)
        let neutral = readNeutral(filter, decoderVersion: activeVersion)
        return RawInspection(
            supportedDecoderVersions: supported,
            defaultDecoderVersion: defaultVersion,
            decoderVersion: activeVersion,
            nativeWidth: nativeWidth,
            nativeHeight: nativeHeight,
            orientation: filter.orientation.rawValue,
            neutral: neutral,
            appleDefaults: appleDefaults
        )
    }

    /// Only ever called on the info instance.
    private static func readNeutral(_ filter: CIRAWFilter, decoderVersion: String) -> NeutralReading? {
        let temperature = Double(filter.neutralTemperature)
        let tint = Double(filter.neutralTint)
        let xy = filter.neutralChromaticity
        guard temperature.isFinite, temperature > 0,
              tint.isFinite,
              xy.x.isFinite, xy.y.isFinite,
              xy.x > 0, xy.y > 0, xy.x + xy.y <= 1
        else { return nil }
        return NeutralReading(
            temperatureK: Double(Float(temperature).description) ?? temperature,
            tint: tint == 0 ? 0 : (Double(Float(tint).description) ?? tint),
            x: Double(xy.x),
            y: Double(xy.y),
            decoderVersion: decoderVersion
        )
    }

    /// Every decode-relevant property **except the neutral ones**. Used for
    /// Apple's defaults (info instance) and for the effective values read back
    /// from the render instance after rendering.
    static func properties(of filter: CIRAWFilter) -> [String: Any] {
        var values: [String: Any] = [
            "decoderVersion": filter.decoderVersion.rawValue,
            "scaleFactor": JSONOutput.number(filter.scaleFactor),
            "isDraftModeEnabled": filter.isDraftModeEnabled,
            "exposure": JSONOutput.number(filter.exposure),
            "baselineExposure": JSONOutput.number(filter.baselineExposure),
            "shadowBias": JSONOutput.number(filter.shadowBias),
            "boostAmount": JSONOutput.number(filter.boostAmount),
            "boostShadowAmount": JSONOutput.number(filter.boostShadowAmount),
            "extendedDynamicRangeAmount": JSONOutput.number(filter.extendedDynamicRangeAmount),
            "isGamutMappingEnabled": filter.isGamutMappingEnabled,
            "isLensCorrectionSupported": filter.isLensCorrectionSupported,
            "isLensCorrectionEnabled": filter.isLensCorrectionEnabled,
            "isLuminanceNoiseReductionSupported": filter.isLuminanceNoiseReductionSupported,
            "luminanceNoiseReductionAmount": JSONOutput.number(filter.luminanceNoiseReductionAmount),
            "isColorNoiseReductionSupported": filter.isColorNoiseReductionSupported,
            "colorNoiseReductionAmount": JSONOutput.number(filter.colorNoiseReductionAmount),
            "isSharpnessSupported": filter.isSharpnessSupported,
            "sharpnessAmount": JSONOutput.number(filter.sharpnessAmount),
            "isContrastSupported": filter.isContrastSupported,
            "contrastAmount": JSONOutput.number(filter.contrastAmount),
            "isDetailSupported": filter.isDetailSupported,
            "detailAmount": JSONOutput.number(filter.detailAmount),
            "isMoireReductionSupported": filter.isMoireReductionSupported,
            "moireReductionAmount": JSONOutput.number(filter.moireReductionAmount),
            "isLocalToneMapSupported": filter.isLocalToneMapSupported,
            "localToneMapAmount": JSONOutput.number(filter.localToneMapAmount),
            "orientation": filter.orientation.rawValue,
        ]
        if #available(macOS 26.0, *) {
            values["isHighlightRecoverySupported"] = filter.isHighlightRecoverySupported
            values["isHighlightRecoveryEnabled"] = filter.isHighlightRecoveryEnabled
        } else {
            values["isHighlightRecoverySupported"] = NSNull()
            values["isHighlightRecoveryEnabled"] = NSNull()
        }
        return values
    }

    /// The neutral properties, read back from a render instance after
    /// rendering, only when `--white` assigned them (so a measurement can
    /// verify the white took effect).
    static func neutralProperties(of filter: CIRAWFilter) -> [String: Any] {
        let xy = filter.neutralChromaticity
        return [
            "neutralChromaticity": ["x": JSONOutput.number(xy.x), "y": JSONOutput.number(xy.y)],
            "neutralTemperature": JSONOutput.number(filter.neutralTemperature),
            "neutralTint": JSONOutput.number(filter.neutralTint),
        ]
    }

    /// Rejects NaN, infinity, zero, negative and out-of-range framework values
    /// before they reach an `Int` conversion.
    static func pixelDimension(_ value: CGFloat) -> Int? {
        guard value.isFinite else { return nil }
        let rounded = value.rounded()
        guard let dimension = Int(exactly: rounded), dimension > 0 else { return nil }
        return dimension
    }
}

/// The properties `render` assigns to the render instance, in this order,
/// after `decoderVersion` and before the first `outputImage` access.
/// `shadowBias`, `exposure`, `boostShadowAmount`, EDR, gamut mapping, draft
/// mode, local tone map and contrast are always pinned so the output never
/// silently follows an OS default (Photo Bench `calibrationBaseline`).
/// The neutral is assigned only for `--white`; otherwise the as-shot white
/// is never touched.
struct AssignedSettings {
    let decoderVersion: String
    let exposure: Float = 0
    let shadowBias: Float = 0
    let boostAmount: Float
    let boostShadowAmount: Float = 1
    let extendedDynamicRangeAmount: Float = 0
    /// `--gamut-mapping` resolved (on for 0.4.0 and every calibration that
    /// says `gamutMapping: true`; a white-balance table needs it off).
    let isGamutMappingEnabled: Bool
    let isDraftModeEnabled = false
    let localToneMapAmount: Float = 0
    let contrastAmount: Float = 0
    /// Core Image's own correction: only for the `apple` lens mode.
    let isLensCorrectionEnabled: Bool
    /// Whether the working copy is lens-corrected at all (apple or embedded);
    /// what the calibration's `decoder.settings.lensCorrection` is compared with.
    let lensCorrectionApplied: Bool
    /// nil = left at Apple's (ISO-dependent) default.
    let luminanceNoiseReductionAmount: Float?
    let colorNoiseReductionAmount: Float?
    let sharpnessAmount: Float?
    /// Apple-scale xy of the white to render at; nil = as shot (untouched).
    let neutralChromaticity: CGPoint?
    let scaleFactor: Float
    let nr: DefaultOrOff
    let sharpen: DefaultOrOff

    /// `lensMode` = the resolved mode (never `auto`); nil = derive it from
    /// the options with `auto` meaning `apple`. `gamutMapping` = the resolved
    /// flag; nil = derive it from the options with `auto` meaning on.
    init(
        decoderVersion: String,
        options: RenderOptions,
        scaleFactor: Float,
        lensMode: LensCorrectionMode? = nil,
        gamutMapping: Bool? = nil,
        neutralChromaticity: CGPoint? = nil
    ) {
        self.decoderVersion = decoderVersion
        boostAmount = options.boost
        let mode = lensMode ?? (options.lensCorrection == .auto ? .apple : options.lensCorrection)
        isLensCorrectionEnabled = mode == .apple || mode == .auto
        lensCorrectionApplied = mode != .off
        isGamutMappingEnabled = gamutMapping ?? (options.gamutMapping != .off)
        nr = options.nr
        sharpen = options.sharpen
        luminanceNoiseReductionAmount = options.nr == .off ? 0 : nil
        colorNoiseReductionAmount = options.nr == .off ? 0 : nil
        sharpnessAmount = options.sharpen == .off ? 0 : nil
        self.neutralChromaticity = neutralChromaticity
        self.scaleFactor = scaleFactor
    }

    /// Assignment order recorded in the metadata (`decoderVersion` was set
    /// when the version was resolved, before `nativeSize` was read).
    var assignmentOrder: [String] {
        var order = [
            "decoderVersion", "exposure", "shadowBias", "boostAmount", "boostShadowAmount",
            "extendedDynamicRangeAmount", "isGamutMappingEnabled", "isDraftModeEnabled",
            "localToneMapAmount", "contrastAmount", "isLensCorrectionEnabled",
        ]
        if luminanceNoiseReductionAmount != nil { order.append("luminanceNoiseReductionAmount") }
        if colorNoiseReductionAmount != nil { order.append("colorNoiseReductionAmount") }
        if sharpnessAmount != nil { order.append("sharpnessAmount") }
        if neutralChromaticity != nil { order.append("neutralChromaticity") }
        order.append("scaleFactor")
        return order
    }

    func apply(to filter: CIRAWFilter) {
        filter.exposure = exposure
        filter.shadowBias = shadowBias
        filter.boostAmount = boostAmount
        filter.boostShadowAmount = boostShadowAmount
        filter.extendedDynamicRangeAmount = extendedDynamicRangeAmount
        filter.isGamutMappingEnabled = isGamutMappingEnabled
        filter.isDraftModeEnabled = isDraftModeEnabled
        filter.localToneMapAmount = localToneMapAmount
        filter.contrastAmount = contrastAmount
        filter.isLensCorrectionEnabled = isLensCorrectionEnabled
        if let luminanceNoiseReductionAmount {
            filter.luminanceNoiseReductionAmount = luminanceNoiseReductionAmount
        }
        if let colorNoiseReductionAmount {
            filter.colorNoiseReductionAmount = colorNoiseReductionAmount
        }
        if let sharpnessAmount {
            filter.sharpnessAmount = sharpnessAmount
        }
        // After decoderVersion (a version change may reset the neutral) and
        // the other settings; Core Image derives neutralTemperature / Tint.
        if let neutralChromaticity {
            filter.neutralChromaticity = neutralChromaticity
        }
        // Must precede the first `outputImage` access: Apple documents
        // scaleFactor as a decode-time control, not a post-decode resize.
        filter.scaleFactor = scaleFactor
    }

    var json: [String: Any] {
        var values: [String: Any] = [
            "decoderVersion": decoderVersion,
            "exposure": JSONOutput.number(exposure),
            "shadowBias": JSONOutput.number(shadowBias),
            "boostAmount": JSONOutput.number(boostAmount),
            "boostShadowAmount": JSONOutput.number(boostShadowAmount),
            "extendedDynamicRangeAmount": JSONOutput.number(extendedDynamicRangeAmount),
            "isGamutMappingEnabled": isGamutMappingEnabled,
            "isDraftModeEnabled": isDraftModeEnabled,
            "localToneMapAmount": JSONOutput.number(localToneMapAmount),
            "contrastAmount": JSONOutput.number(contrastAmount),
            "isLensCorrectionEnabled": isLensCorrectionEnabled,
            "scaleFactor": JSONOutput.number(scaleFactor),
        ]
        if let luminanceNoiseReductionAmount {
            values["luminanceNoiseReductionAmount"] = JSONOutput.number(luminanceNoiseReductionAmount)
        }
        if let colorNoiseReductionAmount {
            values["colorNoiseReductionAmount"] = JSONOutput.number(colorNoiseReductionAmount)
        }
        if let sharpnessAmount {
            values["sharpnessAmount"] = JSONOutput.number(sharpnessAmount)
        }
        if let neutralChromaticity {
            values["neutralChromaticity"] = [
                "x": JSONOutput.number(neutralChromaticity.x),
                "y": JSONOutput.number(neutralChromaticity.y),
            ]
        }
        return values
    }

    /// The same settings in the calibration JSON's `decoder.settings` vocabulary.
    var calibrationComparable: [String: JSONValue] {
        [
            "boostAmount": .number(Double(boostAmount)),
            "boostShadowAmount": .number(Double(boostShadowAmount)),
            "exposure": .number(Double(exposure)),
            "shadowBias": .number(Double(shadowBias)),
            "extendedDynamicRangeAmount": .number(Double(extendedDynamicRangeAmount)),
            "gamutMapping": .bool(isGamutMappingEnabled),
            "lensCorrection": .bool(lensCorrectionApplied),
            "localToneMapAmount": .number(Double(localToneMapAmount)),
            "contrastAmount": .number(Double(contrastAmount)),
            "draftMode": .bool(isDraftModeEnabled),
            "nr": .string(nr.rawValue),
            "sharpen": .string(sharpen.rawValue),
        ]
    }
}

/// Renders a configured `CIRAWFilter` output into CPU memory as RGBA float in
/// extended linear sRGB (Core Image's working space, no clipping).
final class RawRenderer {
    static let workingColorSpace: CGColorSpace = {
        guard let space = CGColorSpace(name: CGColorSpace.extendedLinearSRGB) else {
            preconditionFailure("extendedLinearSRGB is unavailable")
        }
        return space
    }()

    let context: CIContext

    init() {
        context = CIContext(options: [
            .workingColorSpace: Self.workingColorSpace,
            .workingFormat: NSNumber(value: CIFormat.RGBAf.rawValue),
            .cacheIntermediates: false,
            .name: "apple-raw-linear",
        ])
    }

    struct Rendered {
        /// `width * height * 4` floats, row 0 = top. Owned by the caller.
        let pixels: UnsafeMutablePointer<Float>
        let width: Int
        let height: Int
        let extent: CGRect
        let bounds: CGRect
    }

    /// `min(1, longEdge / max(nativeW, nativeH))`; `full` = 1.
    static func scaleFactor(longEdge: LongEdge, nativeWidth: Int, nativeHeight: Int) -> Float {
        switch longEdge {
        case .full:
            return 1
        case let .pixels(pixels):
            let nativeLong = Double(max(nativeWidth, nativeHeight))
            return Float(min(1, Double(pixels) / nativeLong))
        }
    }

    /// Pixel bounds for a decoder extent: whole pixels only. A fractional edge
    /// (which would be a partially covered, darkened row/column) is dropped.
    static func pixelBounds(for extent: CGRect) -> CGRect? {
        guard !extent.isNull, !extent.isInfinite,
              extent.minX.isFinite, extent.minY.isFinite,
              extent.width.isFinite, extent.height.isFinite
        else { return nil }
        let minX = extent.minX.rounded(.up)
        let minY = extent.minY.rounded(.up)
        let maxX = extent.maxX.rounded(.down)
        let maxY = extent.maxY.rounded(.down)
        guard maxX > minX, maxY > minY else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    func render(image: CIImage) throws -> Rendered {
        let extent = image.extent
        guard let bounds = Self.pixelBounds(for: extent),
              let width = RawInspector.pixelDimension(bounds.width),
              let height = RawInspector.pixelDimension(bounds.height)
        else {
            throw ToolError.unsupportedCamera("Core Image returned an image without a finite pixel extent (\(extent))")
        }
        let count = width * height * 4
        let pixels = UnsafeMutablePointer<Float>.allocate(capacity: count)
        pixels.initialize(repeating: 0, count: count)
        context.render(
            image,
            toBitmap: pixels,
            rowBytes: width * 4 * MemoryLayout<Float>.size,
            bounds: bounds,
            format: .RGBAf,
            colorSpace: Self.workingColorSpace
        )
        return Rendered(pixels: pixels, width: width, height: height, extent: extent, bounds: bounds)
    }
}
