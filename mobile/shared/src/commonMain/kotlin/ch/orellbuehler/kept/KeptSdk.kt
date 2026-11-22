package ch.orellbuehler.kept

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The one entry point of the shared module: which server the app talks to, who is signed in,
 * and the calls of `/api/app/v1`. The UIs decode the page JSON into their own models.
 *
 * @param secure storage for the session token (keystore / keychain backed)
 * @param prefs storage for everything else (server address, the signed-in user, reminder settings)
 * @param engine only set in tests
 */
class KeptSdk(
    private val secure: KeyValueStore,
    private val prefs: KeyValueStore,
    userAgent: String = "Kept",
    engine: HttpClientEngine? = null,
) {
    /** For Swift, which has no default arguments. */
    constructor(secure: KeyValueStore, prefs: KeyValueStore, userAgent: String) : this(secure, prefs, userAgent, null)

    private val transport = Transport(engine ?: defaultEngine(), userAgent)
    private val mutableState = MutableStateFlow(restore())

    /** Short-lived: between the password and the second factor. Never stored. */
    private var pendingToken: String? = null

    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    val serverUrl: String? get() = prefs.get(KEY_SERVER)

    /** True when the configured server is reached without TLS; the UI warns about it. */
    val insecure: Boolean get() = serverUrl?.startsWith("http://") == true

    val reminders: Reminders = Reminders(this, prefs)

    private fun restore(): SessionState {
        val server = prefs.get(KEY_SERVER) ?: return SessionState.NoServer
        val user =
            prefs.get(KEY_USER)?.let {
                runCatching { KeptJson.decodeFromString<SessionUser>(it) }.getOrNull()
            }
        return if (user != null && secure.get(KEY_TOKEN) != null) {
            SessionState.SignedIn(server, user)
        } else {
            SessionState.SignedOut(server)
        }
    }

    /**
     * Checks that [address] is a Kept server and remembers it. Any earlier sign-in is dropped.
     * Throws [KeptException] with [KeptErrorKind.NOT_KEPT] when something else answers there.
     */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun connect(address: String): ServerInfo {
        val url =
            normalizeServerUrl(address)
                ?: throw KeptException(KeptErrorKind.NOT_KEPT, "Enter the address of your Kept server, e.g. kept.example.org.")
        val response = transport.send(HttpMethod.Get, url, "server")
        val body = transport.text(response)
        val info =
            if (response.status.value == 200) {
                runCatching { KeptJson.decodeFromString<ServerInfo>(body) }.getOrNull()
            } else {
                null
            }
        if (info == null || info.app != "kept") {
            throw KeptException(
                KeptErrorKind.NOT_KEPT,
                "No Kept server answers at this address. Check it, and that the server is version 0.6 or newer.",
                response.status.value,
            )
        }
        if (info.apiLevel < 1) {
            throw KeptException(KeptErrorKind.NOT_KEPT, "This server is too old for the app. Update Kept.")
        }
        clearSession()
        prefs.set(KEY_SERVER, url)
        mutableState.value = SessionState.SignedOut(url)
        return info
    }

    /** Forgets the server and everything stored for it. */
    fun disconnect() {
        clearSession()
        prefs.set(KEY_SERVER, null)
        reminders.forget()
        mutableState.value = SessionState.NoServer
    }

    @Throws(KeptException::class, CancellationException::class)
    suspend fun login(
        username: String,
        password: String,
    ): LoginStep {
        val body =
            buildJsonObject {
                put("username", username)
                put("password", password)
            }
        val json = unauthenticated("auth/login", body)
        if (json.string("status") == "second_factor") {
            pendingToken = json.string("pendingToken") ?: throw unexpected()
            return LoginStep.CodeRequired(totp = (json["totp"] as? JsonPrimitive)?.contentOrNull != "false")
        }
        return LoginStep.Done(signedIn(json))
    }

    /** Second step after [LoginStep.CodeRequired]: an authenticator or recovery code. */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun verifyCode(code: String): SessionUser {
        val pending =
            pendingToken ?: throw KeptException(KeptErrorKind.REJECTED, "Your sign-in expired. Start again.", 410)
        val body =
            buildJsonObject {
                put("pendingToken", pending)
                put("code", code)
            }
        try {
            return signedIn(unauthenticated("auth/verify", body))
        } catch (e: KeptException) {
            if (e.status == 410) pendingToken = null
            throw e
        }
    }

    fun cancelSecondFactor() {
        pendingToken = null
    }

    /**
     * Starts a sign-in on the server's own login page, where passkeys and password managers
     * work. Returns the address to open in a browser; when the browser comes back to an address
     * with the scheme [BROWSER_CALLBACK_SCHEME], hand that address to [finishBrowserSignIn].
     */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun startBrowserSignIn(): String {
        val server = serverUrl ?: throw KeptException(KeptErrorKind.NOT_KEPT, "Set the server address first.")
        val json =
            try {
                unauthenticated("auth/browser", JsonObject(emptyMap()))
            } catch (e: KeptException) {
                // A server from before this existed answers its "sign in first" for the unknown path.
                if (e.status != 401 && e.status != 404) throw e
                throw KeptException(
                    KeptErrorKind.REJECTED,
                    "This server cannot sign the app in through the browser yet. Update Kept on the server, or use your password.",
                    e.status,
                )
            }
        val request = json.string("request") ?: throw unexpected()
        val secret = json.string("secret") ?: throw unexpected()
        val path = json.string("path")?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: throw unexpected()
        secure.set(KEY_BROWSER, "$request\n$secret")
        return server + path
    }

    /** True between [startBrowserSignIn] and its end: a return that arrives otherwise is not ours. */
    val browserSignInPending: Boolean get() = secure.get(KEY_BROWSER) != null

    /**
     * After the browser came back to [callbackUrl]: trades what [startBrowserSignIn] kept, and the
     * code of the approval that the address carries, for the session.
     */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun finishBrowserSignIn(callbackUrl: String): SessionUser {
        val parts = secure.get(KEY_BROWSER)?.split('\n')
        val code = queryValue(callbackUrl, "code")
        if (parts == null || parts.size != 2 || code == null || queryValue(callbackUrl, "request") != parts[0]) {
            // Not the return of the sign-in that is waiting (if any): that one stays as it is.
            throw KeptException(KeptErrorKind.REJECTED, "Your sign-in expired. Start again.", 410)
        }
        val body =
            buildJsonObject {
                put("request", parts[0])
                put("secret", parts[1])
                put("code", code)
            }
        try {
            val user = signedIn(unauthenticated("auth/browser/token", body))
            secure.set(KEY_BROWSER, null)
            return user
        } catch (e: KeptException) {
            if (e.status == 410) secure.set(KEY_BROWSER, null)
            throw e
        }
    }

    /** The browser was closed without signing in. */
    fun cancelBrowserSignIn() {
        secure.set(KEY_BROWSER, null)
    }

    /** Ends the session on the server (best effort) and on the device. */
    suspend fun logout() {
        val server = serverUrl
        val token = secure.get(KEY_TOKEN)
        if (server != null && token != null) {
            try {
                transport.send(HttpMethod.Post, server, "auth/logout", token = token)
            } catch (e: KeptException) {
                // Offline: the token is dropped here and expires on the server by itself.
            }
        }
        clearSession()
        mutableState.value = if (server != null) SessionState.SignedOut(server) else SessionState.NoServer
    }

    @Throws(KeptException::class, CancellationException::class)
    suspend fun session(): SessionInfo {
        val info = decode<SessionInfo>(text(authorized(HttpMethod.Get, "session")))
        remember(info.user)
        return info
    }

    /** `GET /session` as JSON text, for UIs that decode it themselves. */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun sessionJson(): String = text(authorized(HttpMethod.Get, "session"))

    /** A page's data: `path` as in the registry ("bills", "accounts/<id>"), `query` as the web page reads it. */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun page(
        path: String,
        query: Map<String, String> = emptyMap(),
    ): PageResponse {
        val json = obj(text(authorized(HttpMethod.Get, "pages/$path", query)))
        val redirect = json.string("redirect")
        if (redirect != null) return PageResponse(null, redirect)
        val data = json["data"] as? JsonObject ?: throw unexpected()
        return PageResponse(data.toString(), null)
    }

    /**
     * Runs a page's form action. A refused form (validation, conflict) is a normal result with
     * `ok == false`; everything else that goes wrong throws.
     */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun action(
        path: String,
        action: String,
        form: FormBody = FormBody(),
        query: Map<String, String> = emptyMap(),
    ): ActionResponse {
        val response =
            authorized(
                HttpMethod.Post,
                "pages/$path",
                query + ("_action" to action),
                encodeForm(form),
                failOnStatus = false,
            )
        val body = transport.text(response)
        val json = parseObject(body)
        val ok = (json?.get("ok") as? JsonPrimitive)?.contentOrNull
        if (json == null || ok == null) throw failure(response, body)
        val data = json["data"] as? JsonObject ?: JsonObject(emptyMap())
        return ActionResponse(
            ok = ok == "true",
            message = json.string("message"),
            fieldErrors = fieldErrors(data),
            json = data.toString(),
            redirect = json.string("redirect"),
        )
    }

    /** A file the web serves: "bills/<id>/document", "reports/<kind>", "institutions/<id>/logo". */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun download(
        path: String,
        query: Map<String, String> = emptyMap(),
    ): Download {
        val response = authorized(HttpMethod.Get, "endpoints/$path", query)
        return Download(
            bytes = transport.bytes(response),
            contentType = response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim() ?: "application/octet-stream",
            fileName = fileName(response.headers[HttpHeaders.ContentDisposition]),
        )
    }

    /** One of the JSON endpoints behind `/endpoints/`; `jsonBody` makes it a POST. Returns the body as text. */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun endpoint(
        path: String,
        query: Map<String, String> = emptyMap(),
        jsonBody: String? = null,
    ): String =
        text(
            authorized(
                if (jsonBody == null) HttpMethod.Get else HttpMethod.Post,
                "endpoints/$path",
                query,
                jsonBody,
            ),
        )

    internal suspend fun get(
        path: String,
        query: Map<String, String>,
    ): String = text(authorized(HttpMethod.Get, path, query))

    internal val signedIn: Boolean get() = secure.get(KEY_TOKEN) != null && serverUrl != null

    private suspend fun authorized(
        method: HttpMethod,
        path: String,
        query: Map<String, String> = emptyMap(),
        jsonBody: String? = null,
        failOnStatus: Boolean = true,
    ): HttpResponse {
        val server = serverUrl
        val token = secure.get(KEY_TOKEN)
        if (server == null || token == null) throw KeptException(KeptErrorKind.UNAUTHORIZED, "Sign in to continue.", 401)
        val response = transport.send(method, server, path, query, token, jsonBody)
        if (response.status.value == 401) {
            val body = transport.text(response)
            // Only the token this request was made with is dropped: a new sign-in may have happened meanwhile.
            if (secure.get(KEY_TOKEN) == token) {
                clearSession()
                mutableState.value = SessionState.SignedOut(server, expired = true)
            }
            throw errorFor(401, body, null)
        }
        if (failOnStatus && response.status.value !in 200..299) throw failure(response, transport.text(response))
        return response
    }

    private suspend fun unauthenticated(
        path: String,
        body: JsonObject,
    ): JsonObject {
        val server = serverUrl ?: throw KeptException(KeptErrorKind.NOT_KEPT, "Set the server address first.")
        val response = transport.send(HttpMethod.Post, server, path, jsonBody = body.toString())
        val text = transport.text(response)
        if (response.status.value !in 200..299) throw failure(response, text)
        return obj(text)
    }

    private fun signedIn(json: JsonObject): SessionUser {
        val token = json.string("token") ?: throw unexpected()
        val user = (json["user"] as? JsonObject)?.let { decode<SessionUser>(it.toString()) } ?: throw unexpected()
        val server = serverUrl ?: throw unexpected()
        pendingToken = null
        secure.set(KEY_TOKEN, token)
        remember(user)
        mutableState.value = SessionState.SignedIn(server, user)
        return user
    }

    private fun remember(user: SessionUser) {
        prefs.set(KEY_USER, KeptJson.encodeToString(user))
        val current = mutableState.value
        if (current is SessionState.SignedIn && current.user != user) {
            mutableState.value = current.copy(user = user)
        }
    }

    private fun clearSession() {
        pendingToken = null
        secure.set(KEY_BROWSER, null)
        secure.set(KEY_TOKEN, null)
        prefs.set(KEY_USER, null)
    }

    private suspend fun text(response: HttpResponse): String = transport.text(response)

    private fun failure(
        response: HttpResponse,
        body: String,
    ): KeptException = errorFor(response.status.value, body, response.headers[HttpHeaders.RetryAfter])

    private fun unexpected() = KeptException(KeptErrorKind.SERVER, "The server answered something this app does not understand.")

    private fun obj(text: String): JsonObject = parseObject(text) ?: throw unexpected()

    private inline fun <reified T> decode(text: String): T =
        try {
            KeptJson.decodeFromString<T>(text)
        } catch (e: Exception) {
            throw unexpected()
        }

    companion object {
        /** The scheme of the address the server's sign-in page sends the browser to when it is done. */
        const val BROWSER_CALLBACK_SCHEME = "ch.orellbuehler.kept"

        private const val KEY_SERVER = "server.url"
        private const val KEY_USER = "session.user"
        private const val KEY_TOKEN = "session.token"
        private const val KEY_BROWSER = "signin.browser"
    }
}

/** A query value of an address, as it stands: the values of the sign-in return need no decoding. */
internal fun queryValue(
    url: String,
    name: String,
): String? =
    url
        .substringAfter('?', "")
        .substringBefore('#')
        .split('&')
        .firstOrNull { it.startsWith("$name=") }
        ?.substringAfter('=')
        ?.takeIf { it.isNotEmpty() }

internal fun encodeForm(form: FormBody): String {
    val grouped = LinkedHashMap<String, MutableList<String>>()
    form.fields.forEach { (name, value) -> grouped.getOrPut(name) { mutableListOf() } += value }
    return buildJsonObject {
        grouped.forEach { (name, values) ->
            if (values.size == 1) {
                put(name, values[0])
            } else {
                put(name, buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
            }
        }
        form.files.forEach { file ->
            put(
                file.field,
                buildJsonObject {
                    put(
                        "\$file",
                        buildJsonObject {
                            put("name", file.name)
                            put("type", file.type)
                            put("base64", file.base64)
                        },
                    )
                },
            )
        }
    }.toString()
}

internal fun fieldErrors(data: JsonObject): Map<String, String> {
    val errors = data["errors"] as? JsonObject ?: return emptyMap()
    val out = LinkedHashMap<String, String>()
    errors.forEach { (field, value) ->
        val first = ((value as? JsonArray)?.firstOrNull() as? JsonPrimitive)?.contentOrNull
        if (first != null) out[field] = first
    }
    return out
}

/** The file name of a Content-Disposition header, `filename*=UTF-8''…` before `filename="…"`. */
internal fun fileName(disposition: String?): String? {
    if (disposition == null) return null
    Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(disposition)?.let {
        return percentDecode(it.groupValues[1].trim())
    }
    return Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)
        .find(disposition)
        ?.groupValues
        ?.get(1)
        ?.trim()
}

private fun percentDecode(value: String): String {
    val bytes = ArrayList<Byte>(value.length)
    var i = 0
    while (i < value.length) {
        val c = value[i]
        val hex = if (c == '%' && i + 2 < value.length) value.substring(i + 1, i + 3) else null
        val decoded = hex?.toIntOrNull(16)
        if (decoded != null) {
            bytes += decoded.toByte()
            i += 3
        } else {
            c.toString().encodeToByteArray().forEach { bytes += it }
            i++
        }
    }
    return bytes.toByteArray().decodeToString()
}
