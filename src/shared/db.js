// Base IndexedDB de Réserve, partagée par la page et par le Service Worker.
// Script classique (pas un module) : sw.js le charge avec importScripts, ce que tous les navigateurs acceptent.
// Dépend de idb (vendor/idb.js), chargé avant lui.
(function (scope) {
  const DB_NAME = "reserve";
  const DB_VERSION = 1;
  let dbPromise = null;

  // Stores :
  //   items      clé id (UUID)    : les produits, tels que l'utilisateur les voit
  //   outbox     clé itemId       : une entrée par produit à envoyer — 5 modifications hors ligne = 1 envoi
  //   conflicts  clé itemId       : la version du serveur quand elle diffère de la nôtre (412)
  //   meta       clé hors ligne   : foyerId, deviceId, lastPullAt, lastSyncAt
  function openDb() {
    dbPromise ??= scope.idb.openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("items", { keyPath: "id" });
        db.createObjectStore("outbox", { keyPath: "itemId" });
        db.createObjectStore("conflicts", { keyPath: "itemId" });
        db.createObjectStore("meta");
      },
      terminated() {
        dbPromise = null;
      },
    });
    return dbPromise;
  }

  async function getMeta(key) {
    return (await openDb()).get("meta", key);
  }

  async function setMeta(key, value) {
    return (await openDb()).put("meta", value, key);
  }

  /** Identifiants créés au premier lancement, dans une transaction : la page et le SW ne peuvent pas en créer deux. */
  async function getIdentity() {
    const tx = (await openDb()).transaction("meta", "readwrite");
    let foyerId = await tx.store.get("foyerId");
    let deviceId = await tx.store.get("deviceId");
    if (!foyerId) await tx.store.put((foyerId = crypto.randomUUID()), "foyerId");
    if (!deviceId) await tx.store.put((deviceId = crypto.randomUUID()), "deviceId");
    await tx.done;
    return { foyerId, deviceId };
  }

  async function listItems() {
    return (await openDb()).getAll("items");
  }

  async function getItem(id) {
    return (await openDb()).get("items", id);
  }

  /** Enregistre localement ET met le produit dans l'outbox, dans la même transaction : rien ne se perd. */
  async function saveItem(item) {
    const tx = (await openDb()).transaction(["items", "outbox"], "readwrite");
    await tx.objectStore("items").put(item);
    await tx.objectStore("outbox").put({ itemId: item.id, op: "put", queuedAt: Date.now() });
    await tx.done;
  }

  async function deleteItem(id) {
    const tx = (await openDb()).transaction(["items", "outbox", "conflicts"], "readwrite");
    const item = await tx.objectStore("items").get(id);
    await tx.objectStore("items").delete(id);
    await tx.objectStore("conflicts").delete(id);
    if (!item || item.version === 0) {
      // Jamais arrivé au serveur : il n'y a rien à lui dire.
      await tx.objectStore("outbox").delete(id);
    } else {
      await tx.objectStore("outbox").put({ itemId: id, op: "delete", baseVersion: item.version, name: item.name, queuedAt: Date.now() });
    }
    await tx.done;
  }

  async function listOutbox() {
    const entries = await (await openDb()).getAll("outbox");
    return entries.sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Le serveur a accepté l'envoi : on note sa version, et on retire l'entrée si rien n'a changé entre-temps. */
  async function acknowledge(entry, saved) {
    const tx = (await openDb()).transaction(["items", "outbox"], "readwrite");
    const items = tx.objectStore("items");
    const outbox = tx.objectStore("outbox");
    const current = await outbox.get(entry.itemId);
    if (current?.queuedAt === entry.queuedAt) await outbox.delete(entry.itemId);
    const local = await items.get(entry.itemId);
    if (local && !saved.deleted) await items.put({ ...local, version: saved.version, serverUpdatedAt: saved.serverUpdatedAt });
    await tx.done;
  }

  /** 412 : on garde la version du serveur à côté, et on bloque l'envoi jusqu'à la décision de l'utilisateur. */
  async function recordConflict(entry, server) {
    const tx = (await openDb()).transaction(["outbox", "conflicts"], "readwrite");
    await tx.objectStore("outbox").put({ ...entry, blocked: "conflict" });
    await tx.objectStore("conflicts").put({ itemId: entry.itemId, op: entry.op, server, detectedAt: Date.now() });
    await tx.done;
  }

  /** Refus définitif (400…) : l'entrée reste visible mais n'est plus renvoyée en boucle. */
  async function rejectEntry(entry, reason) {
    return (await openDb()).put("outbox", { ...entry, blocked: "rejected", reason });
  }

  async function listConflicts() {
    return (await openDb()).getAll("conflicts");
  }

  /**
   * « mine »   : on rejoue notre modification par-dessus la version du serveur (If-Match sur sa version).
   * « theirs » : on adopte la version du serveur et on oublie la nôtre.
   */
  async function resolveConflict(itemId, choice) {
    const tx = (await openDb()).transaction(["items", "outbox", "conflicts"], "readwrite");
    const items = tx.objectStore("items");
    const outbox = tx.objectStore("outbox");
    const conflict = await tx.objectStore("conflicts").get(itemId);
    const entry = await outbox.get(itemId);
    if (conflict && entry) {
      const { server } = conflict;
      if (choice === "mine") {
        if (entry.op === "put") {
          const local = await items.get(itemId);
          if (local) await items.put({ ...local, version: server.version });
          await outbox.put({ itemId, op: "put", queuedAt: Date.now() });
        } else {
          await outbox.put({ itemId, op: "delete", name: entry.name, baseVersion: server.version, queuedAt: Date.now() });
        }
      } else {
        if (server.deleted) await items.delete(itemId);
        else await items.put(server);
        await outbox.delete(itemId);
      }
    }
    await tx.objectStore("conflicts").delete(itemId);
    await tx.done;
  }

  /** Applique les changements des autres appareils, sauf sur les produits que nous avons nous-mêmes en attente d'envoi. */
  async function mergeFromServer(serverItems) {
    const tx = (await openDb()).transaction(["items", "outbox"], "readwrite");
    const items = tx.objectStore("items");
    const outbox = tx.objectStore("outbox");
    let changed = 0;
    for (const remote of serverItems) {
      if (await outbox.get(remote.id)) continue; // notre envoi tranchera (et révélera un conflit s'il y en a un)
      const local = await items.get(remote.id);
      if (remote.deleted) {
        if (local) {
          await items.delete(remote.id);
          changed += 1;
        }
      } else if (!local || remote.version > local.version) {
        await items.put(remote);
        changed += 1;
      }
    }
    await tx.done;
    return changed;
  }

  /**
   * Rejoindre un autre foyer : nos produits y sont ajoutés (version 0 = création),
   * nos suppressions en attente concernaient l'ancien foyer et sont abandonnées.
   */
  async function joinFoyer(foyerId) {
    const tx = (await openDb()).transaction(["items", "outbox", "conflicts", "meta"], "readwrite");
    const items = tx.objectStore("items");
    const outbox = tx.objectStore("outbox");
    await outbox.clear();
    await tx.objectStore("conflicts").clear();
    for (const item of await items.getAll()) {
      await items.put({ ...item, version: 0 });
      await outbox.put({ itemId: item.id, op: "put", queuedAt: Date.now() });
    }
    await tx.objectStore("meta").put(foyerId, "foyerId");
    await tx.objectStore("meta").put(0, "lastPullAt");
    await tx.done;
  }

  /** Effacement du foyer : l'inventaire local disparaît et l'appareil repart avec un nouveau foyer, vide. */
  async function resetFoyer() {
    const tx = (await openDb()).transaction(["items", "outbox", "conflicts", "meta"], "readwrite");
    await tx.objectStore("items").clear();
    await tx.objectStore("outbox").clear();
    await tx.objectStore("conflicts").clear();
    const meta = tx.objectStore("meta");
    await meta.put(crypto.randomUUID(), "foyerId");
    await meta.put(0, "lastPullAt");
    await meta.delete("lastSyncAt");
    await tx.done;
  }

  /**
   * Au lancement : les envois refusés sont retentés une fois. Une nouvelle version de l'app a pu corriger
   * la cause (c'était le cas des refus 428) ; un produit vraiment invalide est simplement refusé de nouveau.
   */
  async function retryRejected() {
    const tx = (await openDb()).transaction("outbox", "readwrite");
    for (const entry of await tx.store.getAll()) {
      if (entry.blocked !== "rejected") continue;
      const { blocked, reason, ...pending } = entry;
      await tx.store.put(pending);
    }
    await tx.done;
  }

  scope.ReserveDB = {
    openDb,
    getMeta,
    setMeta,
    getIdentity,
    listItems,
    getItem,
    saveItem,
    deleteItem,
    listOutbox,
    acknowledge,
    recordConflict,
    rejectEntry,
    listConflicts,
    resolveConflict,
    mergeFromServer,
    joinFoyer,
    resetFoyer,
    retryRejected,
  };
})(self);
