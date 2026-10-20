import XCTest
@testable import apple_raw_linear

final class Lanczos4Tests: XCTestCase {
    func testDimensionsUseCeilAndNeverUpscale() throws {
        XCTAssertEqual(
            try Lanczos4.dimensions(width: 6000, height: 4000, longEdge: .pixels(2560)),
            .init(width: 2560, height: 1707)
        )
        XCTAssertEqual(
            try Lanczos4.dimensions(width: 4000, height: 6000, longEdge: .pixels(2560)),
            .init(width: 1707, height: 2560)
        )
        XCTAssertEqual(
            try Lanczos4.dimensions(width: 20, height: 10, longEdge: .pixels(2560)),
            .init(width: 20, height: 10)
        )
        XCTAssertEqual(
            try Lanczos4.dimensions(width: 20, height: 10, longEdge: .full),
            .init(width: 20, height: 10)
        )
    }

    func testIdentityReturnsNoAllocation() throws {
        let source: [Float] = [0.25, -0.5, 2, 1]
        let result = try source.withUnsafeBufferPointer {
            try Lanczos4.resizeIfNeeded($0, width: 1, height: 1, longEdge: .full)
        }
        XCTAssertNil(result)
    }

    func testOnePixelBorderReplicationPreservesAConstant() throws {
        let pixel: [Float] = [-0.25, 1.5, 3, 1]
        let source = Array(repeating: pixel, count: 4).flatMap { $0 }
        let result = try XCTUnwrap(try source.withUnsafeBufferPointer {
            try Lanczos4.resizeIfNeeded($0, width: 1, height: 4, longEdge: .pixels(2))
        })
        defer { result.pixels.deallocate() }
        XCTAssertEqual(result.width, 1)
        XCTAssertEqual(result.height, 2)
        for index in 0 ..< result.width * result.height * 4 {
            XCTAssertEqual(result.pixels[index], pixel[index % 4], accuracy: 2e-6)
        }
    }

    func testSyntheticResizeKeepsNegativeAndHeadroom() throws {
        var source: [Float] = []
        for y in 0 ..< 4 {
            for x in 0 ..< 6 {
                source += [
                    Float(x - 2) * 0.4,
                    Float(y) * 0.75,
                    Float(x + y) * 0.5,
                    1,
                ]
            }
        }
        let result = try XCTUnwrap(try source.withUnsafeBufferPointer {
            try Lanczos4.resizeIfNeeded($0, width: 6, height: 4, longEdge: .pixels(3))
        })
        defer { result.pixels.deallocate() }
        XCTAssertEqual(result.width, 3)
        XCTAssertEqual(result.height, 2)
        let values = Array(UnsafeBufferPointer(start: result.pixels, count: 3 * 2 * 4))
        XCTAssertLessThan(values[0], 0)
        XCTAssertGreaterThan(values[10], 2)
        // A few fixed synthetic values pin the half-pixel/f32/replicated-border recipe.
        XCTAssertEqual(values[0], -0.6337494, accuracy: 2e-6)
        XCTAssertEqual(values[2], 0.42194143, accuracy: 2e-6)
        XCTAssertEqual(values[20], 1.0337493, accuracy: 2e-6)
    }

    func testRejectsInvalidSizeAndLength() {
        let source = [Float](repeating: 0, count: 4)
        XCTAssertThrowsError(try source.withUnsafeBufferPointer {
            try Lanczos4.resizeIfNeeded($0, width: 2, height: 1, longEdge: .pixels(1))
        })
        XCTAssertThrowsError(try Lanczos4.dimensions(width: 0, height: 1, longEdge: .full))
    }
}
