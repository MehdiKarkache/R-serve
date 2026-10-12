// Service Worker de Réserve.
importScripts("/vendor/idb.js", "/shared/db.js", "/shared/sync.js");

// Remplacé au build par scripts/build.mjs : version = empreinte du contenu, precache = l'App Shell.
const BUILD = { version: "dev", precache: [] };
const CACHE_NAME = `reserve-${BUILD.version}`;
const OFFLINE_URL = "/offline.html";

// Installation : tout l'App Shell (HTML, CSS, JS, guide, icônes) d'un coup, dans un cache versionné.
// Pas de skipWaiting ici : la nouvelle version attend que l'utilisateur l'accepte (bannière, js/pwa.js).
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(BUILD.precache.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (!response.ok) throw new Error(`Précache impossible : ${url} (${response.status})`);
      // Une réponse redirigée ne peut pas servir une navigation : on la recopie sans l'indicateur de redirection.
      const clean = response.redirected
        ? new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers })
        : response;
      await cache.put(url, clean);
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("reserve-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Réseau seul pour l'API : les données de l'utilisateur vivent dans IndexedDB, pas dans le cache HTTP.
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(request.mode === "navigate" ? navigation(request) : cacheFirst(request));
});

// Pages : Cache First sur le shell versionné. HTML, CSS et JS d'une même version arrivent toujours ensemble.
// ignoreSearch : /?filtre=urgent ou /?foyer=… sont servis par le même index.html.
async function navigation(request) {
  const cached = await caches.match(request, { ignoreSearch: true, cacheName: CACHE_NAME });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response("Ressource indisponible hors ligne", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

// Background Sync (Chrome, Edge) : vide l'outbox au retour du réseau, même si l'application est fermée.
// Si syncAll échoue (réseau encore instable), la promesse rejetée demande au navigateur de réessayer plus tard.
self.addEventListener("sync", (event) => {
  if (event.tag === self.ReserveSync.SYNC_TAG) event.waitUntil(self.ReserveSync.syncAll("background-sync"));
});

// Rappel de péremption envoyé par le serveur (fonction planifiée ou bouton « Tester »).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title ?? "Réserve", {
      body: data.body ?? "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag ?? "reserve",
      data: { url: data.url ?? "/" },
    });
    if (typeof data.count === "number" && "setAppBadge" in self.navigator) {
      await (data.count > 0 ? self.navigator.setAppBadge(data.count) : self.navigator.clearAppBadge()).catch(() => {});
    }
  })());
});

// Clic : on réutilise une fenêtre de l'application si elle existe, sinon on en ouvre une.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return existing.navigate(target).catch(() => existing);
    }
    return self.clients.openWindow(target);
  })());
});

// Le service push a renouvelé l'abonnement : on le redonne au serveur, sans quoi les rappels s'arrêteraient.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const keyResponse = await fetch("/api/push/key");
    if (!keyResponse.ok) return;
    const { publicKey } = await keyResponse.json();
    const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
    const raw = atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(raw, (char) => char.charCodeAt(0)),
    });
    await self.ReserveSync.api("/api/push/subscription", { method: "PUT", body: { subscription: subscription.toJSON() } });
  })());
});
