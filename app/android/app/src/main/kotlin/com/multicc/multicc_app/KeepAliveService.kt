package com.multicc.multicc_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground service whose only job is to keep the app PROCESS alive — and with
 * it the live WebSocket connections running in the Dart UI isolate — while
 * MultiCC is in the background.
 *
 * Android suspends/kills backgrounded processes aggressively, which is why a
 * plain backgrounded chat socket freezes until the next app resume. A
 * foreground service with an ongoing notification raises the process importance
 * so those sockets keep streaming instead. A PARTIAL_WAKE_LOCK additionally
 * keeps the CPU from sleeping the socket while the screen is off.
 *
 * This is opt-in (see the "后台保持连接" setting) precisely because the ongoing
 * notification + wake lock cost battery. It is started when the app goes to the
 * background with that setting on, and stopped on resume.
 */
class KeepAliveService : Service() {
    companion object {
        const val ACTION_STOP = "com.multicc.multicc_app.KEEPALIVE_STOP"
        private const val CHANNEL_ID = "multicc_keepalive"
        private const val NOTIFICATION_ID = 4711
        private const val WAKELOCK_TAG = "multicc:keepalive"
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        acquireWakeLock()
        // START_NOT_STICKY: if the OS reclaims us, the process (and the Dart
        // isolate holding the sockets) is gone too, so auto-recreating the
        // service would only show a "keeping connection" notification with
        // nothing behind it. Let it stay dead until the app is reopened.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(
            this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("MultiCC 正在后台保持连接")
            .setContentText("会话连接保持在线，点按返回应用")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "保持会话连接在后台存活"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }
}
