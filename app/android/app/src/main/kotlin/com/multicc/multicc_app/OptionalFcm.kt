package com.multicc.multicc_app

/** Android-independent failure boundary, exercised on the JVM without GMS. */
object OptionalFcm {
    fun initialize(configured: Boolean, hasGoogleServices: () -> Boolean, initialize: () -> Unit): String {
        if (!configured) return "not_configured"
        return try {
            if (!hasGoogleServices()) "no_play_services"
            else { initialize(); "ready" }
        } catch (_: Exception) { "unavailable" }
        catch (_: LinkageError) { "unavailable" }
    }
}

object PushNotificationPolicy {
    fun allows(enabled: Boolean, binding: String, incomingBinding: String?, remote: Boolean,
        session: String, disabled: Set<String>, foreground: Boolean, activeSession: String): Boolean {
        if (remote && (binding.isEmpty() || incomingBinding != binding)) return false
        if (!enabled || disabled.contains(session)) return false
        return !(foreground && session.isNotEmpty() && session == activeSession)
    }
}
