// Core Image's decode of PNGs with embedded ICC profiles (Photo Bench reads
// originals with CIImage and the extended linear sRGB working space), for
// `examples/icc_lut_profiles.rs`: writes `<name>.ci.f32` (little-endian
// f32, extended linear sRGB, RGB interleaved) next to each `<name>.png`
// (with its profile `<name>.icc`).
//
//   swiftc -O scripts/golden/icc_reference.swift -o /tmp/icc_reference && /tmp/icc_reference <dir>

import CoreImage
import Foundation
import ImageIO

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let linear = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
let context = CIContext(options: [
    .workingColorSpace: linear,
    .workingFormat: NSNumber(value: CIFormat.RGBAf.rawValue),
    .cacheIntermediates: false,
])
let names = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".png") }.sorted()
for name in names {
    // ImageIO drops some embedded LUT profiles on PNG read (a v4 lutAtoB
    // with PCS XYZ, although ColorSync verifies it); attach `<name>.icc`
    // explicitly so the comparison is ColorSync's evaluation of the profile.
    let url = dir.appendingPathComponent(name)
    let iccURL = dir.appendingPathComponent(name.replacingOccurrences(of: ".png", with: ".icc"))
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let space = CGColorSpace(iccData: try Data(contentsOf: iccURL) as CFData),
          let tagged = decoded.copy(colorSpace: space) else { fatalError("unreadable \(name)") }
    let attached = CIImage(contentsOf: url)?.colorSpace.map { $0.name as String? ?? "ICC" } ?? "none"
    let image = CIImage(cgImage: tagged)
    let w = Int(image.extent.width), h = Int(image.extent.height)
    var rgba = [Float](repeating: 0, count: w * h * 4)
    rgba.withUnsafeMutableBytes { buffer in
        context.render(image, toBitmap: buffer.baseAddress!, rowBytes: w * 16, bounds: image.extent, format: .RGBAf, colorSpace: linear)
    }
    var rgb = [Float]()
    rgb.reserveCapacity(w * h * 3)
    for i in 0..<(w * h) { rgb += rgba[i * 4..<i * 4 + 3] }
    let out = dir.appendingPathComponent(name.replacingOccurrences(of: ".png", with: ".ci.f32"))
    try rgb.withUnsafeBytes { try Data($0).write(to: out) }
    print(name, w, h, "ImageIO attached:", attached)
}
