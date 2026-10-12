import webpush from "web-push";
import { loadItems, pushKey } from "./store.mjs";
import { json } from "./http.mjs";
import { reminderPayload, todayIso, urgentItems } from "../src/js/expiry.js";

// Les clés VAPID viennent des variables d'environnement (Netlify → Site configuration → Environment variables).
// La clé privée ne quitte jamais le serveur ; la clé publique est servie à la page par GET /api/push/key.
const TIME_ZONE = "Europe/Paris";
let vapidReady = false;

function configureVapid() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  if (!vapidReady) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT || "mailto:contact@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      vapidReady = true;
    } catch (error) {
      console.error("Clés VAPID invalides :", error.message); // clé mal copiée dans les variables d'environnement
      return false;
    }
  }
  return true;
}

export function publicKey() {
  if (!configureVapid()) return json(503, { error: "Notifications push non configurées sur ce serveur" });
  return json(200, { publicKey: process.env.VAPID_PUBLIC_KEY });
}

export async function saveSubscription(store, { foyerId, deviceId }, request) {
  const body = await request.json().catch(() => null);
  const subscription = body?.subscription;
  const valid = typeof subscription?.endpoint === "string" && subscription.endpoint.startsWith("https://")
    && typeof subscription.keys?.p256dh === "string" && typeof subscription.keys?.auth === "string";
  if (!valid) return json(400, { error: "Abonnement push invalide" });
  const { endpoint, keys } = subscription;
  await store.setJSON(pushKey(foyerId, deviceId), { foyerId, deviceId, subscription: { endpoint, keys }, createdAt: Date.now() });
  return json(201, { ok: true });
}

export async function deleteSubscription(store, { foyerId, deviceId }) {
  await store.delete(pushKey(foyerId, deviceId));
  return json(200, { ok: true });
}

/** Envoie un rappel ; un abonnement expiré (404/410) est supprimé. */
async function send(store, record, payload) {
  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload), { TTL: 12 * 3600, urgency: "normal", topic: "peremption" });
    return "sent";
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await store.delete(pushKey(record.foyerId, record.deviceId));
      return "expired";
    }
    throw error;
  }
}

/** POST /api/push/test : le rappel du jour, tout de suite, sur cet appareil seulement. */
export async function sendTest(store, { foyerId, deviceId }) {
  if (!configureVapid()) return json(503, { error: "Notifications push non configurées sur ce serveur" });
  const record = await store.get(pushKey(foyerId, deviceId), { type: "json" });
  if (!record) return json(404, { error: "Aucun abonnement pour cet appareil" });
  const today = todayIso(TIME_ZONE);
  const items = await loadItems(store, foyerId);
  const payload = urgentItems(items, today).length > 0
    ? reminderPayload(items, today)
    : { title: "Réserve", body: "Rien ne périme dans les deux jours. Les rappels fonctionnent !", count: 0, url: "/", tag: "reserve-test" };
  const result = await send(store, record, payload);
  return result === "sent" ? json(200, { ok: true }) : json(410, { error: "Abonnement expiré, réactivez les rappels" });
}

/** Tâche planifiée (chaque matin) : un rappel par appareil des foyers qui ont des produits urgents. */
export async function sendDailyReminders(store, now = new Date()) {
  if (!configureVapid()) return { skipped: "VAPID non configuré" };
  const today = todayIso(TIME_ZONE, now);
  const { blobs } = await store.list({ prefix: "push/" });
  const foyers = new Map();
  for (const blob of blobs) {
    const foyerId = blob.key.split("/")[1];
    foyers.set(foyerId, [...(foyers.get(foyerId) ?? []), blob]);
  }
  const report = { foyers: foyers.size, sent: 0, expired: 0, failed: 0 };

  for (const [foyerId, subscriptions] of foyers) {
    const items = await loadItems(store, foyerId);
    if (urgentItems(items, today).length === 0) continue;
    const payload = reminderPayload(items, today);
    for (const blob of subscriptions) {
      const record = await store.get(blob.key, { type: "json" });
      if (!record || record.lastReminderOn === today) continue; // jamais deux rappels le même jour
      try {
        const result = await send(store, record, payload);
        report[result] += 1;
        if (result === "sent") await store.setJSON(blob.key, { ...record, lastReminderOn: today });
      } catch (error) {
        report.failed += 1;
        // Jamais l'identifiant complet dans les journaux : il sert de clé d'accès au foyer.
        console.error("Rappel non envoyé", `${foyerId.slice(0, 8)}…`, error.statusCode ?? error.message);
      }
    }
  }
  return report;
}
