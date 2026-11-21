// Agent Hub's service worker (Ümit #13927, #13934): shows the bus's Web Push notifications while the website is closed,
// as a banner on the iPhone (Home Screen app) or a desktop notification, and opens the conversation on a tap.
// Plain JavaScript, served as is from the site's root so its scope is the whole site.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  /** @type {{title?: string, body?: string, url?: string, tag?: string}} */
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // Always shown: iPhones stop delivering to a site whose pushes show nothing.
  event.waitUntil(
    self.registration.showNotification(data.title || "Agent Hub", {
      body: data.body || "",
      tag: data.tag || "agent-hub",
      renotify: true,
      icon: "/logo-180.png?v=2",
      badge: "/logo-64.png?v=2",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "open", url });
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
