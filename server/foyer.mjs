import { foyerKey } from "./store.mjs";
import { json } from "./http.mjs";

// Durées de conservation (RGPD : chaque donnée a une date de fin). Elles sont annoncées sur /confidentialite/.
const DAY = 86_400_000;
export const RETENTION = {
  inactiveMs: 365 * DAY, // foyer qui ne s'est pas synchronisé depuis 12 mois : tout est effacé
  tombstoneMs: 90 * DAY, // pierre tombale d'un produit supprimé : gardée 90 jours pour prévenir les autres appareils
};

/**
 * Fiche du foyer : foyers/<id> = { lastSeenAt } ou { erasedAt }.
 * Lue à chaque requête de l'API. Un foyer effacé répond 410 Gone à tous ses appareils, qui effacent leur copie.
 * lastSeenAt est réécrit au plus une fois par jour : c'est lui qui mesure l'inactivité.
 */
export async function checkFoyer(store, foyerId, now = Date.now()) {
  const key = foyerKey(foyerId);
  const record = await store.getWithMetadata(key, { type: "json" });
  if (record?.data.erasedAt) return { erased: true };
  if (!record || now - (record.data.lastSeenAt ?? 0) > DAY) {
    // Écriture conditionnelle : un effacement arrivé entre la lecture et ici n'est jamais écrasé.
    if (record) await store.setJSON(key, { lastSeenAt: now }, { onlyIfMatch: record.etag });
    else await store.setJSON(key, { lastSeenAt: now }, { onlyIfNew: true });
  }
  return { erased: false };
}

async function deleteFoyerData(store, foyerId) {
  const lists = await Promise.all([store.list({ prefix: `items/${foyerId}/` }), store.list({ prefix: `push/${foyerId}/` })]);
  const keys = lists.flatMap(({ blobs }) => blobs.map((blob) => blob.key));
  for (let i = 0; i < keys.length; i += 20) {
    await Promise.all(keys.slice(i, i + 20).map((key) => store.delete(key)));
  }
  return keys.length;
}

/** DELETE /api/foyer — droit à l'effacement : produits, pierres tombales et abonnements push du foyer. */
export async function eraseFoyer(store, foyerId) {
  // La fiche « effacé » d'abord : dès cet instant, les autres appareils reçoivent 410 au lieu de renvoyer leurs produits.
  await store.setJSON(foyerKey(foyerId), { erasedAt: Date.now() });
  const deleted = await deleteFoyerData(store, foyerId);
  return json(200, { erased: true, deleted });
}

/**
 * Tâche quotidienne : efface les foyers inactifs depuis 12 mois et ce qu'une écriture concurrente aurait laissé
 * dans un foyer effacé. La fiche d'un foyer effacé ne contient qu'une date ; elle est supprimée au bout d'un an.
 */
export async function purgeExpired(store, now = new Date()) {
  const time = now.getTime();
  const report = { inactive: 0, leftovers: 0, markers: 0 };
  const { blobs } = await store.list({ prefix: "foyers/" });
  for (const blob of blobs) {
    const foyerId = blob.key.split("/")[1];
    const record = await store.get(blob.key, { type: "json" });
    if (!record) continue;
    if (record.erasedAt) {
      report.leftovers += await deleteFoyerData(store, foyerId);
      if (time - record.erasedAt > RETENTION.inactiveMs) {
        await store.delete(blob.key);
        report.markers += 1;
      }
    } else if (time - (record.lastSeenAt ?? 0) > RETENTION.inactiveMs) {
      await deleteFoyerData(store, foyerId);
      await store.delete(blob.key);
      report.inactive += 1;
    }
  }
  return report;
}
