package com.multicc.multicc_app

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

class FcmBridge(private val context: Context, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "com.multicc.multicc_app/fcm")
    private var pendingTap: Map<String, String>? = null
    private var ready = false

    init {
        channel.setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "sync" -> {
                        val binding = call.argument<String>("binding") ?: ""
                        val prefs = TaskNotifications.prefs(context)
                        val changed = prefs.getString("binding", "") != binding
                        val edit = prefs.edit().putString("binding", binding)
                            .putString("endpoint", call.argument<String>("endpoint") ?: "")
                            .putString("access", call.argument<String>("access") ?: "")
                            .putString("deviceId", call.argument<String>("deviceId") ?: "")
                            .putString("locale", call.argument<String>("locale") ?: "zh")
                            .putBoolean("enabled", call.argument<Boolean>("enabled") == true)
                            .putStringSet("disabledSessions", (call.argument<List<String>>("disabledSessions") ?: emptyList()).toSet())
                        if (changed) edit.remove("events")
                        edit.apply()
                        if (changed || call.argument<Boolean>("enabled") != true) {
                            // Remove old-server notifications when switching/logout.
                            val manager = context.getSystemService(android.app.NotificationManager::class.java)
                            manager.activeNotifications.filter { (android.os.Build.VERSION.SDK_INT >= 26 &&
                                it.notification.channelId == "multicc_tasks") ||
                                it.notification.extras.containsKey("multicc_task") }.forEach { manager.cancel(it.id) }
                        }
                        TaskNotifications.activeSession = call.argument<String>("activeSession") ?: ""
                        ready = true
                        pendingTap?.let { channel.invokeMethod("tap", it) }; pendingTap = null
                        result.success(true)
                    }
                    "token" -> {
                        val state = initialize(context)
                        if (state != "ready") result.success(mapOf("status" to state))
                        else {
                            // Both Dart and native callers have a deadline. Never await
                            // Google networking on the Activity startup path.
                            val handler = Handler(Looper.getMainLooper())
                            var finished = false
                            val timeout = Runnable {
                                if (!finished) { finished = true; result.success(mapOf("status" to "unavailable")) }
                            }
                            handler.postDelayed(timeout, 8000)
                            try { FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                                if (!finished) {
                                    finished = true; handler.removeCallbacks(timeout)
                                    if (task.isSuccessful) result.success(mapOf("status" to "ready", "token" to task.result,
                                        "projectId" to context.getString(R.string.multicc_fcm_project_id)))
                                    else result.success(mapOf("status" to "unavailable"))
                                }
                            } } catch (_: Exception) {
                                if (!finished) { finished = true; handler.removeCallbacks(timeout)
                                    result.success(mapOf("status" to "unavailable")) }
                            } catch (_: LinkageError) {
                                if (!finished) { finished = true; handler.removeCallbacks(timeout)
                                    result.success(mapOf("status" to "unavailable")) }
                            }
                        }
                    }
                    "show" -> {
                        val values = call.arguments as? Map<*, *> ?: emptyMap<String, String>()
                        val data = values.entries.associate { it.key.toString() to it.value.toString() }
                        TaskNotifications.show(context, data, false)
                        result.success(true) // Handled; suppressed notifications must not fall back.
                    }
                    else -> result.notImplemented()
                }
            } catch (_: Exception) { result.success(mapOf("status" to "unavailable")) }
            catch (_: LinkageError) { result.success(mapOf("status" to "unavailable")) }
        }
    }

    fun tap(intent: Intent?) {
        val session = intent?.getStringExtra("multicc_session") ?: return
        val data = mapOf("sessionId" to session, "binding" to (intent.getStringExtra("multicc_binding") ?: ""))
        intent.removeExtra("multicc_session")
        if (ready) channel.invokeMethod("tap", data) else pendingTap = data
    }

    companion object {
        fun initialize(context: Context): String {
            try {
                val appId = context.getString(R.string.multicc_fcm_app_id)
                val key = context.getString(R.string.multicc_fcm_api_key)
                val project = context.getString(R.string.multicc_fcm_project_id)
                val sender = context.getString(R.string.multicc_fcm_sender_id)
                return OptionalFcm.initialize(appId.isNotBlank() && key.isNotBlank() && project.isNotBlank() && sender.isNotBlank(), {
                    GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
                }) {
                    if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
                        FirebaseApp.initializeApp(context, FirebaseOptions.Builder().setApplicationId(appId)
                            .setApiKey(key).setProjectId(project).setGcmSenderId(sender).build())
                    }
                }
            } catch (_: Exception) { return "unavailable" }
            catch (_: LinkageError) { return "unavailable" }
        }
    }
}
