self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Kinsen IT Helpdesk", {
      body: data.body || "",
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      data: { link: data.link || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawLink = (event.notification.data && event.notification.data.link) || "/";

  event.waitUntil(
    (async () => {
      // Same-origin only — never navigate to (or trust) an arbitrary
      // externally-supplied URL, even though today's payload is always
      // server-generated. A malformed/foreign link silently falls back to
      // the app root rather than being followed.
      let target;
      try {
        const resolved = new URL(rawLink, self.location.origin);
        target = resolved.origin === self.location.origin ? resolved.href : self.location.origin + "/";
      } catch {
        target = self.location.origin + "/";
      }

      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });

      // Already on the exact page — just focus it, no navigation needed.
      for (const client of windows) {
        if (client.url === target && "focus" in client) {
          return client.focus();
        }
      }

      // Otherwise, navigate an existing TicketApp window to the ticket and
      // focus it — a stale "focus whatever tab happens to be open" is not
      // acceptable; the notification's own link must be honored.
      const navigable = windows.find((c) => "navigate" in c);
      if (navigable) {
        try {
          const navigated = await navigable.navigate(target);
          if (navigated && "focus" in navigated) return navigated.focus();
          if ("focus" in navigable) return navigable.focus();
        } catch {
          // navigate() can throw in some browsers/contexts — fall back to
          // just focusing the existing window rather than losing the click.
          if ("focus" in navigable) return navigable.focus();
        }
      }

      if (windows.length > 0 && "focus" in windows[0]) {
        return windows[0].focus();
      }

      if (clients.openWindow) return clients.openWindow(target);
    })()
  );
});
