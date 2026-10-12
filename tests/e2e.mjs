// Tests de bout en bout dans Chromium (Playwright) : les critères du TP, vérifiés dans un vrai navigateur.
//   npm test        (prérequis une seule fois : npx playwright install chromium)
// Lance son propre serveur (port 8899, dossier dist-test) : le serveur de développement peut rester ouvert.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8899;
const BASE = `http://localhost:${PORT}`;
const results = [];
const consoleErrors = [];

const server = spawn(process.execPath, ["scripts/dev.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DIST_DIR: "dist-test", NO_WATCH: "1", E2E: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Le serveur de test ne répond pas");
}

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`✖ ${name}\n    ${error.message.split("\n").filter(Boolean).slice(0, 4).join("\n    ")}`);
  }
}

async function openApp(context, url = "/") {
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(message.text())) {
      consoleErrors.push(`${page.url()} : ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(`${page.url()} : ${error.message}`));
  await page.goto(BASE + url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return page;
}

/** Coupe ou rétablit le réseau : pour la page (setOffline) et pour le Service Worker (API coupée côté serveur). */
async function setNetwork(context, online) {
  await context.setOffline(!online);
  await fetch(`${BASE}/__dev/network?state=${online ? "up" : "down"}`, { method: "POST" });
}

// Sondage côté Node : page.waitForFunction considère une promesse comme « vraie » sans l'attendre.
async function until(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

const outboxEmpty = (page) =>
  until(async () => (await page.evaluate(() => window.ReserveDB.listOutbox())).length === 0, "l'outbox ne se vide pas");
const identity = (page) => page.evaluate(() => window.ReserveDB.getIdentity());

async function serverItems(foyerId) {
  const response = await fetch(`${BASE}/api/items?since=0`, {
    headers: { Authorization: `Bearer ${foyerId}`, "X-Device-Id": "00000000-0000-4000-8000-000000000000" },
  });
  return (await response.json()).items;
}

async function addProduct(page, { name, unit = "pièce", quantity = "1", applySuggestion = false }) {
  await page.click("#add-button");
  await page.fill("#item-name", name);
  await page.fill("#item-quantity", quantity);
  await page.selectOption("#item-unit", unit);
  if (applySuggestion) await page.click("#expiry-suggestion-apply");
  await page.click("#item-form button[type=submit]");
  await page.locator("#item-list .item-name", { hasText: name }).waitFor();
}

async function editQuantity(page, name, quantity) {
  await page.locator("#item-list .item", { hasText: name }).getByRole("button", { name: `Modifier ${name}` }).click();
  await page.fill("#item-quantity", String(quantity));
  await page.click("#item-form button[type=submit]");
}

await waitForServer();
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const contextA = await browser.newContext({ permissions: ["camera"] });
let pageA;
let foyerId;

await step("L'app se charge, le Service Worker prend le contrôle", async () => {
  pageA = await openApp(contextA);
  assert.match(await pageA.title(), /Réserve/);
  ({ foyerId } = await identity(pageA));
  assert.match(foyerId, /^[0-9a-f-]{36}$/);
});

await step("Installable : aucune erreur d'installabilité (Chrome)", async () => {
  const cdp = await contextA.newCDPSession(pageA);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  assert.deepEqual(installabilityErrors.map((error) => error.errorId), []);
  const { url, data } = await cdp.send("Page.getAppManifest");
  await cdp.detach(); // une session CDP ouverte neutralise l'émulation hors ligne de Playwright
  assert.ok(url.endsWith("/manifest.webmanifest"));
  const manifest = JSON.parse(data);
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192") && manifest.icons.some((icon) => icon.sizes === "512x512"));
});

await step("Ajout d'un produit : date proposée par le guide, puis envoi au serveur", async () => {
  await pageA.click("#add-button");
  await pageA.fill("#item-name", "Lait UHT entamé");
  await pageA.locator("#expiry-suggestion").waitFor();
  assert.match(await pageA.textContent("#expiry-suggestion-text"), /3 jours/);
  await pageA.click("#item-form [data-close]");
  await addProduct(pageA, { name: "Lait UHT entamé", unit: "L", applySuggestion: true });
  await outboxEmpty(pageA);
  const [item] = await serverItems(foyerId);
  assert.equal(item.name, "Lait UHT entamé");
  assert.equal(item.version, 1);
  assert.ok(item.expiresOn, "date de péremption enregistrée");
});

await step("Caméra (permission accordée) : photo du produit synchronisée", async () => {
  await pageA.getByRole("button", { name: "Modifier Lait UHT entamé" }).click();
  await pageA.click("#photo-camera");
  await pageA.waitForFunction(() => document.querySelector("#camera-video").readyState >= 2);
  await pageA.click("#camera-capture");
  await pageA.locator("#photo-preview").waitFor();
  assert.match(await pageA.getAttribute("#photo-preview", "src"), /^data:image\/jpeg;base64,/);
  await pageA.click("#item-form button[type=submit]");
  await pageA.locator("#item-list img.item-photo").waitFor();
  await outboxEmpty(pageA);
  const [item] = await serverItems(foyerId);
  assert.match(item.photo, /^data:image\/jpeg/);
  assert.equal(item.version, 2);
});

await step("Produit fini → liste de courses, puis racheté", async () => {
  await pageA.getByRole("button", { name: "Marquer Lait UHT entamé comme fini" }).click();
  await pageA.locator("#shopping-list .item-name", { hasText: "Lait UHT entamé" }).waitFor();
  await pageA.getByRole("button", { name: "Lait UHT entamé racheté" }).click();
  await pageA.click("#item-form button[type=submit]");
  await pageA.locator("#item-list .item-name", { hasText: "Lait UHT entamé" }).waitFor();
  await outboxEmpty(pageA);
});

await step("Hors ligne : l'app, ses données et la bannière s'affichent ; les actions réseau sont désactivées", async () => {
  await setNetwork(contextA, false);
  await pageA.reload();
  await pageA.locator("#item-list .item-name", { hasText: "Lait UHT entamé" }).waitFor();
  assert.equal(await pageA.isVisible("#offline-banner"), true, "bannière hors ligne");
  assert.equal(await pageA.isDisabled("#sync-button"), true, "bouton Synchroniser désactivé");
  assert.equal(await pageA.isDisabled("#reminders-enable"), true, "bouton Activer les rappels désactivé");
  assert.match(await pageA.textContent("#network-status"), /Hors ligne/);
});

await step("Hors ligne : le guide et la page « Vos données » sont disponibles, une page inconnue affiche la page de secours", async () => {
  const guide = await contextA.newPage();
  await guide.goto(`${BASE}/guide/`);
  assert.match(await guide.textContent("h1"), /Guide de conservation/);
  await guide.goto(`${BASE}/confidentialite/`);
  assert.match(await guide.textContent("h1"), /Vos données/);
  await guide.goto(`${BASE}/page-inconnue`);
  assert.match(await guide.textContent("h1"), /pas disponible hors ligne/);
  await guide.close();
});

await step("Hors ligne : un ajout va dans l'outbox et part au retour du réseau", async () => {
  try {
    await addProduct(pageA, { name: "Restes de repas maison", applySuggestion: true });
    const outbox = await pageA.evaluate(() => window.ReserveDB.listOutbox());
    assert.equal(outbox.length, 1, `outbox : ${JSON.stringify(outbox)}`);
    assert.match(await pageA.textContent("#network-status"), /1 en attente/);
  } finally {
    await setNetwork(contextA, true);
  }
  await outboxEmpty(pageA);
  assert.equal((await serverItems(foyerId)).length, 2);
});

const contextB = await browser.newContext();
let pageB;

await step("Second appareil : le lien d'invitation fait rejoindre le foyer et récupère l'inventaire", async () => {
  pageB = await openApp(contextB, `/?foyer=${foyerId}`);
  await pageB.locator("#join-banner").waitFor();
  await pageB.click("#join-confirm");
  await pageB.locator("#item-list .item-name", { hasText: "Restes de repas maison" }).waitFor();
  assert.equal((await identity(pageB)).foyerId, foyerId);
  assert.equal(new URL(pageB.url()).search, "", "le lien d'invitation est retiré de l'URL");
});

await step("Conflit : deux modifications hors ligne → 412, rien n'est écrasé, l'utilisateur choisit", async () => {
  await contextB.setOffline(true);
  await setNetwork(contextA, false);
  await editQuantity(pageA, "Restes de repas maison", 5);
  await editQuantity(pageB, "Restes de repas maison", 7);
  await setNetwork(contextA, true);
  await outboxEmpty(pageA);
  await setNetwork(contextB, true);
  await pageB.locator("#conflicts").waitFor({ timeout: 15_000 });
  assert.match(await pageB.textContent("#conflict-list"), /Quantité : 7 pièces ici, 5 pièces sur l'autre appareil/);
  const before = (await serverItems(foyerId)).find((item) => item.name === "Restes de repas maison");
  assert.equal(before.quantity, 5, "la version de A n'a pas été écrasée");
  await pageB.getByRole("button", { name: "Garder ma version" }).click();
  await outboxEmpty(pageB);
  const after = (await serverItems(foyerId)).find((item) => item.name === "Restes de repas maison");
  assert.equal(after.quantity, 7);
  await pageA.click("#sync-button");
  await pageA.locator("#item-list .item", { hasText: "Restes de repas maison" }).filter({ hasText: "7 pièces" }).waitFor();
});

await step("Suppression sur un appareil → disparaît sur l'autre", async () => {
  await pageB.getByRole("button", { name: "Modifier Restes de repas maison" }).click();
  await pageB.click("#delete-item");
  await pageB.click("#delete-item");
  await outboxEmpty(pageB);
  await pageA.click("#sync-button");
  await pageA.locator("#item-list .item-name", { hasText: "Restes de repas maison" }).waitFor({ state: "detached" });
});

await step("RGPD : export JSON, puis effacement du foyer (serveur, cet appareil, l'autre appareil) et durée de conservation", async () => {
  const [download] = await Promise.all([pageA.waitForEvent("download"), pageA.click("#export-button")]);
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.foyer, foyerId);
  assert.ok(exported.items.length >= 1, "l'export ne contient aucun produit");

  await pageA.click("#erase-button"); // premier clic : arme le bouton
  await pageA.click("#erase-button"); // second clic : efface
  await until(async () => (await pageA.textContent("#foyer-result")).includes("effacées"), "l'effacement ne se termine pas");
  assert.equal(await pageA.locator("#item-list .item").count(), 0);
  assert.notEqual((await identity(pageA)).foyerId, foyerId, "l'appareil garde l'ancien foyer");
  const gone = await fetch(`${BASE}/api/items?since=0`, {
    headers: { Authorization: `Bearer ${foyerId}`, "X-Device-Id": "00000000-0000-4000-8000-000000000000" },
  });
  assert.equal(gone.status, 410, "le serveur sert encore l'ancien foyer");

  await pageB.click("#sync-button"); // l'autre appareil apprend l'effacement (410) et efface sa copie
  await until(async () => (await identity(pageB)).foyerId !== foyerId, "le second appareil garde l'ancien foyer");
  await until(async () => (await pageB.locator("#item-list .item").count()) === 0, "le second appareil garde ses produits");

  // Dans 400 jours : la fiche d'effacement est supprimée, et les foyers devenus inactifs aussi.
  const purge = await (await fetch(`${BASE}/__dev/purge?days=400`, { method: "POST" })).json();
  assert.ok(purge.markers >= 1 && purge.inactive >= 1, `purge inattendue : ${JSON.stringify(purge)}`);
});

await step("Mise à jour : nouveau déploiement → bannière → la nouvelle version s'active au clic", async () => {
  const swPath = path.join(ROOT, "dist-test/sw.js");
  const original = await readFile(swPath, "utf8");
  await writeFile(swPath, original.replace(/"version": "[0-9a-f]+"/, '"version": "e2e-update"'));
  try {
    await pageA.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await pageA.locator("#update-banner").waitFor();
    await Promise.all([pageA.waitForEvent("load"), pageA.click("#update-now")]);
    await until(async () => (await pageA.evaluate(() => caches.keys())).join() === "reserve-e2e-update", "le nouveau cache ne remplace pas l'ancien");
    assert.equal(await pageA.evaluate(() => navigator.serviceWorker.controller.state), "activated");
  } finally {
    await writeFile(swPath, original);
  }
});

await step("JSON-LD valide sur l'accueil et le guide", async () => {
  for (const url of ["/", "/guide/"]) {
    await pageB.goto(BASE + url);
    const blocks = await pageB.$$eval('script[type="application/ld+json"]', (scripts) => scripts.map((script) => JSON.parse(script.textContent)));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]["@context"], "https://schema.org");
  }
});

// Navigateur sans faux consentement : la permission caméra n'est pas accordée.
const strictBrowser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--deny-permission-prompts"] });
const contextC = await strictBrowser.newContext();

await step("Caméra refusée : message explicatif et repli sur le choix d'un fichier, pas d'erreur", async () => {
  // L'utilisateur clique « Bloquer » : un vrai navigateur rejette getUserMedia avec NotAllowedError.
  // Chromium sans écran ne sait pas afficher la question ; on reproduit donc exactement cette réponse.
  await contextC.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  const page = await openApp(contextC);
  await page.click("#add-button");
  await page.click("#photo-camera");
  await page.locator("#photo-result[data-state=error]").waitFor();
  assert.match(await page.textContent("#photo-result"), /refusé|Aucune caméra/);
  assert.equal(await page.isVisible("#camera-dialog"), false);
  assert.equal(await page.isVisible(".file-button"), true);
});

await step("Notifications refusées : message, l'app continue", async () => {
  const page = contextC.pages()[0];
  await page.reload();
  await page.click("#reminders-enable");
  await page.locator("#reminders-result[data-state=error]").waitFor();
  assert.match(await page.textContent("#reminders-result"), /refusées/);
});

await step("Aucune erreur dans la console (CSP comprise)", async () => {
  assert.deepEqual(consoleErrors, []);
});

await strictBrowser.close();
await browser.close();
server.kill();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies`);
process.exit(failed.length ? 1 : 0);
