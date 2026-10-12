// Rappels de péremption : abonnement Web Push (VAPID), demandé uniquement au clic sur « Activer les rappels ».
import { isIos, isStandalone } from "./pwa.js";

const enableButton = document.querySelector("#reminders-enable");
const testButton = document.querySelector("#reminders-test");
const disableButton = document.querySelector("#reminders-disable");
const result = document.querySelector("#reminders-result");

function say(message, state = "neutral") {
  result.textContent = message;
  result.dataset.state = state;
}

function showEnabled(enabled) {
  enableButton.hidden = enabled;
  testButton.hidden = !enabled;
  disableButton.hidden = !enabled;
}

function keyToBytes(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

const DENIED_MESSAGE = "Notifications refusées. Réserve fonctionne sans ; pour recevoir les rappels, autorisez les notifications dans les réglages du site, puis réessayez.";

export async function initReminders({ registrationPromise, api, onEnabled }) {
  const supported = "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
  if (!supported) {
    enableButton.hidden = true;
    say(isIos() && !isStandalone()
      ? "Sur iPhone et iPad, les rappels nécessitent d'installer Réserve : Partager → Sur l'écran d'accueil, puis ouvrez l'application depuis son icône."
      : "Ce navigateur ne gère pas les notifications push. L'inventaire, lui, fonctionne normalement.");
    return;
  }

  const registration = await registrationPromise;
  const existing = await registration?.pushManager.getSubscription().catch(() => null);
  showEnabled(Boolean(existing) && Notification.permission === "granted");
  if (Notification.permission === "denied") say(DENIED_MESSAGE, "error");

  // Permissions API : si l'utilisateur change l'autorisation dans les réglages du site, l'interface suit sans recharger.
  navigator.permissions?.query({ name: "notifications" }).then((status) => {
    status.addEventListener("change", async () => {
      if (Notification.permission === "denied") {
        showEnabled(false);
        say(DENIED_MESSAGE, "error");
      } else {
        const current = await registration?.pushManager.getSubscription().catch(() => null);
        showEnabled(Boolean(current) && Notification.permission === "granted");
        say("");
      }
    });
  }).catch(() => {});

  enableButton.addEventListener("click", async () => {
    if (Notification.permission === "denied") {
      say(DENIED_MESSAGE, "error");
      return;
    }
    say("Autorisez les notifications si le navigateur le demande…");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      say(DENIED_MESSAGE, "error");
      return;
    }
    try {
      const keyResponse = await fetch("/api/push/key");
      if (!keyResponse.ok) {
        say("Les rappels ne sont pas encore configurés sur ce serveur (clés VAPID absentes).", "error");
        return;
      }
      const { publicKey } = await keyResponse.json();
      const ready = await navigator.serviceWorker.ready;
      const subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
      const response = await api("/api/push/subscription", { method: "PUT", body: { subscription: subscription.toJSON() } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      showEnabled(true);
      say("Rappels activés. S'il y a des produits à consommer vite, vous recevrez une notification demain matin.", "success");
      onEnabled?.();
    } catch (error) {
      say(`Activation impossible : ${error.message}`, "error");
    }
  });

  testButton.addEventListener("click", async () => {
    say("Envoi…");
    try {
      const response = await api("/api/push/test", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      say("Rappel envoyé : la notification arrive dans quelques secondes.", "success");
    } catch (error) {
      say(`Envoi impossible : ${error.message}`, "error");
    }
  });

  disableButton.addEventListener("click", async () => {
    const ready = await navigator.serviceWorker.ready;
    const subscription = await ready.pushManager.getSubscription();
    await subscription?.unsubscribe();
    showEnabled(false);
    say("Rappels désactivés sur cet appareil.");
    // Hors ligne, le serveur l'apprendra au prochain envoi (réponse 410) et supprimera l'abonnement.
    if (navigator.onLine) await api("/api/push/subscription", { method: "DELETE" }).catch(() => {});
  });
}

/** Après l'effacement du foyer : le serveur a supprimé l'abonnement, on le retire aussi du navigateur. */
export async function forgetReminders() {
  const ready = await navigator.serviceWorker?.ready;
  await (await ready?.pushManager.getSubscription().catch(() => null))?.unsubscribe().catch(() => {});
  if ("Notification" in window && "PushManager" in window) showEnabled(false);
  say("");
}

/** Badge sur l'icône de l'application installée : nombre de produits à consommer vite. */
export function updateBadge(count) {
  if (!("setAppBadge" in navigator)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}
