import Foundation

/// JSON helpers built on `JSONSerialization` so metadata can carry explicit
/// `null`s (`NSNull`) and mixed value types.
///
/// `JSONSerialization` raises an Objective-C exception (a crash) for NaN or
/// infinity, so every number goes through `number(_:)` and every document is
/// checked with `isValidJSONObject` first.
enum JSONOutput {
    static func singleLine(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.sortedKeys, .withoutEscapingSlashes]
              )
        else {
            return #"{"error":"internal_error","message":"value is not serializable as JSON"}"#
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Pretty-printed, key-sorted UTF-8 with a trailing newline.
    static func pretty(_ object: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw ToolError.writeFailed("internal error: metadata is not serializable as JSON")
        }
        var data = try JSONSerialization.data(
            withJSONObject: object,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        data.append(0x0A)
        return data
    }

    /// A Float as the shortest decimal that round-trips (0.639 stays 0.639
    /// instead of 0.63899999856948853); `null` when not finite.
    ///
    /// `JSONSerialization` prints a `Double` with 17 significant digits
    /// (0.05 → 0.050000000000000003) but an `NSDecimalNumber` verbatim, so
    /// numbers are handed over as decimals built from Swift's shortest
    /// round-trip description.
    static func number(_ value: Float) -> Any {
        guard value.isFinite else { return NSNull() }
        return decimal(value.description) ?? Double(value)
    }

    static func number(_ value: Double) -> Any {
        guard value.isFinite else { return NSNull() }
        return decimal(value.description) ?? value
    }

    private static func decimal(_ text: String) -> NSDecimalNumber? {
        let number = NSDecimalNumber(string: text, locale: Locale(identifier: "en_US_POSIX"))
        return number == NSDecimalNumber.notANumber ? nil : number
    }

    static func number(_ value: CGFloat) -> Any {
        number(Double(value))
    }

    static func matrix(_ matrix: Matrix3) -> [[Any]] {
        matrix.rowMajor.map { row in row.map { number($0) } }
    }

    static func optional(_ value: Any?) -> Any {
        value ?? NSNull()
    }

    static func iso8601Now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date())
    }
}
