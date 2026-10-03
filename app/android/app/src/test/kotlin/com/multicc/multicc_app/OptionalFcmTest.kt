package com.multicc.multicc_app

import org.junit.Assert.*
import org.junit.Test

class OptionalFcmTest {
    @Test fun missingConfigurationDoesNotTouchGoogle() {
        assertEquals("not_configured", OptionalFcm.initialize(false, { error("GMS queried") }, { error("Firebase initialized") }))
    }
    @Test fun domesticPhoneWithoutGmsSkipsFirebase() {
        assertEquals("no_play_services", OptionalFcm.initialize(true, { false }, { error("Firebase initialized") }))
    }
    @Test fun brokenGoogleServicesNeverEscapesToActivity() {
        assertEquals("unavailable", OptionalFcm.initialize(true, { throw SecurityException() }, {}))
        assertEquals("unavailable", OptionalFcm.initialize(true, { throw NoClassDefFoundError() }, {}))
    }
    @Test fun firebaseInitializationFailureIsOptional() {
        assertEquals("unavailable", OptionalFcm.initialize(true, { true }, { throw IllegalStateException() }))
        assertEquals("unavailable", OptionalFcm.initialize(true, { true }, { throw NoSuchMethodError() }))
    }
    @Test fun validGoogleServicesCanInitialize() {
        var initialized = false
        assertEquals("ready", OptionalFcm.initialize(true, { true }, { initialized = true }))
        assertTrue(initialized)
    }
    @Test fun killedProcessCanNotifyButOldServerAndMutedSessionsCannot() {
        fun allowed(binding: String = "current", enabled: Boolean = true, muted: Set<String> = emptySet(), foreground: Boolean = false) =
            PushNotificationPolicy.allows(enabled, "current", binding, true, "s1", muted, foreground, "s1")
        assertTrue(allowed())
        assertFalse(allowed(binding = "old-server"))
        assertFalse(allowed(enabled = false))
        assertFalse(allowed(muted = setOf("s1")))
        assertFalse(allowed(foreground = true))
        assertFalse(PushNotificationPolicy.allows(true, "", "", true, "s1", emptySet(), false, ""))
    }
}
