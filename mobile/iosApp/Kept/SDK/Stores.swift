import Foundation
import Security
import shared

/// Plain preferences: server address, the signed-in user's name, reminder settings.
final class DefaultsStore: KeyValueStore, @unchecked Sendable {
    private let defaults = UserDefaults.standard
    private let prefix = "kept."

    func get(key: String) -> String? {
        defaults.string(forKey: prefix + key)
    }

    func set(key: String, value: String?) {
        if let value {
            defaults.set(value, forKey: prefix + key)
        } else {
            defaults.removeObject(forKey: prefix + key)
        }
    }
}

/// The session token, in the keychain: this device only, readable after the first unlock so the
/// background refresh for reminders can use it.
final class KeychainStore: KeyValueStore, @unchecked Sendable {
    private let service = "ch.orellbuehler.kept"

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func get(key: String) -> String? {
        var request = query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(key: String, value: String?) {
        SecItemDelete(query(key) as CFDictionary)
        guard let value else { return }
        var item = query(key)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
