import Foundation
import NihoCameraCutout
import Testing

/// The editor paints its preview with a TS port of the brush
/// (packages/photo-editing/src/photo-cutout.ts `applyCutoutStrokes`) and the
/// export goes through `compose`. Both sides read one fixture: this test
/// checks it is MaskRaster's output, the TS test checks the port gets the
/// same bytes. `NIHO_CUTOUT_WRITE_FIXTURE=1 swift test --filter BrushParity`
/// rewrites it after a deliberate change to the brush.
struct BrushParityTests {
    struct Fixture: Codable, Equatable {
        let note: String
        let width: Int
        let height: Int
        /// Raw mask bytes (row-major, top-left origin), base64.
        let input: String
        /// The same mask as MaskRaster writes it (8-bit gray PNG), base64.
        let maskPng: String
        let strokes: [CutoutBrushStroke]
        /// `MaskRaster(input).applying(strokes)`, base64.
        let expected: String
    }

    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../../../photo-editing/src/fixtures/cutout-brush-parity.json")
        .standardizedFileURL

    /// Hard edges and a ramp (a soft border), odd and non-square so a swapped
    /// width / height or `width - 1` shows.
    static func inputMask() throws -> MaskRaster {
        let (width, height) = (37, 23)
        var pixels = Data(count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                pixels[y * width + x] = x < 10 ? 0 : x > 27 ? 255 : UInt8((x * 29 + y * 13) % 256)
            }
        }
        return try MaskRaster(width: width, height: height, pixels: pixels)
    }

    static let strokes = [
        // A drag (points in between are filled in).
        CutoutBrushStroke(mode: .erase, radius: 0.12, points: [
            CutoutPoint(x: 0.2, y: 0.3), CutoutPoint(x: 0.55, y: 0.4), CutoutPoint(x: 0.9, y: 0.8),
        ]),
        CutoutBrushStroke(mode: .restore, radius: 0.08, points: [CutoutPoint(x: 0.5, y: 0.5)]),
        // Below half a pixel: the brush is clamped to 0.5px.
        CutoutBrushStroke(mode: .erase, radius: 0.01, points: [CutoutPoint(x: 0.1, y: 0.9), CutoutPoint(x: 0.12, y: 0.92)]),
        // Dragged in from outside the photo.
        CutoutBrushStroke(mode: .restore, radius: 0.3, points: [CutoutPoint(x: -0.4, y: 0.5), CutoutPoint(x: 0.05, y: 0.5)]),
        // Entirely outside: paints nothing.
        CutoutBrushStroke(mode: .erase, radius: 0.05, points: [CutoutPoint(x: 1.5, y: 1.5)]),
    ]

    @Test func theFixtureIsMaskRastersOutput() throws {
        let input = try Self.inputMask()
        let expected = input.applying(Self.strokes)
        if ProcessInfo.processInfo.environment["NIHO_CUTOUT_WRITE_FIXTURE"] == "1" {
            let fixture = Fixture(
                note: "niho-camera-cutout MaskRaster.applying の出力（Tests/NihoCameraCutoutTests/BrushParityTests.swift が書く）。photo-cutout.test.ts が同じ計算を照合する。",
                width: input.width,
                height: input.height,
                input: input.pixels.base64EncodedString(),
                maskPng: try input.pngData().base64EncodedString(),
                strokes: Self.strokes,
                expected: expected.pixels.base64EncodedString()
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try FileManager.default.createDirectory(
                at: Self.fixtureURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try (encoder.encode(fixture) + Data("\n".utf8)).write(to: Self.fixtureURL)
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: Self.fixtureURL))
        #expect(fixture.width == input.width && fixture.height == input.height)
        #expect(fixture.strokes == Self.strokes)
        #expect(Data(base64Encoded: fixture.input) == input.pixels)
        #expect(Data(base64Encoded: fixture.expected) == expected.pixels)
        // The PNG in the fixture decodes back to the raw mask (the TS PNG reader reads it too).
        let png = try #require(Data(base64Encoded: fixture.maskPng))
        #expect(try MaskRaster(pngData: png).pixels == input.pixels)
        // The strokes changed something on each kind of pixel (the fixture is not trivially "no-op").
        #expect(expected.pixels != input.pixels)
    }
}
