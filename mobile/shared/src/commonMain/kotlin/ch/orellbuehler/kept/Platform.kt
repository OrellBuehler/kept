package ch.orellbuehler.kept

import io.ktor.client.engine.HttpClientEngine

internal expect fun defaultEngine(): HttpClientEngine
