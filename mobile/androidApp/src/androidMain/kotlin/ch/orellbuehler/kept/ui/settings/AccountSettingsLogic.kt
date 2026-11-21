package ch.orellbuehler.kept.ui.settings

/** What the server requires of a password (`PASSWORD_MIN` and `PASSWORD_MAX`). */
const val PASSWORD_MIN = 10
const val PASSWORD_MAX = 256

/** What the change password form holds. */
data class PasswordFormValues(
    val current: String = "",
    val new: String = "",
    val confirm: String = "",
) {
    /** True once the confirmation was typed and differs from the new password. */
    fun mismatch(touched: Boolean): Boolean = touched && confirm != new

    fun tooShort(): Boolean = new.isNotEmpty() && new.length < PASSWORD_MIN

    /** Everything is filled in, the new password is long enough and confirmed. */
    fun ready(): Boolean = current.isNotEmpty() && new.length >= PASSWORD_MIN && confirm == new

    /** The fields of `changePassword`; the confirmation stays on the phone. */
    fun fields(): List<Pair<String, String>> = listOf("currentPassword" to current, "newPassword" to new)
}
