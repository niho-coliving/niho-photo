import Foundation

/// A failure reported as one JSON line on stdout
/// (`{"error":"<code>","message":"..."}`) plus a fixed exit code.
///
/// Exit codes (README「出力の契約」):
/// - 1 `invalid_arguments`
/// - 2 `unsupported_camera` (`CIRAWFilter(imageURL:)` or `outputImage` is nil)
/// - 3 `unsupported_decoder_version`, `unsupported_calibration_feature`,
///   `unsupported_profile` (`raster`: no color space, or a color model it
///   cannot convert), `unsupported_dimensions` (raster cannot be represented
///   as a JPEG without resizing)
/// - 4 `input_not_found`, `read_failed`, `invalid_calibration`, `write_failed`,
///   `decode_failed` / `encode_failed` (`raster`: ImageIO cannot read the
///   input / cannot encode the JPEG)
struct ToolError: Error, Equatable, CustomStringConvertible {
    let code: String
    let message: String
    let exitCode: Int32

    var description: String { "\(code): \(message)" }

    /// `{"error":"<code>","message":"..."}` on a single line.
    var jsonLine: String {
        JSONOutput.singleLine(["error": code, "message": message])
    }

    static func invalidArguments(_ message: String) -> ToolError {
        ToolError(code: "invalid_arguments", message: message, exitCode: 1)
    }

    static func unsupportedCamera(_ message: String) -> ToolError {
        ToolError(code: "unsupported_camera", message: message, exitCode: 2)
    }

    static func unsupportedDecoderVersion(_ message: String) -> ToolError {
        ToolError(code: "unsupported_decoder_version", message: message, exitCode: 3)
    }

    static func unsupportedCalibrationFeature(_ message: String) -> ToolError {
        ToolError(code: "unsupported_calibration_feature", message: message, exitCode: 3)
    }

    static func inputNotFound(_ message: String) -> ToolError {
        ToolError(code: "input_not_found", message: message, exitCode: 4)
    }

    static func readFailed(_ message: String) -> ToolError {
        ToolError(code: "read_failed", message: message, exitCode: 4)
    }

    static func invalidCalibration(_ message: String) -> ToolError {
        ToolError(code: "invalid_calibration", message: message, exitCode: 4)
    }

    static func writeFailed(_ message: String) -> ToolError {
        ToolError(code: "write_failed", message: message, exitCode: 4)
    }

    static func unsupportedProfile(_ message: String) -> ToolError {
        ToolError(code: "unsupported_profile", message: message, exitCode: 3)
    }

    static func unsupportedDimensions(_ message: String) -> ToolError {
        ToolError(code: "unsupported_dimensions", message: message, exitCode: 3)
    }

    static func decodeFailed(_ message: String) -> ToolError {
        ToolError(code: "decode_failed", message: message, exitCode: 4)
    }

    static func encodeFailed(_ message: String) -> ToolError {
        ToolError(code: "encode_failed", message: message, exitCode: 4)
    }
}
