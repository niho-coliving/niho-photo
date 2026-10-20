// swift-tools-version: 6.0
//
// apple-raw-linear: macOS Core Image (CIRAWFilter) RAW decode to a linear,
// as-shot white balanced image in linear ProPhoto (D50) or linear sRGB.
// Measurement / working-copy tool for the NIHO develop engine (Epic #16939,
// S9a #16975). macOS only; not built or run in CI (see README.md).
import PackageDescription

let package = Package(
    name: "apple-raw-linear",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "apple-raw-linear", targets: ["apple-raw-linear"]),
    ],
    targets: [
        .executableTarget(
            name: "apple-raw-linear",
            path: "Sources/apple-raw-linear"
        ),
        .testTarget(
            name: "apple-raw-linearTests",
            dependencies: ["apple-raw-linear"],
            path: "Tests/apple-raw-linearTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
