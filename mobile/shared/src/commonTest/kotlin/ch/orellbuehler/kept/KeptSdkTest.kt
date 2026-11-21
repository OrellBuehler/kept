package ch.orellbuehler.kept

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MemoryStore : KeyValueStore {
    val values = mutableMapOf<String, String>()

    override fun get(key: String): String? = values[key]

    override fun set(
        key: String,
        value: String?,
    ) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

private const val USER = """{"id":"u1","username":"alice","displayName":"Alice","role":"admin"}"""
private const val SERVER = """{"app":"kept","version":"0.6.0","apiLevel":1,"setupRequired":false}"""

class KeptSdkTest {
    private val secure = MemoryStore()
    private val prefs = MemoryStore()
    private val requests = mutableListOf<HttpRequestData>()

    private fun sdk(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): KeptSdk =
        KeptSdk(
            secure,
            prefs,
            engine =
                MockEngine { request ->
                    requests += request
                    handler(request)
                },
        )

    private fun MockRequestHandleScope.json(
        body: String,
        status: Int = 200,
        retryAfter: String? = null,
    ): HttpResponseData =
        respond(
            body,
            HttpStatusCode.fromValue(status),
            if (retryAfter == null) {
                headersOf(HttpHeaders.ContentType, "application/json")
            } else {
                headersOf(HttpHeaders.ContentType to listOf("application/json"), HttpHeaders.RetryAfter to listOf(retryAfter))
            },
        )

    private suspend fun signedIn(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): KeptSdk {
        val sdk =
            sdk { request ->
                when (request.url.encodedPath) {
                    "/api/app/v1/server" -> json(SERVER)
                    "/api/app/v1/auth/login" ->
                        json(
                            """{"status":"ok","token":"tok","expiresAt":"2030-01-01T00:00:00.000Z","user":$USER}""",
                        )
                    else -> handler(request)
                }
            }
        sdk.connect("kept.example.org")
        sdk.login("alice", "pw")
        return sdk
    }

    @Test
    fun normalizesWhatAUserTypes() {
        assertEquals("https://kept.example.org", normalizeServerUrl(" kept.example.org/ "))
        assertEquals("http://192.168.1.5:3000", normalizeServerUrl("http://192.168.1.5:3000/"))
        assertEquals("https://example.org/kept", normalizeServerUrl("HTTPS://Example.org/kept/?x=1#y"))
        assertNull(normalizeServerUrl(""))
        assertNull(normalizeServerUrl("two words"))
        assertNull(normalizeServerUrl("ftp://example.org"))
        assertNull(normalizeServerUrl("https://user:pw@example.org"))
    }

    @Test
    fun connectRemembersAKeptServer() =
        runTest {
            val sdk = sdk { json(SERVER) }
            assertIs<SessionState.NoServer>(sdk.state.value)
            val info = sdk.connect("kept.example.org/")
            assertEquals("0.6.0", info.version)
            assertEquals("https://kept.example.org/api/app/v1/server", requests.single().url.toString())
            assertEquals(SessionState.SignedOut("https://kept.example.org"), sdk.state.value)
            assertFalse(sdk.insecure)
        }

    @Test
    fun connectRefusesWhatIsNotKept() =
        runTest {
            for (body in listOf("<html>", """{"app":"other"}""", """{"app":"kept","apiLevel":0}""")) {
                val sdk = sdk { json(body) }
                val error = assertFailsWith<KeptException> { sdk.connect("example.org") }
                assertEquals(KeptErrorKind.NOT_KEPT, error.kind)
                assertIs<SessionState.NoServer>(sdk.state.value)
            }
            val sdk = sdk { json("""{"message":"Not found"}""", 404) }
            assertEquals(KeptErrorKind.NOT_KEPT, assertFailsWith<KeptException> { sdk.connect("example.org") }.kind)
        }

    @Test
    fun aServerThatCannotBeReachedIsANetworkError() =
        runTest {
            val sdk = sdk { throw IllegalStateException("no route") }
            assertEquals(KeptErrorKind.NETWORK, assertFailsWith<KeptException> { sdk.connect("example.org") }.kind)
        }

    @Test
    fun loginStoresTheTokenAndSurvivesARestart() =
        runTest {
            val sdk = signedIn { json("{}") }
            assertEquals("tok", secure.values["session.token"])
            assertEquals(
                """{"username":"alice","password":"pw"}""",
                requests
                    .last()
                    .body
                    .toByteArray()
                    .decodeToString(),
            )
            val state = sdk.state.value
            assertIs<SessionState.SignedIn>(state)
            assertEquals("Alice", state.user.label)
            assertTrue(state.user.isAdmin)

            val restarted = KeptSdk(secure, prefs, engine = MockEngine { respond("") })
            assertEquals(state, restarted.state.value)
        }

    @Test
    fun aSecondFactorIsAskedForBeforeTheSessionExists() =
        runTest {
            val sdk =
                sdk { request ->
                    when (request.url.encodedPath) {
                        "/api/app/v1/server" -> json(SERVER)
                        "/api/app/v1/auth/login" -> json("""{"status":"second_factor","pendingToken":"pend","totp":true}""")
                        else ->
                            if (request.body
                                    .toByteArray()
                                    .decodeToString()
                                    .contains("123456")
                            ) {
                                json("""{"status":"ok","token":"tok2","user":$USER}""")
                            } else {
                                json("""{"message":"That code is not valid."}""", 400)
                            }
                    }
                }
            sdk.connect("kept.example.org")
            assertEquals(LoginStep.CodeRequired(totp = true), sdk.login("alice", "pw"))
            assertIs<SessionState.SignedOut>(sdk.state.value)
            assertNull(secure.values["session.token"])

            val wrong = assertFailsWith<KeptException> { sdk.verifyCode("000000") }
            assertEquals("That code is not valid.", wrong.message)
            assertEquals("alice", sdk.verifyCode("123456").username)
            assertEquals("tok2", secure.values["session.token"])
            assertEquals(
                """{"pendingToken":"pend","code":"123456"}""",
                requests
                    .last()
                    .body
                    .toByteArray()
                    .decodeToString(),
            )
        }

    @Test
    fun aWrongPasswordAndARateLimitCarryTheServersWords() =
        runTest {
            var status = 401
            val sdk =
                sdk { request ->
                    if (request.url.encodedPath.endsWith("/server")) {
                        json(SERVER)
                    } else {
                        json("""{"message":"Nope."}""", status, retryAfter = "30")
                    }
                }
            sdk.connect("kept.example.org")
            val refused = assertFailsWith<KeptException> { sdk.login("alice", "x") }
            assertEquals(KeptErrorKind.UNAUTHORIZED, refused.kind)
            assertEquals("Nope.", refused.message)
            status = 429
            val limited = assertFailsWith<KeptException> { sdk.login("alice", "x") }
            assertEquals(KeptErrorKind.RATE_LIMITED, limited.kind)
            assertEquals(30, limited.retryAfterSeconds)
        }

    @Test
    fun pagesSendTheTokenAndReturnTheDataObject() =
        runTest {
            val sdk = signedIn { json("""{"data":{"month":"2026-03","list":[1]}}""") }
            val page = sdk.page("budgets", mapOf("month" to "2026-03"))
            assertEquals("""{"month":"2026-03","list":[1]}""", page.json)
            assertNull(page.redirect)
            val request = requests.last()
            assertEquals("https://kept.example.org/api/app/v1/pages/budgets?month=2026-03", request.url.toString())
            assertEquals("Bearer tok", request.headers[HttpHeaders.Authorization])
        }

    @Test
    fun aPageThatRedirectsSaysWhere() =
        runTest {
            val sdk = signedIn { json("""{"redirect":"/import/p1/mapping"}""") }
            assertEquals(PageResponse(null, "/import/p1/mapping"), sdk.page("import/p1"))
        }

    @Test
    fun anEndedSessionSignsTheDeviceOut() =
        runTest {
            val sdk = signedIn { json("""{"message":"The session has ended. Sign in again."}""", 401) }
            val error = assertFailsWith<KeptException> { sdk.page("bills") }
            assertEquals(KeptErrorKind.UNAUTHORIZED, error.kind)
            assertEquals(SessionState.SignedOut("https://kept.example.org", expired = true), sdk.state.value)
            assertNull(secure.values["session.token"])
        }

    @Test
    fun actionsPostTheFormAsJson() =
        runTest {
            val sdk = signedIn { json("""{"ok":true,"data":{"success":true},"redirect":"/bills/b1"}""") }
            val form =
                FormBody()
                    .set("amount", "12.50")
                    .set("skipped", null)
                    .check("shared", true)
                    .check("archived", false)
                    .add("tag", "a")
                    .add("tag", "b")
                    .file("file", "bill.pdf", "application/pdf", "QUJD")
            val result = sdk.action("bills/new", "create", form, mapOf("from" to "x"))
            assertTrue(result.ok)
            assertEquals("/bills/b1", result.redirect)
            assertEquals("""{"success":true}""", result.json)
            val request = requests.last()
            assertEquals("https://kept.example.org/api/app/v1/pages/bills/new?from=x&_action=create", request.url.toString())
            assertEquals(
                """{"amount":"12.50","shared":"on","tag":["a","b"],"file":{"${'$'}file":{"name":"bill.pdf","type":"application/pdf","base64":"QUJD"}}}""",
                request.body.toByteArray().decodeToString(),
            )
        }

    @Test
    fun aRefusedFormIsAResultWithFieldErrors() =
        runTest {
            val sdk =
                signedIn {
                    json(
                        """{"ok":false,"message":"Enter an amount.","data":{"errors":{"amount":["Enter an amount.","x"],"form":["No."]}}}""",
                        400,
                    )
                }
            val result = sdk.action("budgets", "createBudget")
            assertFalse(result.ok)
            assertEquals("Enter an amount.", result.message)
            assertEquals(mapOf("amount" to "Enter an amount.", "form" to "No."), result.fieldErrors)
        }

    @Test
    fun anActionThatFailsOutrightThrows() =
        runTest {
            val sdk = signedIn { json("""{"message":"Bill not found."}""", 404) }
            val error = assertFailsWith<KeptException> { sdk.action("bills/x", "delete") }
            assertEquals(KeptErrorKind.NOT_FOUND, error.kind)
            assertEquals("Bill not found.", error.message)
        }

    @Test
    fun downloadsCarryTypeAndName() =
        runTest {
            val sdk =
                signedIn {
                    respond(
                        "%PDF",
                        HttpStatusCode.OK,
                        headersOf(
                            HttpHeaders.ContentType to listOf("application/pdf"),
                            HttpHeaders.ContentDisposition to listOf("inline; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf"),
                        ),
                    )
                }
            val file = sdk.download("bills/b1/document")
            assertEquals("application/pdf", file.contentType)
            assertEquals("Rechnung März.pdf", file.fileName)
            assertEquals("%PDF", file.bytes.decodeToString())
            assertEquals("report.pdf", fileName("attachment; filename=\"report.pdf\""))
        }

    @Test
    fun logoutAndDisconnectForget() =
        runTest {
            val sdk = signedIn { json("""{"ok":true}""") }
            sdk.logout()
            assertEquals("/api/app/v1/auth/logout", requests.last().url.encodedPath)
            assertEquals(SessionState.SignedOut("https://kept.example.org"), sdk.state.value)
            assertNull(secure.values["session.token"])
            sdk.disconnect()
            assertIs<SessionState.NoServer>(sdk.state.value)
            assertTrue(prefs.values.isEmpty())
        }
}
