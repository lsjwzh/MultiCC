package com.multicc.multicc_app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class MulticcMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        super.onCreate()
        FcmBridge.initialize(this)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        TaskNotifications.show(this, message.data, true)
    }

    override fun onNewToken(token: String) {
        // Firebase invokes this on its worker, never on the Activity UI thread.
        FcmRegistration.tokenChanged(this, token)
    }
}
