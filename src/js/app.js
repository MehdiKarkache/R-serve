// Réserve — l'application : inventaire (IndexedDB), formulaire, liste de courses, conflits, synchronisation.
import { initPwa, setPendingCount, showToast } from "./pwa.js";
import { addDays, expiryLabel, expiryState, todayIso } from "./expiry.js";
import { barcodeSupported, CameraError, capturePhoto, imageFileToDataUrl, scanBarcode } from "./camera.js";
import { forgetReminders, initReminders, updateBadge } from "./reminders.js";
import { copyToClipboard, initFoyer } from "./foyer.js";

const db = window.ReserveDB;
const sync = window.ReserveSync;

const LOCATIONS = { frigo: "Frigo", congelateur: "Congélateur", placard: "Placard" };
const LOCATION_ICONS = { frigo: "🧊", congelateur: "❄️", placard: "🥫" };
const SYNC_INTERVAL_MS = 60_000;

const $ = (selector) => document.querySelector(selector);
const itemList = $("#item-list");
const shoppingList = $("#shopping-list");
const dialog = $("#item-dialog");
const form = $("#item-form");
const nameInput = $("#item-name");
const expiresInput = $("#item-expires");
const photoPreview = $("#photo-preview");
const barcodeInput = $("#item-barcode");

const state = { items: [], outbox: new Map(), conflicts: [], status: "all", location: "all", query: "" };
let registration = null;
let foyerUi = null;
let editing = null; // produit en cours de modification (null = ajout)
let draftPhoto = null;
let lastSyncAttempt = 0;

// ————— Utilitaires d'affichage —————

function el(tag, { className, text, attrs = {} } = {}, children = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text; // textContent, jamais innerHTML : les noms viennent de l'utilisateur
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

const formatNumber = (value) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value);
const formatQuantity = ({ quantity, unit }) =>
  unit === "pièce" ? `${formatNumber(quantity)} pièce${quantity > 1 ? "s" : ""}` : `${formatNumber(quantity)} ${unit}`;
const formatDate = (iso) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const normalize = (text) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

function relativeTime(timestamp) {
  if (!timestamp) return "jamais";
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const format = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  if (Math.abs(minutes) < 1) return "à l'instant";
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  if (Math.abs(minutes) < 60 * 24) return format.format(Math.round(minutes / 60), "hour");
  return format.format(Math.round(minutes / 1440), "day");
}

function say(selector, message, kind = "neutral") {
  const element = $(selector);
  element.textContent = message;
  element.dataset.state = kind;
}

// ————— Rendu —————

async function refresh() {
  const [items, outbox, conflicts] = await Promise.all([db.listItems(), db.listOutbox(), db.listConflicts()]);
  state.items = items;
  state.outbox = new Map(outbox.map((entry) => [entry.itemId, entry]));
  state.conflicts = conflicts;
  render();
}

function matches({ item, expiry }) {
  if (state.location !== "all" && item.location !== state.location) return false;
  if (state.status === "urgent" && expiry.state !== "expired" && expiry.state !== "soon") return false;
  if (state.status === "expired" && expiry.state !== "expired") return false;
  return !state.query || normalize(item.name).includes(state.query);
}

function byUrgency(a, b) {
  const daysA = a.expiry.days ?? Number.POSITIVE_INFINITY;
  const daysB = b.expiry.days ?? Number.POSITIVE_INFINITY;
  return daysA - daysB || a.item.name.localeCompare(b.item.name, "fr");
}

function syncNote(item) {
  const entry = state.outbox.get(item.id);
  if (!entry) return null;
  if (entry.blocked === "conflict") return el("p", { className: "item-sync item-sync-alert", text: "Modifié ailleurs : à vérifier en haut de la page" });
  if (entry.blocked === "rejected") return el("p", { className: "item-sync item-sync-alert", text: `Refusé par le serveur : ${entry.reason}` });
  return el("p", { className: "item-sync", text: "En attente d'envoi" });
}

function visual(item) {
  if (item.photo) return el("img", { className: "item-photo", attrs: { src: item.photo, alt: "", width: "56", height: "56", loading: "lazy", decoding: "async" } });
  return el("span", { className: "item-photo item-icon", text: LOCATION_ICONS[item.location], attrs: { "aria-hidden": "true" } });
}

function itemElement({ item, expiry }) {
  const consumeLabel = item.unit === "pièce" ? "−1" : "Fini";
  const consumeHelp = item.unit === "pièce" ? `Retirer une unité de ${item.name}` : `Marquer ${item.name} comme fini`;
  const meta = el("p", { className: "item-meta" }, [
    el("span", { className: "tag", text: LOCATIONS[item.location] }),
    el("span", { text: formatQuantity(item) }),
    el("span", { className: `expiry expiry-${expiry.state}`, text: expiryLabel(expiry) }),
  ]);
  const body = el("div", { className: "item-body" }, [el("p", { className: "item-name", text: item.name }), meta]);
  const note = syncNote(item);
  if (note) body.append(note);
  const actions = el("div", { className: "item-actions" }, [
    el("button", { className: "button button-secondary button-small", text: consumeLabel, attrs: { type: "button", "data-action": "consume", "aria-label": consumeHelp } }),
    el("button", { className: "button button-ghost button-small", text: "Modifier", attrs: { type: "button", "data-action": "edit", "aria-label": `Modifier ${item.name}` } }),
  ]);
  const element = el("li", { className: `item item-${expiry.state}` }, [visual(item), body, actions]);
  element.dataset.id = item.id;
  return element;
}

function shoppingElement(item) {
  const element = el("li", { className: "item" }, [
    el("div", { className: "item-body" }, [el("p", { className: "item-name", text: item.name }), el("p", { className: "item-meta", text: LOCATIONS[item.location] })]),
    el("div", { className: "item-actions" }, [
      el("button", { className: "button button-secondary button-small", text: "Racheté", attrs: { type: "button", "data-action": "restock", "aria-label": `${item.name} racheté` } }),
      el("button", { className: "button button-ghost button-small", text: "Retirer", attrs: { type: "button", "data-action": "remove", "aria-label": `Retirer ${item.name} de la liste` } }),
    ]),
  ]);
  element.dataset.id = item.id;
  return element;
}

const FIELD_LABELS = { name: "Nom", quantity: "Quantité", location: "Emplacement", expiresOn: "Péremption" };
const describe = (item, field) => {
  if (field === "quantity") return formatQuantity(item);
  if (field === "location") return LOCATIONS[item.location];
  if (field === "expiresOn") return item.expiresOn ? formatDate(item.expiresOn) : "sans date";
  return item[field];
};

function conflictElement(conflict) {
  const local = state.items.find((item) => item.id === conflict.itemId);
  const { server } = conflict;
  const name = local?.name ?? server.name ?? "Un produit";
  let message;
  let keepMine;
  let takeTheirs;
  const details = [];
  if (conflict.op === "put" && server.deleted) {
    message = `« ${name} » a été supprimé sur un autre appareil, alors que vous l'avez modifié ici.`;
    [keepMine, takeTheirs] = ["Le garder", "Accepter la suppression"];
  } else if (conflict.op === "delete") {
    message = `« ${name} » a été modifié sur un autre appareil, alors que vous l'avez supprimé ici.`;
    [keepMine, takeTheirs] = ["Supprimer quand même", "Garder leur version"];
  } else {
    message = `« ${name} » a été modifié sur un autre appareil en même temps que sur celui-ci.`;
    [keepMine, takeTheirs] = ["Garder ma version", "Prendre la leur"];
    for (const field of Object.keys(FIELD_LABELS)) {
      if (local && String(describe(local, field)) !== String(describe(server, field))) {
        details.push(el("li", { text: `${FIELD_LABELS[field]} : ${describe(local, field)} ici, ${describe(server, field)} sur l'autre appareil` }));
      }
    }
  }
  const element = el("li", { className: "conflict" }, [
    el("p", { text: message }),
    ...(details.length ? [el("ul", { className: "conflict-details" }, details)] : []),
    el("div", { className: "actions" }, [
      el("button", { className: "button", text: keepMine, attrs: { type: "button", "data-choice": "mine" } }),
      el("button", { className: "button button-secondary", text: takeTheirs, attrs: { type: "button", "data-choice": "theirs" } }),
    ]),
  ]);
  element.dataset.id = conflict.itemId;
  return element;
}

function render() {
  const today = todayIso();
  const entries = state.items.map((item) => ({ item, expiry: expiryState(item, today) }));
  const stock = entries.filter(({ expiry }) => expiry.state !== "empty");
  const finished = entries.filter(({ expiry }) => expiry.state === "empty").map(({ item }) => item);
  const urgent = stock.filter(({ expiry }) => expiry.state === "expired" || expiry.state === "soon").length;

  $("#count-all").textContent = String(stock.length);
  $("#count-urgent").textContent = String(urgent);
  $("#count-expired").textContent = String(stock.filter(({ expiry }) => expiry.state === "expired").length);
  for (const chip of document.querySelectorAll("[data-status]")) chip.setAttribute("aria-pressed", String(chip.dataset.status === state.status));
  for (const button of document.querySelectorAll("[data-location]")) button.setAttribute("aria-pressed", String(button.dataset.location === state.location));

  const visible = stock.filter(matches).sort(byUrgency);
  itemList.replaceChildren(...visible.map(itemElement));
  $("#empty-state").hidden = stock.length > 0;
  $("#no-results").hidden = stock.length === 0 || visible.length > 0;

  finished.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  shoppingList.replaceChildren(...finished.map(shoppingElement));
  $("#shopping-empty").hidden = finished.length > 0;
  $("#share-button").disabled = finished.length === 0;

  $("#conflicts").hidden = state.conflicts.length === 0;
  $("#conflict-list").replaceChildren(...state.conflicts.map(conflictElement));

  $("#pending-count").textContent = String(state.outbox.size);
  setPendingCount(state.outbox.size);
  updateBadge(urgent);
}

async function renderLastSync() {
  $("#last-sync").textContent = relativeTime(await db.getMeta("lastSyncAt"));
}

// ————— Synchronisation —————

/** Synchronisation dans la page : repli pour Firefox et Safari, et récupération des changements du foyer. */
async function runSync(reason) {
  if (!navigator.onLine) return;
  lastSyncAttempt = Date.now();
  try {
    const result = await sync.syncAll(reason);
    await afterSync(result);
  } catch (error) {
    say("#foyer-result", `Synchronisation reportée : ${error.message}`, "error");
  }
}

async function afterSync(result) {
  if (result?.erased) await afterErase(result.reason === "effacement" ? "" : "Ce foyer a été supprimé depuis un autre appareil : cet appareil repart avec un inventaire vide.");
  await refresh();
  await renderLastSync();
  if ($("#foyer-result").dataset.state === "error") say("#foyer-result", ""); // l'erreur précédente est réglée
  if (result?.conflicts) showToast("Un produit a été modifié sur un autre appareil : choisissez la version à garder.");
}

/** Après l'effacement du foyer (droit à l'effacement), ici ou sur un autre appareil. */
async function afterErase(message) {
  await foyerUi?.renderCode();
  await forgetReminders();
  if (message) showToast(message);
}

/**
 * Après chaque modification :
 * 1. Background Sync (Chrome, Edge) : si l'application est fermée avant l'envoi, le navigateur
 *    réveillera le Service Worker au retour du réseau pour vider l'outbox ;
 * 2. page ouverte et en ligne : envoi immédiat, sans attendre le navigateur (qui espace ses
 *    nouvelles tentatives de plusieurs minutes après un échec). Firefox et Safari n'ont que ce chemin,
 *    plus l'événement « online ». Le verrou Web Locks empêche les deux de s'exécuter en même temps.
 */
async function requestSync() {
  if (registration?.active && "sync" in registration) {
    await registration.sync.register(sync.SYNC_TAG).catch(() => {
      // Background Sync désactivé dans les réglages du navigateur : le repli ci-dessous suffit page ouverte.
    });
  }
  await runSync("modification");
}

async function save(item) {
  await db.saveItem({ ...item, updatedAt: Date.now() });
  sync.channel?.postMessage({ type: "changed" });
  await refresh();
  await requestSync();
}

// ————— Formulaire d'ajout et de modification —————

function setPhoto(dataUrl) {
  draftPhoto = dataUrl;
  photoPreview.hidden = !dataUrl;
  if (dataUrl) photoPreview.src = dataUrl;
  else photoPreview.removeAttribute("src");
  $("#photo-remove").hidden = !dataUrl;
}

function durationLabel(days) {
  if (days === 1) return "24 heures";
  if (days < 30) return `${days} jours`;
  if (days < 365) return `${Math.round(days / 30)} mois`;
  return "1 an";
}

/** Repère du guide de conservation (options du datalist, générées au build) → date proposée. */
function updateSuggestion() {
  const option = [...$("#guide-names").options].find((candidate) => normalize(candidate.value) === normalize(nameInput.value));
  const location = form.elements.location.value;
  const days = option?.dataset[location];
  const suggestion = $("#expiry-suggestion");
  if (!option || days === undefined) {
    suggestion.hidden = true;
    return;
  }
  const date = addDays(todayIso(), Number(days));
  $("#expiry-suggestion-text").textContent = `Guide : ${durationLabel(Number(days))} (${LOCATIONS[location].toLowerCase()}), soit le ${formatDate(date)}.`;
  $("#expiry-suggestion-apply").onclick = () => {
    expiresInput.value = date;
    suggestion.hidden = true;
  };
  suggestion.hidden = expiresInput.value === date;
}

function openDialog(item = null, overrides = {}) {
  editing = item;
  form.reset();
  const values = { ...(item ?? {}), ...overrides };
  $("#item-dialog-title").textContent = item ? "Modifier le produit" : "Ajouter un produit";
  nameInput.value = values.name ?? "";
  form.elements.quantity.value = values.quantity ?? 1;
  form.elements.unit.value = values.unit ?? "pièce";
  form.elements.location.value = values.location ?? "frigo";
  expiresInput.value = values.expiresOn ?? "";
  barcodeInput.value = values.barcode ?? "";
  setPhoto(values.photo ?? null);
  for (const selector of ["#photo-result", "#barcode-result", "#form-error"]) say(selector, "");
  const deleteButton = $("#delete-item");
  deleteButton.hidden = !item;
  deleteButton.textContent = "Supprimer";
  delete deleteButton.dataset.confirm;
  updateSuggestion();
  dialog.showModal();
  if (!item) nameInput.focus();
}

/**
 * Enregistre le formulaire. `base` = le produit modifié, ou null pour un ajout.
 * Renvoie la phrase de résultat : c'est aussi la réponse donnée à un agent IA (WebMCP).
 */
async function submitItem(base, photo) {
  if (!form.checkValidity()) {
    form.reportValidity();
    say("#form-error", "Vérifiez les champs : le nom est obligatoire, le code-barres compte 8 à 14 chiffres.", "error");
    return "Refusé : le nom est obligatoire, la quantité est un nombre positif, le code-barres compte 8 à 14 chiffres.";
  }
  const data = new FormData(form);
  const item = {
    ...(base ?? { id: crypto.randomUUID(), version: 0, createdAt: Date.now() }),
    name: data.get("name").trim(),
    quantity: Number(data.get("quantity")),
    unit: data.get("unit"),
    location: data.get("location"),
    expiresOn: data.get("expiresOn") || null,
    barcode: data.get("barcode").trim() || null,
    photo,
  };
  dialog.close();
  await save(item);
  const message = base ? `« ${item.name} » modifié.` : `« ${item.name} » ajouté.`;
  showToast(message);
  return message;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  // WebMCP (formulaire annoté toolname="ajouter_produit") : un agent ne fait qu'ajouter,
  // jamais modifier le produit éventuellement ouvert, et reçoit la phrase de résultat.
  if (event.agentInvoked) {
    event.respondWith?.(submitItem(null, null));
    return;
  }
  submitItem(editing, draftPhoto);
});
dialog.addEventListener("close", () => {
  editing = null;
});

for (const button of dialog.querySelectorAll("[data-close]")) button.addEventListener("click", () => dialog.close());
nameInput.addEventListener("input", updateSuggestion);
expiresInput.addEventListener("input", updateSuggestion);
for (const radio of form.elements.location) radio.addEventListener("change", updateSuggestion);

$("#delete-item").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!button.dataset.confirm) {
    button.dataset.confirm = "1";
    button.textContent = "Confirmer la suppression";
    return;
  }
  const { id, name } = editing;
  dialog.close();
  await db.deleteItem(id);
  sync.channel?.postMessage({ type: "changed" });
  await refresh();
  showToast(`« ${name} » supprimé.`);
  await requestSync();
});

$("#photo-camera").addEventListener("click", async () => {
  say("#photo-result", "");
  try {
    const photo = await capturePhoto();
    if (photo) setPhoto(photo);
  } catch (error) {
    say("#photo-result", error instanceof CameraError ? error.message : `Photo impossible : ${error.message}`, "error");
  }
});

$("#photo-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    setPhoto(await imageFileToDataUrl(file));
    say("#photo-result", "");
  } catch {
    say("#photo-result", "Cette image n'a pas pu être lue. Essayez une photo JPEG ou PNG.", "error");
  }
  event.target.value = "";
});

$("#photo-remove").addEventListener("click", () => setPhoto(null));

async function lookupBarcode() {
  const code = barcodeInput.value.trim();
  if (!/^\d{8,14}$/.test(code)) {
    say("#barcode-result", "Un code-barres compte 8 à 14 chiffres.", "error");
    return;
  }
  if (!navigator.onLine) {
    say("#barcode-result", "Hors ligne : le code est gardé ; le nom pourra être cherché au retour du réseau.");
    return;
  }
  say("#barcode-result", "Recherche dans Open Food Facts…");
  try {
    const response = await sync.api(`/api/barcode/${code}`);
    const product = await response.json();
    if (!response.ok) {
      say("#barcode-result", product.error ?? "Produit introuvable.", "error");
      return;
    }
    const label = product.brand ? `${product.name} (${product.brand})` : product.name;
    if (!nameInput.value.trim()) {
      nameInput.value = product.name;
      updateSuggestion();
      say("#barcode-result", `Trouvé : ${label}.`, "success");
    } else {
      say("#barcode-result", `Open Food Facts : ${label}. Votre nom est conservé.`, "success");
    }
  } catch {
    say("#barcode-result", "Recherche impossible pour le moment : le code est gardé.", "error");
  }
}

$("#barcode-lookup").addEventListener("click", lookupBarcode);
if (barcodeSupported()) {
  $("#barcode-scan").hidden = false;
  $("#barcode-scan").addEventListener("click", async () => {
    say("#barcode-result", "");
    try {
      const code = await scanBarcode();
      if (!code) return;
      barcodeInput.value = code;
      await lookupBarcode();
    } catch (error) {
      say("#barcode-result", error instanceof CameraError ? error.message : `Lecture impossible : ${error.message}`, "error");
    }
  });
} else {
  $("#barcode-hint").hidden = false; // BarcodeDetector absent (Firefox, Safari, Chrome sous Windows)
}

// ————— Actions sur les listes —————

$("#add-button").addEventListener("click", () => openDialog());

itemList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const item = state.items.find((candidate) => candidate.id === button.closest("[data-id]").dataset.id);
  if (!item) return;
  if (button.dataset.action === "edit") {
    openDialog(item);
    return;
  }
  const quantity = item.unit === "pièce" ? Math.max(0, item.quantity - 1) : 0;
  await save({ ...item, quantity });
  if (quantity === 0) showToast(`« ${item.name} » est fini : il rejoint la liste de courses.`);
});

shoppingList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const item = state.items.find((candidate) => candidate.id === button.closest("[data-id]").dataset.id);
  if (!item) return;
  if (button.dataset.action === "restock") {
    openDialog(item, { quantity: 1, expiresOn: null });
    return;
  }
  await db.deleteItem(item.id);
  sync.channel?.postMessage({ type: "changed" });
  await refresh();
  await requestSync();
});

$("#conflict-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-choice]");
  if (!button) return;
  await db.resolveConflict(button.closest("[data-id]").dataset.id, button.dataset.choice);
  await refresh();
  await requestSync();
});

document.querySelector(".chips").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-status]");
  if (!chip) return;
  state.status = chip.dataset.status;
  render();
});

document.querySelector(".toolbar .segmented").addEventListener("click", (event) => {
  const button = event.target.closest("[data-location]");
  if (!button) return;
  state.location = button.dataset.location;
  render();
});

$("#search").addEventListener("input", (event) => {
  state.query = normalize(event.target.value);
  render();
});

// Liste de courses : Web Share (feuille de partage du téléphone), sinon presse-papiers.
$("#share-button").addEventListener("click", async () => {
  const names = state.items.filter((item) => !(item.quantity > 0)).map((item) => `- ${item.name}`);
  const text = `Liste de courses :\n${names.join("\n")}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Liste de courses — Réserve", text });
      say("#share-result", "Liste partagée.", "success");
    } catch (error) {
      if (error.name !== "AbortError") say("#share-result", `Partage impossible : ${error.message}`, "error");
    }
    return;
  }
  try {
    await copyToClipboard(text);
    say("#share-result", "Partage indisponible sur ce navigateur : la liste est copiée dans le presse-papiers.", "success");
  } catch {
    say("#share-result", "Partage et presse-papiers indisponibles : recopiez la liste ci-dessus.", "error");
  }
});

$("#sync-button").addEventListener("click", async () => {
  say("#foyer-result", "Synchronisation…");
  await runSync("manuel");
  if ($("#foyer-result").dataset.state !== "error") say("#foyer-result", "Inventaire à jour.", "success");
});

// ————— Démarrage —————

const registrationPromise = initPwa();
const params = new URLSearchParams(location.search);
if (params.get("filtre") === "urgent") state.status = "urgent";

await db.getIdentity();
await db.retryRejected();
await refresh();
await renderLastSync();

if (params.get("action") === "ajouter") openDialog();
if (location.search) history.replaceState(null, "", "/"); // le lien d'invitation ne reste pas dans l'historique

foyerUi = await initFoyer({
  db,
  sync,
  invitedFoyer: params.get("foyer"),
  onJoined: async () => {
    await refresh();
    await runSync("foyer");
  },
  onErased: async () => {
    await afterErase("");
    await refresh();
    await renderLastSync();
  },
});

registration = await registrationPromise;
initReminders({ registrationPromise, api: sync.api, onEnabled: () => runSync("rappels") });

// Synchronisation faite par le Service Worker (Background Sync) ou par un autre onglet : on redessine.
sync.channel?.addEventListener("message", async (event) => {
  if (event.data?.type === "synced") await afterSync(event.data.result);
  else if (event.data?.type === "changed") await refresh();
});

// Retour du réseau, page ouverte : on envoie tout de suite, dans tous les navigateurs (repli « online »).
// Si un Background Sync était aussi programmé, le verrou Web Locks les fait passer l'un après l'autre :
// le second trouve l'outbox vide.
window.addEventListener("online", async () => {
  showToast("Connexion rétablie : envoi des modifications en attente.");
  await runSync("retour du réseau");
});
window.addEventListener("offline", () => showToast("Hors ligne : vos modifications restent sur l'appareil."));

// Les changements des autres membres du foyer : au retour au premier plan, puis chaque minute.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastSyncAttempt > 30_000) runSync("premier plan");
});
setInterval(() => {
  if (document.visibilityState === "visible") runSync("périodique");
}, SYNC_INTERVAL_MS);
setInterval(renderLastSync, 30_000);

// Au lancement : récupérer les nouveautés, et vider une outbox remplie lors d'une session fermée hors ligne
// (sans Background Sync, personne d'autre ne le fera).
await runSync("démarrage");
