import { getStore } from "@netlify/blobs";

// Clés du store « reserve » :
//   items/<foyerId>/<itemId>   un produit (ou sa pierre tombale { deleted: true })
//   push/<foyerId>/<deviceId>  l'abonnement push d'un appareil du foyer
//   foyers/<foyerId>           { lastSeenAt } ou { erasedAt } : activité du foyer, effacement (server/foyer.mjs)
// En production, Netlify fournit l'accès au store ; en local, scripts/dev.mjs lance un serveur Blobs.
export function openStore() {
  // strong : une lecture voit l'écriture qui vient d'être faite (nécessaire au contrôle de version).
  return getStore({ name: "reserve", consistency: "strong" });
}

export const itemKey = (foyerId, itemId) => `items/${foyerId}/${itemId}`;
export const pushKey = (foyerId, deviceId) => `push/${foyerId}/${deviceId}`;
export const foyerKey = (foyerId) => `foyers/${foyerId}`;

export async function loadItems(store, foyerId) {
  const { blobs } = await store.list({ prefix: `items/${foyerId}/` });
  const items = await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })));
  return items.filter(Boolean);
}
