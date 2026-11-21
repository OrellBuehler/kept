package ch.orellbuehler.kept.data

import ch.orellbuehler.kept.KeptErrorKind
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** Decoder for page data: fields the app does not know are ignored, so the server may add some. */
val ApiJson =
    Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
        coerceInputValues = true
    }

/** A page answered with a redirect instead of data; [location] is the web path it points to. */
class PageRedirect(
    val location: String,
) : Exception("The page moved to $location")

/** Loads a page of `/api/app/v1/pages/` and decodes its data. */
suspend inline fun <reified T> KeptSdk.load(
    path: String,
    query: Map<String, String> = emptyMap(),
): T {
    val page = page(path, query)
    val json = page.json ?: throw PageRedirect(page.redirect.orEmpty())
    return decodePage(json)
}

inline fun <reified T> decodePage(json: String): T =
    try {
        ApiJson.decodeFromString<T>(json)
    } catch (e: SerializationException) {
        throw KeptException(
            KeptErrorKind.SERVER,
            "The server answered something this app does not understand. Update the app or the server.",
        )
    }
