/**
 * knomad service worker — the delivery half of Web Push.
 *
 * Notifications are sent by the knomadsync Function, which signs them with
 * VAPID and encrypts the payload for this browser's subscription. The worker
 * only renders what arrived and routes a click back into the app, so it never
 * needs the database, a token, or any knomad state of its own.
 *
 * There is deliberately no `fetch` handler: the app is a normal online SPA and
 * a cached shell would only serve stale documents.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    const text = event.data.text();
    return text ? { body: text } : {};
  }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'knomad';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    // A tag replaces the previous notification from the same thread, so a
    // burst of replies leaves one line instead of a stack.
    tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : undefined,
    renotify: Boolean(payload.tag),
    data: {
      url: typeof payload.url === 'string' && payload.url ? payload.url : '/',
      kind: typeof payload.kind === 'string' ? payload.kind : ''
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(client.url).origin === self.location.origin;
      } catch (err) {
        sameOrigin = false;
      }
      if (!sameOrigin) continue;
      if (typeof client.focus === 'function') {
        // An open tab is reused and told where to go instead of being replaced.
        client.postMessage({ type: 'knomad:open', url: target });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

/**
 * Chrome rotates a subscription now and then. The app re-registers it on the
 * next load; this just asks any open tab to do it immediately.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'knomad:resubscribe' });
    }
  })());
});
