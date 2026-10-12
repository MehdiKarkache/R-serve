// Briques PWA communes à toutes les pages : Service Worker et mise à jour, installation, état du réseau.

const networkStatus = document.querySelector("#network-status");
const offlineBanner = document.querySelector("#offline-banner");
const toast = document.querySelector("#toast");
let pendingCount = 0;
let toastTimer = null;

export function showToast(message, duration = 4000) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Pastille réseau + actions qui exigent le réseau (attribut data-requires-network) désactivées hors ligne. */
export function updateNetworkStatus() {
  const online = navigator.onLine;
  document.body.classList.toggle("offline", !online);
  const pending = pendingCount > 0 ? ` · ${pendingCount} en attente` : "";
  networkStatus.textContent = `${online ? "En ligne" : "Hors ligne"}${pending}`;
  networkStatus.dataset.state = online ? "online" : "offline";
  if (offlineBanner) offlineBanner.hidden = online;
  for (const element of document.querySelectorAll("[data-requires-network]")) {
    element.disabled = !online;
    element.title = online ? "" : "Indisponible hors ligne";
  }
}

export function setPendingCount(count) {
  pendingCount = count;
  updateNetworkStatus();
}

/**
 * Mise à jour proposée, pas imposée : le nouveau Service Worker attend (pas de skipWaiting à l'installation),
 * la bannière le signale, et c'est le clic sur « Mettre à jour » qui l'active puis recharge la page.
 * Raison : un formulaire en cours ou la caméra ouverte ne doivent pas disparaître sous un rechargement surprise.
 */
function watchForUpdates(registration) {
  const banner = document.querySelector("#update-banner");
  const hadController = Boolean(navigator.serviceWorker.controller);

  const offer = (worker) => {
    banner.hidden = false;
    document.querySelector("#update-now").onclick = () => worker.postMessage({ type: "SKIP_WAITING" });
    document.querySelector("#update-later").onclick = () => {
      banner.hidden = true;
    };
  };

  if (registration.waiting && hadController) offer(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) offer(worker);
    });
  });

  // Le nouveau SW a pris le contrôle : on recharge pour que HTML, CSS et JS soient de la même version.
  // Au tout premier chargement (pas de contrôleur avant), clients.claim() déclenche aussi cet événement : on l'ignore.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  // Une PWA installée reste ouverte des jours : on vérifie s'il existe une nouvelle version à chaque retour au premier plan.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) registration.update().catch(() => {});
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    watchForUpdates(registration);
    return registration;
  } catch (error) {
    console.warn("Service Worker non enregistré", error);
    return null;
  }
}

function setupInstall() {
  const button = document.querySelector("#install-button");
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    button.hidden = true;
    if (outcome === "accepted") showToast("Réserve est installée sur cet appareil.");
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    button.hidden = true;
  });

  // iOS n'a pas de beforeinstallprompt : on explique le geste, une fois.
  const hint = document.querySelector("#ios-install-hint");
  if (!hint || !isIos() || isStandalone()) return;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("ios-hint-dismissed") === "1";
  } catch {
    // Stockage indisponible (navigation privée) : on affiche simplement l'astuce.
  }
  if (dismissed) return;
  hint.hidden = false;
  document.querySelector("#ios-hint-close").addEventListener("click", () => {
    hint.hidden = true;
    try {
      localStorage.setItem("ios-hint-dismissed", "1");
    } catch {
      // Rien à faire : l'astuce reviendra au prochain lancement.
    }
  });
}

/** À appeler une fois par page. Renvoie la registration du Service Worker (ou null). */
/**
 * Stockage persistant : sans lui, le navigateur peut effacer IndexedDB sous pression d'espace
 * (et Safari après 7 jours sans visite), outbox comprise. Demandé seulement pour l'application installée :
 * Chrome et Edge l'accordent alors sans fenêtre de demande ; Safari exempte déjà les PWA installées.
 */
async function requestPersistentStorage() {
  if (!isStandalone() || !navigator.storage?.persist) return;
  if (!(await navigator.storage.persisted())) await navigator.storage.persist();
}

export function initPwa() {
  requestPersistentStorage().catch(() => {});
  updateNetworkStatus();
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  setupInstall();
  return registerServiceWorker();
}
