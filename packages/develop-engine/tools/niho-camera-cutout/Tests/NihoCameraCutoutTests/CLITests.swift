import Foundation
import NihoCameraCutout
@testable import NihoCameraCutoutCLI
import Testing

struct CLITests {
    @Test func versionAndHelpAreTheSoleArgument() throws {
        for argument in ["version", "--version", "-V"] {
            #expect(try Command.parse([argument]) == .version)
        }
        for argument in ["help", "--help", "-h"] {
            #expect(try Command.parse([argument]) == .help)
        }
        // A file named "version" is still a path.
        let command = try Command.parse(["--input", "version", "--output", "help.png"])
        guard case let .cutout(options) = command else {
            Issue.record("\(command)")
            return
        }
        #expect(options.input.lastPathComponent == "version")
        #expect(options.output.lastPathComponent == "help.png")
    }

    /// NIHO camera reads `<name> X.Y.Z` (apple-raw-linear's line), and
    /// scripts/sidecar-lock.mjs reads `static let version` from Tool.swift.
    @Test func versionIsSemanticAndNamed() throws {
        #expect(Tool.name == "niho-camera-cutout")
        #expect(Tool.version.wholeMatch(of: /\d+\.\d+\.\d+/) != nil)
    }

    @Test func defaultsArePhotoBenchs() throws {
        let options = try Options(arguments: ["--input", "a.jpg", "--output", "a.png"])
        #expect(options.selection == .largest)
        #expect(options.background == .transparent)
        #expect(options.jpegQuality == 0.92)
        let short = try Options(arguments: ["-i", "a.jpg", "-o", "a.png"])
        #expect(short == options)
    }

    @Test func subjectBackgroundAndQuality() throws {
        let options = try Options(arguments: [
            "--input", "a.heic", "--output", "a.jpg",
            "--subject", "2", "--background", "#3366Ff", "--jpeg-quality", "0.5",
        ])
        #expect(options.selection == .instance(2))
        #expect(options.background == .color(CutoutRGBA(red: 0x33 / 255, green: 0x66 / 255, blue: 1)))
        #expect(options.jpegQuality == 0.5)
        #expect(try Options(arguments: ["-i", "a", "-o", "b", "--subject", "all"]).selection == .all)
        #expect(try Options(arguments: ["-i", "a", "-o", "b", "--background", "white"]).background == .color(.white))
        #expect(try Options(arguments: ["-i", "a", "-o", "b", "--background", "000000"]).background
            == .color(CutoutRGBA(red: 0, green: 0, blue: 0)))
    }

    @Test func invalidArgumentsAreRejected() {
        #expect(throws: CLIError.usage) { try Command.parse([]) }
        #expect(throws: CLIError.usage) { try Options(arguments: ["--input", "a.jpg"]) }
        #expect(throws: CLIError.usage) { try Options(arguments: ["--input", "a.jpg", "--output"]) }
        #expect(throws: CLIError.unknownOption("--mask")) {
            try Options(arguments: ["-i", "a", "-o", "b", "--mask", "x"])
        }
        for subject in ["0", "-1", "largest-1"] {
            #expect(throws: CLIError.invalidSubject(subject)) {
                try Options(arguments: ["-i", "a", "-o", "b", "--subject", subject])
            }
        }
        for background in ["red", "#fff", "#12345g"] {
            #expect(throws: CLIError.invalidBackground(background)) {
                try Options(arguments: ["-i", "a", "-o", "b", "--background", background])
            }
        }
        for quality in ["1.5", "-0.1", "high"] {
            #expect(throws: CLIError.invalidQuality(quality)) {
                try Options(arguments: ["-i", "a", "-o", "b", "--jpeg-quality", quality])
            }
        }
    }
}
