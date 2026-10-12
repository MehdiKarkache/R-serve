import { openStore } from "../../server/store.mjs";
import { identify, json } from "../../server/http.mjs";
import { deleteItem, listItems, putItem } from "../../server/items.mjs";
import { deleteSubscription, publicKey, saveSubscription, sendTest } from "../../server/push.mjs";
import { lookupBarcode } from "../../server/barcode.mjs";
import { checkFoyer, eraseFoyer } from "../../server/foyer.mjs";

// Une seule fonction pour toute l'API, servie sur la même origin que la PWA (pas de CORS).
//   GET    /api/items?since=<ms>        changements depuis la dernière synchronisation
//   PUT    /api/items/:id               création (If-None-Match: *) ou modification (If-Match: "<version>")
//   DELETE /api/items/:id               suppression (If-Match: "<version>")
//   GET    /api/barcode/:code           nom du produit via Open Food Facts
//   GET    /api/push/key                clé publique VAPID
//   PUT    /api/push/subscription       enregistrer l'abonnement push de cet appareil
//   DELETE /api/push/subscription       le supprimer
//   POST   /api/push/test               envoyer le rappel maintenant
//   DELETE /api/foyer                   effacer toutes les données du foyer (droit à l'effacement)
// Un foyer effacé répond 410 Gone à toutes ces routes : ses autres appareils effacent alors leur copie.
const ITEM_ROUTE = /^\/api\/items\/([0-9a-f-]{36})$/i;

async function route(request) {
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  if (method === "GET" && pathname === "/api/push/key") return publicKey();

  const who = identify(request);
  if (!who) return json(401, { error: "Jeton de foyer manquant ou invalide" });
  const store = openStore();
  if ((await checkFoyer(store, who.foyerId)).erased) return json(410, { error: "Ce foyer a été supprimé" });

  if (pathname === "/api/foyer" && method === "DELETE") return eraseFoyer(store, who.foyerId);
  if (pathname === "/api/items" && method === "GET") return listItems(store, who.foyerId, url);
  const itemId = pathname.match(ITEM_ROUTE)?.[1]?.toLowerCase();
  if (itemId && method === "PUT") return putItem(store, who.foyerId, itemId, request, who.deviceId);
  if (itemId && method === "DELETE") return deleteItem(store, who.foyerId, itemId, request, who.deviceId);

  const barcode = pathname.match(/^\/api\/barcode\/(\d+)$/)?.[1];
  if (barcode && method === "GET") return lookupBarcode(barcode);

  if (pathname === "/api/push/subscription" && method === "PUT") return saveSubscription(store, who, request);
  if (pathname === "/api/push/subscription" && method === "DELETE") return deleteSubscription(store, who);
  if (pathname === "/api/push/test" && method === "POST") return sendTest(store, who);

  return json(404, { error: "Route inconnue" });
}

export default async (request) => {
  try {
    return await route(request);
  } catch (error) {
    console.error(error);
    return json(500, { error: "Erreur serveur" });
  }
};

export const config = { path: "/api/*" };
