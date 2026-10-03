package com.multicc.multicc_app

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Token rotation can happen without Flutter running. Use the saved current
 * connection, with hard network deadlines and no redirects or credential logs.
 * Normal foreground/resume retries remain owned by Dart. */
object FcmRegistration {
    fun tokenChanged(context: Context, token: String) {
        val prefs = TaskNotifications.prefs(context)
        if (!prefs.getBoolean("enabled", false)) return
        val endpoint = prefs.getString("endpoint", "") ?: ""
        val access = prefs.getString("access", "") ?: ""
        val binding = prefs.getString("binding", "") ?: ""
        val id = prefs.getString("deviceId", "") ?: ""
        if (endpoint.isEmpty() || binding.isEmpty() || id.isEmpty()) return
        val body = JSONObject().put("id", id).put("binding", binding).put("token", token)
            .put("projectId", context.getString(R.string.multicc_fcm_project_id))
            .put("locale", prefs.getString("locale", "zh"))
        request(endpoint, access, "POST", body)
        if (prefs.getString("binding", "") != binding || !prefs.getBoolean("enabled", false)) {
            request(endpoint, access, "DELETE", JSONObject().put("id", id).put("binding", binding))
        }
    }

    private fun request(endpoint: String, access: String, method: String, body: JSONObject) {
        var connection: HttpURLConnection? = null
        try {
            val url = URL(endpoint)
            if (url.protocol != "https" && url.protocol != "http") return
            connection = url.openConnection() as HttpURLConnection
            connection.connectTimeout = 5000
            connection.readTimeout = 5000
            connection.instanceFollowRedirects = false
            connection.requestMethod = method
            connection.setRequestProperty("Content-Type", "application/json")
            if (access.isNotEmpty()) connection.setRequestProperty("X-Access-Token", access)
            connection.doOutput = true
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            connection.responseCode // Acceptance only; do not log any response.
        } catch (_: Exception) { /* Offline / rejected: resume will retry. */ }
        finally { connection?.disconnect() }
    }
}
