import CoreGraphics
import Foundation

public enum CutoutSubjectSelection: Codable, Equatable, Hashable, Sendable {
    case instance(Int)
    case all

    public var storageKey: String {
        switch self {
        case let .instance(id): "instance-\(id)"
        case .all: "all"
        }
    }
}

public struct CutoutRGBA: Codable, Equatable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double
    public var alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    public static let white = CutoutRGBA(red: 1, green: 1, blue: 1)
}

public enum CutoutBackground: Codable, Equatable, Sendable {
    case transparent
    case color(CutoutRGBA)
}

public struct CutoutPoint: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum CutoutBrushMode: String, Codable, Equatable, Sendable {
    case erase
    case restore
}

public struct CutoutBrushStroke: Codable, Equatable, Sendable {
    public var mode: CutoutBrushMode
    /// Radius as a fraction of the normalized image's shorter edge.
    public var radius: Double
    public var points: [CutoutPoint]

    public init(mode: CutoutBrushMode, radius: Double, points: [CutoutPoint]) {
        self.mode = mode
        self.radius = radius
        self.points = points
    }
}

public struct CutoutMaskReference: Codable, Equatable, Hashable, Sendable {
    public static let currentSchemaVersion = 1
    public static let engineIdentifier = "VNGenerateForegroundInstanceMaskRequest"
    public static let engineRevision = 1

    public let schemaVersion: Int
    public let artifactID: String
    public let maskSHA256: String
    public let inputSHA256: String
    public let width: Int
    public let height: Int
    public let orientation: UInt32
    public let engineIdentifier: String
    public let engineRevision: Int
    public let selection: CutoutSubjectSelection

    public init(
        artifactID: String,
        maskSHA256: String,
        inputSHA256: String,
        width: Int,
        height: Int,
        orientation: UInt32 = 1,
        engineIdentifier: String = Self.engineIdentifier,
        engineRevision: Int = Self.engineRevision,
        selection: CutoutSubjectSelection
    ) {
        self.schemaVersion = Self.currentSchemaVersion
        self.artifactID = artifactID
        self.maskSHA256 = maskSHA256
        self.inputSHA256 = inputSHA256
        self.width = width
        self.height = height
        self.orientation = orientation
        self.engineIdentifier = engineIdentifier
        self.engineRevision = engineRevision
        self.selection = selection
    }
}

public struct CutoutSubject: Codable, Equatable, Sendable, Identifiable {
    public let selection: CutoutSubjectSelection
    public let pixelCount: Int
    public let mask: CutoutMaskReference

    public init(selection: CutoutSubjectSelection, pixelCount: Int, mask: CutoutMaskReference) {
        self.selection = selection
        self.pixelCount = pixelCount
        self.mask = mask
    }

    public var id: String { selection.storageKey }
}

public struct BackgroundEditRecipe: Codable, Equatable, Sendable {
    public var subjects: [CutoutSubject]
    public var selectedSubject: CutoutSubjectSelection
    public var background: CutoutBackground
    public var brushStrokes: [CutoutBrushStroke]

    public init(
        subjects: [CutoutSubject],
        selectedSubject: CutoutSubjectSelection,
        background: CutoutBackground = .transparent,
        brushStrokes: [CutoutBrushStroke] = []
    ) {
        self.subjects = subjects
        self.selectedSubject = selectedSubject
        self.background = background
        self.brushStrokes = brushStrokes
    }

    public var selectedMask: CutoutMaskReference? {
        subjects.first { $0.selection == selectedSubject }?.mask
    }
}

public struct DetectedCutoutMask: Sendable {
    public let selection: CutoutSubjectSelection
    public let pixelCount: Int
    public let pngData: Data

    public init(selection: CutoutSubjectSelection, pixelCount: Int, pngData: Data) {
        self.selection = selection
        self.pixelCount = pixelCount
        self.pngData = pngData
    }
}

public struct CutoutDetectionResult: Sendable {
    public let width: Int
    public let height: Int
    public let inputSHA256: String
    public let masks: [DetectedCutoutMask]
    public let largestSelection: CutoutSubjectSelection

    public init(
        width: Int,
        height: Int,
        inputSHA256: String,
        masks: [DetectedCutoutMask],
        largestSelection: CutoutSubjectSelection
    ) {
        self.width = width
        self.height = height
        self.inputSHA256 = inputSHA256
        self.masks = masks
        self.largestSelection = largestSelection
    }
}

public enum CutoutError: LocalizedError, Equatable {
    case unreadableInput(URL)
    case invalidImageDimensions
    case noForegroundSubjects
    case unsupportedMaskFormat
    case corruptMask(String)
    case destinationExists(URL)
    case destinationIsDirectory(URL)
    case sourceOverwriteForbidden(URL)
    case unsupportedOutput(URL)
    case encodingFailed(URL)

    public var errorDescription: String? {
        switch self {
        case let .unreadableInput(url): "画像を読み込めません: \(url.path)"
        case .invalidImageDimensions: "画像またはマスクの寸法が不正です。"
        case .noForegroundSubjects: "切り抜ける被写体が見つかりませんでした。"
        case .unsupportedMaskFormat: "マスクの画素形式に対応していません。"
        case let .corruptMask(reason): "保存済みマスクを読み込めません: \(reason)"
        case let .destinationExists(url): "出力先は既に存在します: \(url.path)"
        case let .destinationIsDirectory(url): "出力先はディレクトリです: \(url.path)"
        case let .sourceOverwriteForbidden(url): "元画像を上書きできません: \(url.path)"
        case let .unsupportedOutput(url): "出力形式はPNGまたはJPEGを指定してください: \(url.path)"
        case let .encodingFailed(url): "画像を書き出せません: \(url.path)"
        }
    }
}
