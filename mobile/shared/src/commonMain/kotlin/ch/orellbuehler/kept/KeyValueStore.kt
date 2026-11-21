package ch.orellbuehler.kept

/**
 * Small string storage the platform provides: once backed by the keystore / keychain
 * (the session token) and once by plain preferences (server address, reminder settings).
 */
interface KeyValueStore {
    fun get(key: String): String?

    /** `null` removes the key. */
    fun set(
        key: String,
        value: String?,
    )
}
