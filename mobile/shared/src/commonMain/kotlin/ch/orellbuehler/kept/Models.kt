package ch.orellbuehler.kept

import kotlinx.serialization.Serializable

/** What `GET /api/app/v1/server` says about the address the user typed. */
@Serializable
data class ServerInfo(
    val app: String = "",
    val version: String = "",
    val apiLevel: Int = 0,
    val setupRequired: Boolean = false,
)

@Serializable
data class SessionUser(
    val id: String,
    val username: String,
    val displayName: String? = null,
    val role: String = "member",
) {
    val isAdmin: Boolean get() = role == "admin"
    val label: String get() = displayName?.takeIf { it.isNotBlank() } ?: username
}

@Serializable
data class Preferences(
    val ibanDisplay: String = "full",
    val blurAmounts: Boolean = false,
    val locale: String = "en-GB",
    val defaultCurrency: String = "CHF",
    val pageSize: Int = 50,
    val investmentCashLiquid: Boolean = false,
)

/** `GET /api/app/v1/session`: who is signed in and what every screen needs. */
@Serializable
data class SessionInfo(
    val user: SessionUser,
    val today: String = "",
    val overdueBills: Int = 0,
    val preferences: Preferences = Preferences(),
    val twoFactor: Boolean = false,
)

sealed interface SessionState {
    /** No server address yet: first start, or the user removed it. */
    data object NoServer : SessionState

    data class SignedOut(
        val serverUrl: String,
        /** True when a session existed and the server ended it. */
        val expired: Boolean = false,
    ) : SessionState

    data class SignedIn(
        val serverUrl: String,
        val user: SessionUser,
    ) : SessionState
}

sealed interface LoginStep {
    data class Done(
        val user: SessionUser,
    ) : LoginStep

    /** The account has a second factor: ask for a code, then [KeptSdk.verifyCode]. */
    data class CodeRequired(
        /** False when the account only has passkeys: only a recovery code works in the app. */
        val totp: Boolean,
    ) : LoginStep
}

/** The fields of a web form, as the page's action expects them. */
class FormBody {
    internal val fields = mutableListOf<Pair<String, String>>()
    internal val files = mutableListOf<FormFile>()

    /** Sets a field; a value that is `null` is not sent. */
    fun set(
        name: String,
        value: String?,
    ): FormBody {
        fields.removeAll { it.first == name }
        if (value != null) fields += name to value
        return this
    }

    /** A checkbox: sent as "on" when ticked, left out otherwise, like a browser. */
    fun check(
        name: String,
        value: Boolean,
    ): FormBody = set(name, if (value) "on" else null)

    /** Adds a value to a repeated field. */
    fun add(
        name: String,
        value: String,
    ): FormBody {
        fields += name to value
        return this
    }

    fun file(
        name: String,
        fileName: String,
        contentType: String,
        base64: String,
    ): FormBody {
        files += FormFile(name, fileName, contentType, base64)
        return this
    }
}

internal data class FormFile(
    val field: String,
    val name: String,
    val type: String,
    val base64: String,
)

/** A page's load data. Exactly one of [json] and [redirect] is set. */
data class PageResponse(
    /** The `data` object as JSON text. */
    val json: String?,
    /** The web path the page sends the browser to instead (e.g. "/import/abc/mapping"). */
    val redirect: String?,
)

data class ActionResponse(
    val ok: Boolean,
    /** For a refused form: the first error, ready to show. */
    val message: String?,
    /** Errors by form field ("form" for the ones that belong to no field), first message each. */
    val fieldErrors: Map<String, String>,
    /** What the action returned (`data`) as JSON text. */
    val json: String,
    /** Where the web page navigates after the action, if it does. */
    val redirect: String?,
)

class Download(
    val bytes: ByteArray,
    val contentType: String,
    val fileName: String?,
)
