package ch.orellbuehler.kept

/** Why a call to the server failed, coarse enough for the UI to decide what to show. */
enum class KeptErrorKind {
    /** The server could not be reached (offline, wrong address, timeout, TLS). */
    NETWORK,

    /** The address answers, but not as a Kept server this app can talk to. */
    NOT_KEPT,

    /** The session ended or was never there; the user has to sign in again. */
    UNAUTHORIZED,
    FORBIDDEN,
    NOT_FOUND,

    /** Too many attempts; [KeptException.retryAfterSeconds] says when to try again. */
    RATE_LIMITED,

    /** The server refused the request (4xx) with the message it gives. */
    REJECTED,

    /** The server failed (5xx) or answered something this app does not understand. */
    SERVER,
}

class KeptException(
    val kind: KeptErrorKind,
    message: String,
    val status: Int = 0,
    val retryAfterSeconds: Int? = null,
) : Exception(message)
