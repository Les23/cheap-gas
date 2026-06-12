// CheapGas service worker — handles push notifications only (no offline caching,
// so the app always loads fresh).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { /* non-JSON push */ }
  e.waitUntil(self.registration.showNotification(data.title || 'CheapGas', {
    body: data.body || '',
    icon: 'icon.svg',
    badge: 'icon.svg',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) return c.focus();
    }
    return self.clients.openWindow(e.notification.data?.url || '/');
  }));
});
