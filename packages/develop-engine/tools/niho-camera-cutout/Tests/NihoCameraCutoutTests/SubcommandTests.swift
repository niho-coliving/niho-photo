import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import NihoCameraCutout
@testable import NihoCameraCutoutCLI
import Testing
import UniformTypeIdentifiers

struct SubcommandTests {
    @Test func parsesDetectAndCompose() throws {
        #expect(try Command.parse(["detect", "--input", "a.jpg", "--masks-dir", "m"])
            == .detect(try DetectOptions(arguments: ["--input", "a.jpg", "--masks-dir", "m"])))
        let command = try Command.parse([
            "compose", "--input", "a.png", "--mask", "m.png", "--output", "o.png",
            "--mask-sha256", String(repeating: "a", count: 64), "--background", "#102030",
            "--strokes", "s.json", "--jpeg-quality", "0.8",
        ])
        guard case let .compose(options) = command else {
            Issue.record("\(command)")
            return
        }
        #expect(options.input.lastPathComponent == "a.png")
        #expect(options.mask.lastPathComponent == "m.png")
        #expect(options.maskSHA256 == String(repeating: "a", count: 64))
        #expect(options.background == .color(CutoutRGBA(red: 0x10 / 255, green: 0x20 / 255, blue: 0x30 / 255)))
        #expect(options.strokes?.lastPathComponent == "s.json")
        #expect(options.jpegQuality == 0.8)
        let defaults = try ComposeOptions(arguments: ["--input", "a", "--mask", "m", "--output", "o.png"])
        #expect(defaults.background == .transparent && defaults.strokes == nil && defaults.maskSHA256 == nil)
        #expect(defaults.jpegQuality == 0.92)
    }

    @Test func subcommandArgumentsAreStrict() {
        #expect(throws: CLIError.missingOption("--masks-dir")) { try Command.parse(["detect", "--input", "a"]) }
        #expect(throws: CLIError.missingOption("--output")) {
            try Command.parse(["compose", "--input", "a", "--mask", "m"])
        }
        #expect(throws: CLIError.repeatedOption("--input")) {
            try Command.parse(["detect", "--input", "a", "--input", "b", "--masks-dir", "m"])
        }
        #expect(throws: CLIError.missingValue("--masks-dir")) { try Command.parse(["detect", "--input", "a", "--masks-dir"]) }
        // The one-shot form's --subject is not a compose option.
        #expect(throws: CLIError.unknownOption("--subject")) {
            try Command.parse(["compose", "--input", "a", "--mask", "m", "--output", "o", "--subject", "all"])
        }
        #expect(throws: CLIError.invalidDigest("ABC")) {
            try Command.parse(["compose", "--input", "a", "--mask", "m", "--output", "o", "--mask-sha256", "ABC"])
        }
    }

    @Test func detectOrientationUsesTheSameInputSnapshot() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("input.png")
        try writeRGB(input, width: 3, height: 2)
        let source = try #require(CGImageSourceCreateWithURL(input as CFURL, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let jpeg = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            jpeg, UTType.jpeg.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let snapshot = jpeg as Data
        // The path now points at another frame; the metadata must still come from the bytes used by detect.
        try writeRGB(input, width: 2, height: 3)
        #expect(try DetectCommand.sourceOrientation(snapshot, sourceURL: input) == 6)
    }

    @Test func composeAppliesTheMaskStrokesAndBackground() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("developed.png")
        try writeRGB(input, width: 4, height: 2)
        let mask = root.appendingPathComponent("mask.png")
        let maskData = try MaskRaster(width: 4, height: 2, pixels: Data(repeating: 255, count: 8)).pngData()
        try maskData.write(to: mask)
        let strokes = root.appendingPathComponent("strokes.json")
        // Erase the top-left pixel only.
        try Data(#"[{"mode":"erase","radius":0.25,"points":[{"x":0,"y":0}]}]"#.utf8).write(to: strokes)
        let output = root.appendingPathComponent("cutout.png")

        let summary = try ComposeCommand.run(try ComposeOptions(arguments: [
            "--input", input.path, "--mask", mask.path, "--mask-sha256", CutoutHash.sha256(maskData),
            "--strokes", strokes.path, "--output", output.path,
        ]))
        #expect(summary["width"] as? Int == 4 && summary["height"] as? Int == 2)
        #expect(summary["format"] as? String == "png" && summary["strokes"] as? Int == 1)
        let alpha = try alphaChannel(output)
        #expect(alpha[0] == 0)
        #expect(alpha[3] == 255 && alpha[7] == 255)

        let white = root.appendingPathComponent("white.jpg")
        let flattened = try ComposeCommand.run(try ComposeOptions(arguments: [
            "--input", input.path, "--mask", mask.path, "--output", white.path, "--background", "white",
        ]))
        #expect(flattened["format"] as? String == "jpeg")
    }

    /// Photo Bench trapped here: a dab further outside than its radius made
    /// `minY...maxY` an empty, invalid range.
    @Test func strokesPastTheEdgeDoNotCrashAndPaintOnlyInside() throws {
        let original = try MaskRaster(width: 10, height: 10, pixels: Data(repeating: 255, count: 100))
        let painted = original.applying([CutoutBrushStroke(
            mode: .erase,
            radius: 0.2,
            points: [CutoutPoint(x: -0.8, y: 0.5), CutoutPoint(x: 0.0, y: 0.5)]
        )])
        // A 2px brush dragged in from the left: the edge is erased, x = 3 is not.
        #expect(painted.pixels[5 * 10 + 0] == 0)
        #expect(painted.pixels[5 * 10 + 3] == 255)
        let far = original.applying([CutoutBrushStroke(mode: .erase, radius: 0.05, points: [CutoutPoint(x: 1.9, y: -0.9)])])
        #expect(far == original)
    }

    @Test func composeRefusesAMaskOfAnotherFrame() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("cropped.png")
        try writeRGB(input, width: 4, height: 4)
        let mask = root.appendingPathComponent("mask.png")
        try MaskRaster(width: 4, height: 2, pixels: Data(repeating: 255, count: 8)).pngData().write(to: mask)
        let output = root.appendingPathComponent("o.png")
        let options = try ComposeOptions(arguments: ["--input", input.path, "--mask", mask.path, "--output", output.path])
        #expect(throws: ToolFailure.self) { try ComposeCommand.run(options) }
        do {
            _ = try ComposeCommand.run(options)
        } catch {
            let failure = ToolFailure.from(error)
            #expect(failure.code == "mask_mismatch" && failure.exitCode == 3)
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }

    @Test func failuresMapToCodesAndExitCodes() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("in.png")
        try writeRGB(input, width: 2, height: 2)
        let mask = root.appendingPathComponent("mask.png")
        try MaskRaster(width: 2, height: 2, pixels: Data(repeating: 255, count: 4)).pngData().write(to: mask)
        func failure(_ arguments: [String]) -> ToolFailure? {
            do {
                _ = try ComposeCommand.run(try ComposeOptions(arguments: arguments))
                return nil
            } catch {
                return ToolFailure.from(error)
            }
        }
        let missing = failure(["--input", root.appendingPathComponent("none.png").path, "--mask", mask.path, "--output", root.appendingPathComponent("a.png").path])
        #expect(missing?.code == "input_unreadable" && missing?.exitCode == 3)
        let wrongDigest = failure(["--input", input.path, "--mask", mask.path, "--mask-sha256", String(repeating: "0", count: 64), "--output", root.appendingPathComponent("b.png").path])
        #expect(wrongDigest?.code == "corrupt_mask" && wrongDigest?.exitCode == 3)
        let exists = failure(["--input", input.path, "--mask", mask.path, "--output", input.path])
        #expect(exists?.code == "destination_exists" && exists?.exitCode == 4)
        let tiff = failure(["--input", input.path, "--mask", mask.path, "--output", root.appendingPathComponent("c.tif").path])
        #expect(tiff?.code == "unsupported_output" && tiff?.exitCode == 1)
        let strokes = root.appendingPathComponent("bad.json")
        try Data(#"[{"mode":"erase","radius":0,"points":[]}]"#.utf8).write(to: strokes)
        let badStrokes = failure(["--input", input.path, "--mask", mask.path, "--strokes", strokes.path, "--output", root.appendingPathComponent("d.png").path])
        #expect(badStrokes?.code == "invalid_strokes" && badStrokes?.exitCode == 1)
        let farAway = root.appendingPathComponent("far.json")
        try Data(#"[{"mode":"erase","radius":0.1,"points":[{"x":5,"y":0.5}]}]"#.utf8).write(to: farAway)
        let outside = failure(["--input", input.path, "--mask", mask.path, "--strokes", farAway.path, "--output", root.appendingPathComponent("e.png").path])
        #expect(outside?.code == "invalid_strokes")
        let pastEdge = root.appendingPathComponent("past-edge.json")
        try Data(#"[{"mode":"erase","radius":0.1,"points":[{"x":2,"y":0.5}]}]"#.utf8).write(to: pastEdge)
        let pastEdgeOutput = root.appendingPathComponent("past-edge.png")
        #expect(failure(["--input", input.path, "--mask", mask.path, "--strokes", pastEdge.path, "--output", pastEdgeOutput.path]) == nil)
        #expect(FileManager.default.fileExists(atPath: pastEdgeOutput.path))
        #expect(ToolFailure.from(CutoutError.noForegroundSubjects).exitCode == 2)
        #expect(ToolFailure.from(CLIError.usage).code == "invalid_arguments")
        let line = ToolFailure.from(CutoutError.noForegroundSubjects).jsonLine
        #expect(line.hasPrefix(#"{"error":"no_subjects","message":""#))
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutSubcommandTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func writeRGB(_ url: URL, width: Int, height: Int) throws {
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(srgbRed: 0.8, green: 0.2, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
    }

    /// Straight alpha, top-left origin, one byte per pixel.
    private func alphaChannel(_ url: URL) throws -> [UInt8] {
        let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var alpha = [UInt8](repeating: 0, count: image.width * image.height)
        let rendered = alpha.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(
                data: bytes.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        try #require(rendered)
        return alpha
    }
}
