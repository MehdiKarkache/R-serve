// Synchronisation : vider l'outbox vers le serveur, puis récupérer les changements des autres appareils du foyer.
// Script classique partagé : la page l'appelle (repli « online », démarrage), le Service Worker aussi (Background Sync).
(function (scope) {
  const db = scope.ReserveDB;
  const SYNC_TAG = "reserve-sync";
  const PULL_OVERLAP_MS = 60_000; // on relit la dernière minute : une écriture en cours pendant la lecture n'est pas manquée
  const channel = "BroadcastChannel" in scope ? new BroadcastChannel("reserve") : null;

  const ITEM_FIELDS = ["name", "quantity", "unit", "location", "expiresOn", "barcode", "photo", "createdAt", "updatedAt"];
  const toServer = (item) => Object.fromEntries(ITEM_FIELDS.map((field) => [field, item[field] ?? null]));

  async function api(path, { method = "GET", headers = {}, body } = {}) {
    const { foyerId, deviceId } = await db.getIdentity();
    return fetch(path, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${foyerId}`,
        "X-Device-Id": deviceId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** 410 Gone : le foyer a été effacé depuis un autre appareil. Cet appareil efface alors sa copie. */
  class FoyerErased extends Error {}
  function checkErased(response) {
    if (response.status === 410) throw new FoyerErased("Ce foyer a été supprimé");
  }

  /** Une réponse 5xx ou une coupure réseau lève une erreur : l'outbox reste intacte et on réessaiera. */
  async function handleResponse(entry, response) {
    checkErased(response);
    if (response.ok) {
      await db.acknowledge(entry, await response.json());
      return "sent";
    }
    if (response.status === 412) {
      await db.recordConflict(entry, await response.json());
      return "conflicts";
    }
    if (response.status >= 400 && response.status < 500) {
      const { error } = await response.json().catch(() => ({}));
      await db.rejectEntry(entry, error ?? `HTTP ${response.status}`);
      return "rejected";
    }
    throw new Error(`Serveur indisponible (HTTP ${response.status})`);
  }

  async function pushOutbox() {
    const report = { sent: 0, conflicts: 0, rejected: 0 };
    for (const entry of await db.listOutbox()) {
      if (entry.blocked) continue;
      let response;
      if (entry.op === "delete") {
        const headers = { "If-Match": `"${entry.baseVersion}"`, "X-Base-Version": String(entry.baseVersion) };
        response = await api(`/api/items/${entry.itemId}`, { method: "DELETE", headers });
      } else {
        const item = await db.getItem(entry.itemId);
        if (!item) continue;
        // Version 0 = jamais envoyé : création. Sinon on dit au serveur sur quelle version on a travaillé.
        // X-Base-Version double l'en-tête standard : le CDN de Netlify ne transmet pas toujours If-None-Match / If-Match.
        const precondition = item.version > 0
          ? { "If-Match": `"${item.version}"`, "X-Base-Version": String(item.version) }
          : { "If-None-Match": "*", "X-Base-Version": "new" };
        response = await api(`/api/items/${item.id}`, { method: "PUT", headers: precondition, body: toServer(item) });
      }
      report[await handleResponse(entry, response)] += 1;
    }
    return report;
  }

  async function pullChanges() {
    const lastPullAt = (await db.getMeta("lastPullAt")) ?? 0;
    const since = Math.max(0, lastPullAt - PULL_OVERLAP_MS);
    const response = await api(`/api/items?since=${since}`);
    checkErased(response);
    if (!response.ok) throw new Error(`Lecture impossible (HTTP ${response.status})`);
    const { items, serverTime } = await response.json();
    const changed = await db.mergeFromServer(items);
    await db.setMeta("lastPullAt", serverTime);
    return changed;
  }

  /** Web Locks : la page, ses autres onglets et le Service Worker ne synchronisent jamais en même temps. */
  let localQueue = Promise.resolve();
  function withLock(task) {
    if (scope.navigator?.locks?.request) return scope.navigator.locks.request("reserve-sync", task);
    const run = localQueue.then(task, task);
    localQueue = run.catch(() => {});
    return run;
  }

  function syncAll(reason = "manuel") {
    return withLock(async () => {
      let result;
      try {
        const report = await pushOutbox();
        const pulled = await pullChanges();
        await db.setMeta("lastSyncAt", Date.now());
        result = { ...report, pulled, reason };
      } catch (error) {
        if (!(error instanceof FoyerErased)) throw error;
        await db.resetFoyer();
        result = { erased: true, reason };
      }
      channel?.postMessage({ type: "synced", result });
      return result;
    });
  }

  /** Droit à l'effacement, demandé depuis cet appareil : le serveur d'abord, puis la copie locale. */
  function eraseFoyer() {
    return withLock(async () => {
      const response = await api("/api/foyer", { method: "DELETE" });
      if (!response.ok && response.status !== 410) throw new Error(`effacement refusé (HTTP ${response.status})`);
      await db.resetFoyer();
      channel?.postMessage({ type: "synced", result: { erased: true, reason: "effacement" } });
    });
  }

  scope.ReserveSync = { SYNC_TAG, syncAll, eraseFoyer, api, channel };
})(self);
