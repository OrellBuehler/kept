package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/reports`: what the report forms need. The PDFs come from `endpoints/reports/<kind>`. */
@Serializable
data class ReportsPage(
    val today: String = "",
    val hasShared: Boolean = false,
    val accounts: List<ReportAccount> = emptyList(),
)

@Serializable
data class ReportAccount(
    val id: String,
    val name: String = "",
    val currency: String = "",
    val iban: String? = null,
    val archived: Boolean = false,
)
