import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// Serializes Vision foreground inference. The observation and request stay
/// actor-isolated; only immutable PNG masks leave the actor.
public actor CutoutDetector {
    private let context = CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any,
        .outputColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any,
        .cacheIntermediates: false
    ])

    public init() {}

    public func detect(url: URL) throws -> CutoutDetectionResult {
        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw CutoutError.unreadableInput(url)
        }
        return try detect(data: data, sourceURL: url)
    }

    /// Detects from an immutable input snapshot so callers can compose the
    /// result from the exact same bytes even if the source path changes later.
    public func detect(data: Data, sourceURL: URL) throws -> CutoutDetectionResult {
        try Task.checkCancellation()
        let hash = CutoutHash.sha256(data)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw CutoutError.unreadableInput(sourceURL) }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let rawOrientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
        let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
        let normalized = try normalizedImage(sourceImage, orientation: orientation)
        return try detect(cgImage: normalized, inputSHA256: hash)
    }

    /// The image must already have EXIF orientation applied. Its output
    /// coordinate system is therefore orientation 1 and matches app previews.
    public func detect(cgImage: CGImage, inputSHA256: String) throws -> CutoutDetectionResult {
        try Task.checkCancellation()
        let request = VNGenerateForegroundInstanceMaskRequest()
        request.revision = CutoutMaskReference.engineRevision
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
        try handler.perform([request])
        try Task.checkCancellation()
        guard let observation = request.results?.first,
              !observation.allInstances.isEmpty
        else { throw CutoutError.noForegroundSubjects }

        let counts = try instancePixelCounts(observation.instanceMask)
        let orderedIDs = observation.allInstances.sorted()
        guard let largestID = orderedIDs.max(by: { counts[$0, default: 0] < counts[$1, default: 0] }) else {
            throw CutoutError.noForegroundSubjects
        }

        var masks: [DetectedCutoutMask] = []
        for id in orderedIDs {
            try Task.checkCancellation()
            let buffer = try observation.generateScaledMaskForImage(
                forInstances: IndexSet(integer: id),
                from: handler
            )
            let pngData = try MaskRaster(pixelBuffer: buffer).pngData()
            masks.append(DetectedCutoutMask(
                selection: .instance(id),
                pixelCount: counts[id, default: 0],
                pngData: pngData
            ))
        }
        try Task.checkCancellation()
        // Vision need not synthesize a separate `all` mask for a single
        // instance. Reusing its immutable bytes also keeps CLI --subject all
        // reliable for the common one-person case.
        let allPNGData: Data
        if orderedIDs.count == 1, let onlyMask = masks.first?.pngData {
            allPNGData = onlyMask
        } else {
            let allBuffer = try observation.generateScaledMaskForImage(
                forInstances: observation.allInstances,
                from: handler
            )
            allPNGData = try MaskRaster(pixelBuffer: allBuffer).pngData()
        }
        masks.append(DetectedCutoutMask(
            selection: .all,
            pixelCount: counts.values.reduce(0, +),
            pngData: allPNGData
        ))
        return CutoutDetectionResult(
            width: cgImage.width,
            height: cgImage.height,
            inputSHA256: inputSHA256,
            masks: masks,
            largestSelection: .instance(largestID)
        )
    }

    public func detect(ciImage: CIImage, inputSHA256: String) throws -> CutoutDetectionResult {
        let extent = ciImage.extent.integral
        guard extent.width > 0, extent.height > 0,
              let cgImage = context.createCGImage(
                ciImage.transformed(by: CGAffineTransform(
                    translationX: -extent.minX,
                    y: -extent.minY
                )),
                from: CGRect(origin: .zero, size: extent.size),
                format: .RGBA8,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
              )
        else { throw CutoutError.invalidImageDimensions }
        return try detect(cgImage: cgImage, inputSHA256: inputSHA256)
    }

    private func normalizedImage(
        _ source: CGImage,
        orientation: CGImagePropertyOrientation
    ) throws -> CGImage {
        let image = CIImage(cgImage: source).oriented(orientation)
        let extent = image.extent.integral
        guard extent.width > 0, extent.height > 0,
              let result = context.createCGImage(
                image.transformed(by: CGAffineTransform(
                    translationX: -extent.minX,
                    y: -extent.minY
                )),
                from: CGRect(origin: .zero, size: extent.size),
                format: .RGBA8,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
              )
        else { throw CutoutError.invalidImageDimensions }
        return result
    }

    private func instancePixelCounts(_ buffer: CVPixelBuffer) throws -> [Int: Int] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8,
              let base = CVPixelBufferGetBaseAddress(buffer)
        else { throw CutoutError.unsupportedMaskFormat }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        var counts: [Int: Int] = [:]
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width where row[x] != 0 {
                counts[Int(row[x]), default: 0] += 1
            }
        }
        return counts
    }

}
