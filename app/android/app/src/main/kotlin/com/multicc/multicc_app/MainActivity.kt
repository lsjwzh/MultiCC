package com.multicc.multicc_app

import android.content.Intent
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.multicc.multicc_app/keepalive"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        startKeepAlive()
                        result.success(true)
                    }
                    "stop" -> {
                        stopKeepAlive()
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun startKeepAlive() {
        val intent = Intent(this, KeepAliveService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (_: Exception) {
            // Keep-alive is best-effort. Some OS states (e.g. a strict
            // background-start window) reject the start with an exception —
            // never crash the app over it.
        }
    }

    private fun stopKeepAlive() {
        try {
            stopService(Intent(this, KeepAliveService::class.java))
        } catch (_: Exception) {
        }
    }
}
