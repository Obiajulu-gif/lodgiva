/**
 * Push handler injected into the generated service worker.
 *
 * Kept deliberately small: it renders the notification and routes a click.
 * Anything requiring auth happens in the page, not here — the worker has no
 * session and must not try to fetch protected data.
 */
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Lodgiva", body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Lodgiva", {
      body: payload.body ?? "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      // Re-assigning the same task replaces the old notification instead of
      // stacking a second one on the lock screen.
      tag: payload.tag,
      renotify: true,
      data: { url: payload.url ?? "/board" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/board";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing tab rather than opening a duplicate.
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
