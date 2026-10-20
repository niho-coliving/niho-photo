// Core Image's CITemperatureAndTint measured on float buffers (the relative
// white balance of Photo Bench `RelativeColorAdjustment`): renders the unit
// vectors of extended linear sRGB through the filter in an RGBAf context
// and prints each case's matrix columns as JSON. The filter is linear, so
// the three columns are the whole stage (`src/relative_wb.rs` models it and
// its test holds four of these cases).
//
//   swiftc -O scripts/golden/temperature_tint_probe.swift -o /tmp/tt_probe && /tmp/tt_probe
//
// Each case is `[neutralK, neutralTint, targetK, targetTint]`; the default
// set is Photo Bench's range (inputNeutral = (6500 + 30 t, 0.5 n) for
// t, n in -100..100, target (6500, 0)) plus other targets.

import CoreImage
import Foundation

let linear = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
let context = CIContext(options: [
    .workingColorSpace: linear,
    .workingFormat: NSNumber(value: CIFormat.RGBAf.rawValue),
    .outputColorSpace: linear,
    .cacheIntermediates: false,
])

let basis: [Float] = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]
let input = CIImage(
    bitmapData: basis.withUnsafeBytes { Data($0) },
    bytesPerRow: 3 * 16,
    size: CGSize(width: 3, height: 1),
    format: .RGBAf,
    colorSpace: linear
)

func columns(_ neutral: CIVector, _ target: CIVector) -> [[Double]] {
    let filter = CIFilter(name: "CITemperatureAndTint", parameters: [
        kCIInputImageKey: input,
        "inputNeutral": neutral,
        "inputTargetNeutral": target,
    ])!
    var out = [Float](repeating: 0, count: 12)
    out.withUnsafeMutableBytes { buffer in
        context.render(filter.outputImage!, toBitmap: buffer.baseAddress!, rowBytes: 3 * 16,
                       bounds: CGRect(x: 0, y: 0, width: 3, height: 1), format: .RGBAf, colorSpace: linear)
    }
    return (0..<3).map { k in (0..<3).map { Double(out[k * 4 + $0]) } }
}

var cases: [[Double]] = []
for t in stride(from: -100.0, through: 100.0, by: 10.0) {
    for n in stride(from: -100.0, through: 100.0, by: 20.0) {
        cases.append([6500 + 30 * t, 0.5 * n, 6500, 0])
    }
}
cases += [[4000, 10, 5000, -10], [9000, -20, 3500, 15], [6500, 0, 5000, 0], [2000, 0, 6500, 0], [25000, 0, 6500, 0]]

let rows = cases.map { c in
    ["neutral": [c[0], c[1]], "target": [c[2], c[3]],
     "columns": columns(CIVector(x: c[0], y: c[1]), CIVector(x: c[2], y: c[3]))] as [String: Any]
}
let json = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
FileHandle.standardOutput.write(json)
