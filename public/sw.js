'use strict';

const CACHE_NAME = 'multicc-v1';

// Push notification received
self.addEventListener('push', (event) => {
  let title = 'MultiCC';
  let options = {
    body: 'New notification',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'multicc-general',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: '/manage' },
  };

  try {
    if (!event.data) return;

    let payload;
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { title: 'MultiCC', body: event.data.text() };
    }

    title = payload.title || 'MultiCC';
    options = {
      body: payload.body || payload.message || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: payload.tag || `multicc-${payload.sessionId || 'general'}`,
      renotify: true,
      vibrate: [200, 100, 200],
      data: {
        sessionId: payload.sessionId,
        type: payload.type,
        url: payload.url || '/manage',
      },
      actions: [],
    };

    // Add actions based on notification type
    if (payload.type === 'waiting') {
      options.actions = [
        { action: 'open', title: 'Open Session' },
      ];
    } else if (payload.type === 'completed') {
      options.actions = [
        { action: 'open', title: 'View' },
        { action: 'dismiss', title: 'OK' },
      ];
    }
  } catch (err) {
    // Fallback: show a generic notification on any parse error
    console.error('[sw] Push parse error:', err);
    title = 'MultiCC';
    options.body = 'New notification (tap to open)';
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const data = event.notification.data || {};
  const targetUrl = data.url || '/manage';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      let targetPath = '/manage';
      try {
        targetPath = new URL(targetUrl, self.location.origin).pathname;
      } catch (_) {}

      // Try to focus an existing window for the target page first.
      for (const client of clientList) {
        let clientPath = '';
        try { clientPath = new URL(client.url).pathname; } catch (_) {}
        if (clientPath === targetPath && 'focus' in client) {
          client.focus();
          // Post message to focus the session
          if (data.sessionId) {
            client.postMessage({
              type: 'focus-session',
              sessionId: data.sessionId,
            });
          }
          return;
        }
      }
      // No existing window — open new one
      return clients.openWindow(targetUrl);
    })
  );
});

// Handle push subscription changes (browser rotated the subscription)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    Promise.resolve().then(async () => {
      try {
        // Re-subscribe with the same options
        const newSub = await self.registration.pushManager.subscribe(
          event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true }
        );

        // Send new subscription to server
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newSub.toJSON()),
        });

        // Remove old subscription from server
        if (event.oldSubscription) {
          await fetch('/api/push/subscribe', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
          });
        }

        console.log('[sw] Push subscription rotated successfully');
      } catch (err) {
        console.error('[sw] pushsubscriptionchange failed:', err);
      }
    })
  );
});

// Periodic sync: validate push subscription (Chromium only, progressive enhancement)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'push-validate') {
    event.waitUntil(
      self.registration.pushManager.getSubscription().then(sub => {
        if (!sub) {
          // Subscription lost — notify any open clients to re-subscribe
          return self.clients.matchAll({ type: 'window' }).then(clients => {
            for (const client of clients) {
              client.postMessage({ type: 'push-resubscribe' });
            }
          });
        }
      }).catch(err => console.error('[sw] Periodic push validate failed:', err))
    );
  }
});

// Service worker install — cache essential assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Service worker activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});
