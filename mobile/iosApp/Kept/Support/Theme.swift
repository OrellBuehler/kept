import SwiftUI
import UIKit

/// Colours with a meaning, following the web's tokens (src/app.css). Each adapts to light and dark.
enum KeptColor {
    static let positive = dynamic(light: 0x0B7A55, dark: 0x47D7A2)
    static let negative = dynamic(light: 0xD22222, dark: 0xEE6363)
    static let warning = dynamic(light: 0xA65C07, dark: 0xF7B545)
    static let border = dynamic(light: 0xE2E5E9, dark: 0x272930)
    static let page = dynamic(light: 0xFAFBFC, dark: 0x0E0F13)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x15161C)
    static let muted = dynamic(light: 0xEFF1F3, dark: 0x22242A)

    static let charts: [Color] = [
        dynamic(light: 0x1C9C86, dark: 0x2BD4B2),
        dynamic(light: 0x3B6FE7, dark: 0x64A0F6),
        dynamic(light: 0xF28D0D, dark: 0xF5A33D),
        dynamic(light: 0x9354D4, dark: 0xA97BE8),
        dynamic(light: 0xDE3572, dark: 0xEA6193),
    ]

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

extension Color {
    /// A colour from a "#rrggbb" string of the server (category and institution colours); nil when it is not one.
    init?(hex: String?) {
        guard let hex else { return nil }
        let value = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard value.count == 6, let number = UInt32(value, radix: 16) else { return nil }
        self.init(
            red: Double((number >> 16) & 0xFF) / 255,
            green: Double((number >> 8) & 0xFF) / 255,
            blue: Double(number & 0xFF) / 255
        )
    }
}
