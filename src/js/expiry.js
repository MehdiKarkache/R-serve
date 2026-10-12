// Règles de péremption partagées par la page et par le serveur (rappels push).
// Un seul fichier : « bientôt périmé » veut dire la même chose sur l'écran et dans la notification.

export const SOON_DAYS = 2;

/** Date du jour au format AAAA-MM-JJ, dans le fuseau donné (celui de l'appareil par défaut). */
export function todayIso(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const toUtc = (iso) => {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86_400_000);
}

/** État d'un produit : expired, soon, ok, none (pas de date) ou empty (quantité nulle, à racheter). */
export function expiryState(item, today) {
  if (!(item.quantity > 0)) return { state: "empty", days: null };
  if (!item.expiresOn) return { state: "none", days: null };
  const days = daysBetween(today, item.expiresOn);
  if (days < 0) return { state: "expired", days };
  if (days <= SOON_DAYS) return { state: "soon", days };
  return { state: "ok", days };
}

export function expiryLabel({ state, days }) {
  if (state === "none") return "Sans date";
  if (state === "empty") return "À racheter";
  if (days < -1) return `Périmé depuis ${-days} jours`;
  if (days === -1) return "Périmé depuis hier";
  if (days === 0) return "Périme aujourd'hui";
  if (days === 1) return "Périme demain";
  return `Périme dans ${days} jours`;
}

/** Produits périmés ou qui périment dans SOON_DAYS jours, les plus urgents d'abord. */
export function urgentItems(items, today) {
  return items
    .filter((item) => !item.deleted)
    .map((item) => ({ item, expiry: expiryState(item, today) }))
    .filter(({ expiry }) => expiry.state === "expired" || expiry.state === "soon")
    .sort((a, b) => a.expiry.days - b.expiry.days)
    .map(({ item }) => item);
}

/** Contenu de la notification de rappel : titre, texte court et compteur pour le badge. */
export function reminderPayload(items, today) {
  const urgent = urgentItems(items, today);
  const parts = urgent.slice(0, 3).map((item) => `${item.name} (${expiryLabel(expiryState(item, today)).toLowerCase()})`);
  const more = urgent.length > 3 ? ` et ${urgent.length - 3} autre${urgent.length - 3 > 1 ? "s" : ""}` : "";
  return {
    title: urgent.length === 1 ? "1 produit à consommer vite" : `${urgent.length} produits à consommer vite`,
    body: `${parts.join(", ")}${more}.`,
    count: urgent.length,
    url: "/?filtre=urgent",
    tag: "reserve-peremption",
  };
}
