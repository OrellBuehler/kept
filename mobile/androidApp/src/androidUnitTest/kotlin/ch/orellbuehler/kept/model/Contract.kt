package ch.orellbuehler.kept.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.io.File

/**
 * The page fixtures in `src/lib/testing/fixtures/app-contract/`: what the server answers (it writes them and checks its
 * pages against them, see src/routes/api/app/v1/contract.test.ts). Every model a screen decodes
 * a page into gets a test that decodes the matching fixture with the app's own decoder.
 */
object Contract {
    private val dir = File(System.getProperty("kept.contract.dir") ?: error("kept.contract.dir is not set"))

    /** The whole file: for `session`, `server` and `reminders`. */
    fun raw(name: String): String = File(dir, "$name.json").readText()

    /** The `data` object of a page fixture ("bills", "accounts.id.checking", …), as the SDK hands it to the app. */
    fun pageJson(name: String): String =
        Json
            .parseToJsonElement(raw(name))
            .jsonObject
            .getValue("data")
            .toString()

    inline fun <reified T> page(name: String): T = decodePage(pageJson(name))
}
