import XCTest
@testable import apple_raw_linear

final class SignedWorkingCopyTests: XCTestCase {
    private func rgba(_ rgb: [Float]) -> [Float] {
        precondition(rgb.count.isMultiple(of: 3))
        var result: [Float] = []
        for index in stride(from: 0, to: rgb.count, by: 3) {
            result += [rgb[index], rgb[index + 1], rgb[index + 2], 1]
        }
        return result
    }

    private func encode(_ rgb: [Float]) throws -> (codes: [UInt16], encoding: SignedWorkingCopy.Encoding) {
        let input = rgba(rgb)
        var output = [UInt16](repeating: 0, count: rgb.count)
        let encoding = try input.withUnsafeBufferPointer { source in
            try output.withUnsafeMutableBufferPointer { destination in
                try SignedWorkingCopy.encode(
                    source,
                    width: rgb.count / 3,
                    height: 1,
                    into: destination
                )
            }
        }
        return (output, encoding)
    }

    func testSignedCodesKeepNegativeZeroAndSuperWhite() throws {
        let encoded = try encode([
            0, -1, 1,
            -4, 4, 1.5,
            -0.25, 0.25, 2.25,
        ])
        XCTAssertEqual(encoded.encoding.ceiling, 4)
        XCTAssertEqual(encoded.codes[0], 32_768)
        XCTAssertEqual(encoded.codes[3], 1)
        XCTAssertEqual(encoded.codes[4], 65_535)
        XCTAssertLessThan(encoded.codes[1], 32_768)
        XCTAssertGreaterThan(encoded.codes[2], 32_768)
        XCTAssertGreaterThan(encoded.codes[5], encoded.codes[2])
        XCTAssertNotEqual(encoded.codes[8], 65_535, "headroom below the power-of-two ceiling is not clipped")
    }

    func testPowerOfTwoCeilingAndEndpoints() throws {
        XCTAssertEqual(try encode([0, 0, 0]).encoding.ceiling, 1)
        XCTAssertEqual(try encode([-1.0001, 1.0001, 0]).encoding.ceiling, 2)
        XCTAssertEqual(try encode([-65_536, 65_536, 0]).codes, [1, 65_535, 32_768])
        XCTAssertEqual(SignedWorkingCopy.encode(-1, ceiling: 1), 1)
        XCTAssertEqual(SignedWorkingCopy.encode(0, ceiling: 1), 32_768)
        XCTAssertEqual(SignedWorkingCopy.encode(1, ceiling: 1), 65_535)
        XCTAssertEqual(SignedWorkingCopy.quantize(32_770.5), 32_770)
        XCTAssertEqual(SignedWorkingCopy.quantize(32_771.5), 32_772)
    }

    func testRejectsNonFiniteOutOfRangeAndInvalidLengths() {
        for value in [Float.nan, .infinity, -.infinity, 65_537] {
            XCTAssertThrowsError(try encode([value, 0, 0])) { error in
                XCTAssertEqual((error as? ToolError)?.code, "encode_failed")
            }
        }
        let short: [Float] = [0, 0, 0]
        XCTAssertThrowsError(try short.withUnsafeBufferPointer {
            try SignedWorkingCopy.encoding(forRGBA: $0, width: 1, height: 1)
        })
        XCTAssertThrowsError(try short.withUnsafeBufferPointer { source in
            var output = [UInt16](repeating: 0, count: 2)
            return try output.withUnsafeMutableBufferPointer { destination in
                try SignedWorkingCopy.encode(source, width: 0, height: 1, into: destination)
            }
        })
    }

    func testOnlySignedMetadataCarriesEncodingObject() throws {
        let neutral = NeutralReading(
            temperatureK: 5000,
            tint: 0,
            x: 0.3457,
            y: 0.3585,
            decoderVersion: "8"
        )
        let legacy = WorkingCopy.metadata(
            neutral: neutral,
            calibration: nil,
            decoderVersion: "8",
            source: [:]
        )
        XCTAssertNil(legacy.json["encoding"])

        let signed = WorkingCopy.metadata(
            neutral: neutral,
            calibration: nil,
            decoderVersion: "8",
            encoding: .init(ceiling: 8),
            source: ["recipe": SignedWorkingCopy.recipe]
        )
        let data = try JSONOutput.pretty(signed.json)
        let roundTrip = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let encoding = try XCTUnwrap(roundTrip["encoding"] as? [String: Any])
        XCTAssertEqual(encoding["kind"] as? String, "signed-gamma18-v1")
        XCTAssertEqual(encoding["ceiling"] as? Double, 8)
        XCTAssertEqual((roundTrip["_source"] as? [String: Any])?["recipe"] as? String, SignedWorkingCopy.recipe)
    }
}
