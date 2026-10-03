package com.multicc.multicc_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// Shared display path for socket and FCM events. It also runs with no Flutter
// engine, so local preferences and server binding are checked before display.
object TaskNotifications {
    @Volatile var foreground = false
    @Volatile var activeSession = ""
    private val recent = mutableMapOf<String, Long>()
    fun prefs(context: Context) = context.getSharedPreferences("multicc_push", Context.MODE_PRIVATE)

    @Synchronized
    fun show(context: Context, data: Map<String, String>, remote: Boolean): Boolean {
        try {
            val prefs = prefs(context)
            val binding = prefs.getString("binding", "") ?: ""
            val session = data["sessionId"] ?: ""
            if (!PushNotificationPolicy.allows(prefs.getBoolean("enabled", false), binding, data["binding"],
                remote, session, prefs.getStringSet("disabledSessions", emptySet()) ?: emptySet(),
                foreground, activeSession)) return false
            val manager = NotificationManagerCompat.from(context)
            if (!manager.areNotificationsEnabled()) return false
            val now = System.currentTimeMillis()
            val key = "$binding:$session"
            if (now - (recent[key] ?: 0) < 6000) return false
            // Persist event ids to suppress FCM redelivery across process death.
            val event = data["eventId"] ?: ""
            val events = prefs.getStringSet("events", emptySet()) ?: emptySet()
            if (event.isNotEmpty() && events.contains(event)) return false
            if (Build.VERSION.SDK_INT >= 26) {
                val system = context.getSystemService(NotificationManager::class.java)
                system.createNotificationChannel(NotificationChannel("multicc_tasks", "MultiCC tasks", NotificationManager.IMPORTANCE_HIGH))
            }
            val intent = Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("multicc_session", session).putExtra("multicc_binding", binding)
            val pending = PendingIntent.getActivity(context, key.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val body = (data["body"] ?: "").take(600)
            val notification = NotificationCompat.Builder(context, "multicc_tasks")
                .addExtras(android.os.Bundle().apply { putBoolean("multicc_task", true) })
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle((data["title"] ?: "MultiCC").take(120)).setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setDefaults(NotificationCompat.DEFAULT_SOUND)
                .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true)
                .setContentIntent(pending).build()
            manager.notify(key.hashCode(), notification)
            recent.entries.removeAll { now - it.value >= 6000 }
            recent[key] = now
            if (event.isNotEmpty()) prefs.edit().putStringSet("events", (events.toList().takeLast(63) + event).toSet()).apply()
            return true
        } catch (_: Exception) { return false }
    }
}
