import { itemKey, loadItems } from "./store.mjs";
import { json, preconditions } from "./http.mjs";
import { RETENTION } from "./foyer.mjs";

const UNITS = ["pièce", "g", "kg", "mL", "L"];
const LOCATIONS = ["frigo", "congelateur", "placard"];
const MAX_PHOTO_LENGTH = 150_000; // ≈ 110 Ko de JPEG en base64 : une vignette, pas une photo pleine taille

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/** Ne garde que les champs connus, vérifiés : le serveur ne stocke jamais le JSON brut du client. */
export function sanitizeItem(input) {
  if (!input || typeof input !== "object") return { error: "Corps JSON attendu" };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) return { error: "Nom obligatoire (80 caractères au plus)" };
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 100_000) return { error: "Quantité invalide" };
  if (!UNITS.includes(input.unit)) return { error: "Unité invalide" };
  if (!LOCATIONS.includes(input.location)) return { error: "Emplacement invalide" };
  if (input.expiresOn != null && !isIsoDate(input.expiresOn)) return { error: "Date de péremption invalide" };
  if (input.barcode != null && !/^\d{8,14}$/.test(input.barcode)) return { error: "Code-barres invalide" };
  if (input.photo != null && (typeof input.photo !== "string" || !/^data:image\/(jpeg|webp);base64,/.test(input.photo) || input.photo.length > MAX_PHOTO_LENGTH)) {
    return { error: "Photo invalide ou trop lourde" };
  }
  return {
    item: {
      name,
      quantity: Math.round(quantity * 100) / 100,
      unit: input.unit,
      location: input.location,
      expiresOn: input.expiresOn ?? null,
      barcode: input.barcode ?? null,
      photo: input.photo ?? null,
      createdAt: Number(input.createdAt) || Date.now(),
      updatedAt: Number(input.updatedAt) || Date.now(),
    },
  };
}

/** GET /api/items?since=<ms> : les produits (et suppressions) modifiés depuis `since`. */
export async function listItems(store, foyerId, url) {
  const since = Number(url.searchParams.get("since")) || 0;
  const serverTime = Date.now(); // pris avant la lecture : le client repartira de là
  const all = await loadItems(store, foyerId);
  // Les pierres tombales de plus de 90 jours ont prévenu tous les appareils actifs : on les efface au passage.
  const expired = all.filter((item) => item.deleted && serverTime - item.serverUpdatedAt > RETENTION.tombstoneMs);
  await Promise.all(expired.map((item) => store.delete(itemKey(foyerId, item.id))));
  const items = all.filter((item) => item.serverUpdatedAt > since && !expired.includes(item));
  return json(200, { items, serverTime });
}

/**
 * PUT /api/items/:id — précondition obligatoire :
 *   If-None-Match: *   pour une création ;
 *   If-Match: "<version>" pour une modification. Si le serveur a une autre version : 412 + sa version.
 */
export async function putItem(store, foyerId, itemId, request, deviceId) {
  const parsed = sanitizeItem(await request.json().catch(() => null));
  if (parsed.error) return json(400, { error: parsed.error });

  const key = itemKey(foyerId, itemId);
  const current = await store.getWithMetadata(key, { type: "json" });
  const { ifMatch, ifNoneMatch } = preconditions(request);
  if (!ifMatch && !ifNoneMatch) return json(428, { error: "En-tête If-Match ou If-None-Match requis" });
  if (current && (ifNoneMatch === "*" || (ifMatch && ifMatch !== `"${current.data.version}"`))) {
    return json(412, current.data);
  }

  const saved = {
    ...parsed.item,
    id: itemId,
    version: (current?.data.version ?? 0) + 1,
    serverUpdatedAt: Date.now(),
    updatedBy: deviceId,
  };
  // Écriture atomique : si un autre appareil a écrit entre la lecture et ici, rien n'est écrasé.
  const write = current
    ? await store.setJSON(key, saved, { onlyIfMatch: current.etag })
    : await store.setJSON(key, saved, { onlyIfNew: true });
  if (!write.modified) return json(412, await store.get(key, { type: "json" }));
  return json(200, saved, { ETag: `"${saved.version}"` });
}

/** DELETE /api/items/:id — remplace le produit par une pierre tombale versionnée, pour que les autres appareils l'apprennent. */
export async function deleteItem(store, foyerId, itemId, request, deviceId) {
  const key = itemKey(foyerId, itemId);
  const current = await store.getWithMetadata(key, { type: "json" });
  if (!current) return json(200, { id: itemId, deleted: true, version: 0 });
  if (current.data.deleted) return json(200, current.data);
  if (preconditions(request).ifMatch !== `"${current.data.version}"`) return json(412, current.data);

  const tombstone = { id: itemId, deleted: true, name: current.data.name, version: current.data.version + 1, serverUpdatedAt: Date.now(), updatedBy: deviceId };
  const write = await store.setJSON(key, tombstone, { onlyIfMatch: current.etag });
  if (!write.modified) return json(412, await store.get(key, { type: "json" }));
  return json(200, tombstone);
}
