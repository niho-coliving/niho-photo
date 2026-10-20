// swift-tools-version: 6.0
//
// niho-camera-cutout: background removal with Apple Vision's on-device
// foreground instance masks (VNGenerateForegroundInstanceMaskRequest), and the
// compositor that turns a mask into a transparent / white / colored PNG or a
// flattened JPEG. Copied from Photo Bench c76775b (NIHO camera 0.4.0) for the
// NIHO camera app (Epic #18387, C4 #18392). Bundled as a sidecar of
// apps/camera. macOS 14 or later, Apple frameworks only (see README.md).
import PackageDescription

let package = Package(
    name: "niho-camera-cutout",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "NihoCameraCutout", targets: ["NihoCameraCutout"]),
        .executable(name: "niho-camera-cutout", targets: ["NihoCameraCutoutCLI"]),
    ],
    targets: [
        .target(
            name: "NihoCameraCutout",
            path: "Sources/NihoCameraCutout"
        ),
        .executableTarget(
            name: "NihoCameraCutoutCLI",
            dependencies: ["NihoCameraCutout"],
            path: "Sources/NihoCameraCutoutCLI"
        ),
        .testTarget(
            name: "NihoCameraCutoutTests",
            // NihoCameraCutoutCLI: the argument parser and the version line.
            dependencies: ["NihoCameraCutout", "NihoCameraCutoutCLI"],
            path: "Tests/NihoCameraCutoutTests"
        ),
    ]
)
