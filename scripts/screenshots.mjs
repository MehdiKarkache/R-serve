// Captures d'écran du manifest (fenêtre d'installation enrichie d'Android et de Chrome).
// Prérequis : le serveur local tourne (npm run dev). Puis : npm run screenshots
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://localhost:8888";

const DEMO = [
  ["Yaourts nature", 4, "pièce", "frigo", -1],
  ["Lasagnes maison", 2, "pièce", "frigo", 0],
  ["Lait UHT entamé", 1, "L", "frigo", 1],
  ["Tomates", 6, "pièce", "placard", 4],
  ["Comté", 250, "g", "frigo", 14],
  ["Steak haché", 2, "pièce", "congelateur", 60],
  ["Petits pois", 1, "kg", "congelateur", 120],
  ["Pâtes complètes", 500, "g", "placard", 240],
  ["Café moulu", 0, "g", "placard", null],
  ["Œufs", 0, "pièce", "frigo", null],
];

const browser = await chromium.launch();

async function capture(file, viewport, deviceScaleFactor, colorScheme = "light") {
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.ReserveDB);
  await page.evaluate(async (demo) => {
    const today = new Date();
    for (const [name, quantity, unit, location, days] of demo) {
      const date = days === null ? null : new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
      const expiresOn = date && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      await window.ReserveDB.saveItem({ id: crypto.randomUUID(), version: 0, name, quantity, unit, location, expiresOn, barcode: null, photo: null, createdAt: Date.now(), updatedAt: Date.now() });
    }
  }, DEMO);
  await page.reload();
  await page.locator("#item-list .item").first().waitFor();
  await page.evaluate(() => document.querySelector("#inventaire").scrollIntoView());
  await page.evaluate(() => window.scrollBy(0, -70));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(ROOT, file) });
  console.log(`✔ ${file}`);
  await context.close();
}

await capture("src/screenshots/mobile.png", { width: 360, height: 780 }, 1.5);
await capture("src/screenshots/desktop.png", { width: 1280, height: 800 }, 1);
if (process.env.ALL) {
  await capture("docs/mobile-dark.png", { width: 360, height: 780 }, 1.5, "dark");
}
await browser.close();
