import { json } from "./http.mjs";

// Proxy vers Open Food Facts (base ouverte de produits alimentaires) :
// le navigateur ne parle qu'à notre origin (CSP connect-src 'self'), et l'adresse IP de l'utilisateur
// n'est pas transmise à un tiers. Open Food Facts demande un User-Agent qui identifie l'application.
const ENDPOINT = "https://world.openfoodfacts.org/api/v2/product";
const USER_AGENT = "Reserve-PWA/1.0 (projet etudiant M2, Universita di Corsica)";

export async function lookupBarcode(code) {
  if (!/^\d{8,14}$/.test(code)) return json(400, { error: "Code-barres invalide" });
  let response;
  try {
    response = await fetch(`${ENDPOINT}/${code}.json?fields=product_name,product_name_fr,brands,quantity`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return json(502, { error: "Open Food Facts ne répond pas" });
  }
  if (response.status === 404) return json(404, { error: "Produit inconnu d'Open Food Facts" });
  if (!response.ok) return json(502, { error: `Open Food Facts : HTTP ${response.status}` });
  const data = await response.json();
  const product = data.product ?? {};
  const name = (product.product_name_fr || product.product_name || "").trim();
  if (data.status !== 1 || !name) return json(404, { error: "Produit inconnu d'Open Food Facts" });
  return json(200, {
    code,
    name: name.slice(0, 80),
    brand: (product.brands ?? "").split(",")[0].trim() || null,
    quantity: product.quantity ?? null,
  }, { "Cache-Control": "private, max-age=86400" });
}
