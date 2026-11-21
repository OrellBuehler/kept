package ch.orellbuehler.kept

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.readRawBytes
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.URLBuilder
import io.ktor.http.appendPathSegments
import io.ktor.http.contentType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

internal const val API_PREFIX = "api/app/v1"

internal val KeptJson =
    Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
    }

internal class Transport(
    engine: HttpClientEngine,
    private val userAgent: String,
) {
    private val client =
        HttpClient(engine) {
            expectSuccess = false
            followRedirects = false
            install(HttpTimeout) {
                connectTimeoutMillis = 15_000
                requestTimeoutMillis = 90_000
                socketTimeoutMillis = 90_000
            }
        }

    /** Sends a request and returns the response whatever its status; only transport failures throw. */
    suspend fun send(
        method: HttpMethod,
        baseUrl: String,
        path: String,
        query: Map<String, String> = emptyMap(),
        token: String? = null,
        jsonBody: String? = null,
    ): HttpResponse {
        val url =
            URLBuilder(baseUrl)
                .apply {
                    appendPathSegments(API_PREFIX.split("/") + path.split("/").filter { it.isNotEmpty() })
                    query.forEach { (key, value) -> parameters.append(key, value) }
                }.build()
        try {
            return client.request(url) {
                this.method = method
                header(HttpHeaders.Accept, "application/json")
                header(HttpHeaders.UserAgent, userAgent)
                if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
                if (jsonBody != null) {
                    contentType(ContentType.Application.Json)
                    setBody(jsonBody)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw KeptException(KeptErrorKind.NETWORK, "The server could not be reached.")
        }
    }

    suspend fun text(response: HttpResponse): String =
        try {
            response.bodyAsText()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw KeptException(KeptErrorKind.NETWORK, "The connection was interrupted.")
        }

    suspend fun bytes(response: HttpResponse): ByteArray =
        try {
            response.readRawBytes()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw KeptException(KeptErrorKind.NETWORK, "The connection was interrupted.")
        }
}

internal fun parseObject(text: String): JsonObject? =
    try {
        KeptJson.parseToJsonElement(text) as? JsonObject
    } catch (e: Exception) {
        null
    }

internal fun JsonObject.string(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

/** The error a non-2xx response stands for; the body is `{ "message": … }` on a Kept server. */
internal fun errorFor(
    status: Int,
    body: String,
    retryAfter: String?,
): KeptException {
    val message = parseObject(body)?.get("message")?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
    val kind =
        when {
            status == 401 -> KeptErrorKind.UNAUTHORIZED
            status == 403 -> KeptErrorKind.FORBIDDEN
            status == 404 -> KeptErrorKind.NOT_FOUND
            status == 429 -> KeptErrorKind.RATE_LIMITED
            status in 400..499 -> KeptErrorKind.REJECTED
            else -> KeptErrorKind.SERVER
        }
    val fallback =
        when (kind) {
            KeptErrorKind.UNAUTHORIZED -> "Sign in to continue."
            KeptErrorKind.FORBIDDEN -> "You are not allowed to do this."
            KeptErrorKind.NOT_FOUND -> "Not found."
            KeptErrorKind.RATE_LIMITED -> "Too many attempts. Try again later."
            KeptErrorKind.REJECTED -> "The request could not be completed."
            else -> "The server reported an error ($status)."
        }
    return KeptException(kind, message ?: fallback, status, retryAfter?.toIntOrNull())
}

/**
 * The address as the user may type it ("kept.example.org", "http://192.168.1.5:3000/") as a base URL:
 * https unless a scheme is given, no trailing slash, no query. Null when it is not an address.
 */
fun normalizeServerUrl(input: String): String? {
    val trimmed = input.trim()
    if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
    val withScheme = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(trimmed)) trimmed else "https://$trimmed"
    val match = Regex("^(https?)://([^/?#]+)([^?#]*)", RegexOption.IGNORE_CASE).find(withScheme) ?: return null
    val (scheme, authority, path) = match.destructured
    if (authority.isEmpty() || authority.contains('@')) return null
    return "${scheme.lowercase()}://${authority.lowercase()}${path.trimEnd('/')}"
}
