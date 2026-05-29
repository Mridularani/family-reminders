// Family Reminders — Service Worker v2
const CACHE = 'family-reminders-v2';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// Handle push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'reminder',
      data: { url: data.url || '/', payload: data },
      actions: [
        { action: 'snooze', title: '⏰ Snooze 10 min' },
        { action: 'dismiss', title: '✕ Dismiss' }
      ],
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300]
    })
  );
});

// Handle notification click / action
self.addEventListener('notificationclick', e => {
  const action  = e.action;
  const data    = e.notification.data;
  e.notification.close();

  if (action === 'dismiss') return;

  if (action === 'snooze') {
    // Snooze: re-show notification after 10 minutes
    e.waitUntil(
      new Promise(resolve => {
        setTimeout(() => {
          const payload = data?.payload || {};
          self.registration.showNotification('⏰ ' + (payload.title || 'Reminder'), {
            body: payload.body || 'Snoozed reminder',
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: (payload.tag || 'reminder') + '-snoozed',
            data: { url: data?.url || '/', payload },
            actions: [
              { action: 'snooze', title: '⏰ Snooze 10 min' },
              { action: 'dismiss', title: '✕ Dismiss' }
            ],
            requireInteraction: true,
            vibrate: [300, 100, 300, 100, 300]
          });
          resolve();
        }, 10 * 60 * 1000); // 10 minutes
      })
    );
    return;
  }

  // Default tap — open the app
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(data?.url || '/');
    })
  );
});
