import Foundation

// apple-raw-linear — see README.md for the output contract.
// stdout: results (render: one JSON summary line) or one JSON error line.
// stderr: human notes and warnings only.

let arguments = Array(CommandLine.arguments.dropFirst())

func emit(_ text: String) {
    FileHandle.standardOutput.write(Data(text.utf8))
}

do {
    switch try ArgumentParser.parse(arguments) {
    case .help:
        emit(ArgumentParser.usage + "\n")
    case .version:
        emit("\(Tool.name) \(Tool.version)\n")
    case let .info(options):
        emit(try InfoCommand.run(options))
    case let .cameras(options):
        if let text = try CamerasCommand.run(options) {
            emit(text)
        }
    case let .registry(options):
        emit(try RegistryCommand.run(options) + "\n")
    case let .render(options):
        let summary = try RenderCommand.run(options, arguments: CommandLine.arguments)
        emit(JSONOutput.singleLine(summary) + "\n")
    case let .encodeJPEG(options):
        emit(JSONOutput.singleLine(try EncodeJPEGCommand.run(options)) + "\n")
    case let .retagJPEG(options):
        emit(JSONOutput.singleLine(try RetagJPEGCommand.run(options)) + "\n")
    case let .raster(options):
        emit(JSONOutput.singleLine(try RasterCommand.run(options)) + "\n")
    }
    exit(0)
} catch let error as ToolError {
    emit(error.jsonLine + "\n")
    exit(error.exitCode)
} catch {
    // Anything not mapped to a ToolError comes from Foundation file APIs.
    emit(ToolError(code: "io_error", message: "\(error)", exitCode: 4).jsonLine + "\n")
    exit(4)
}
