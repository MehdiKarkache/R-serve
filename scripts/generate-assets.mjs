// Génère les images à partir de src/icons/icon.svg avec un navigateur sans tête (Playwright).
// À relancer seulement si l'icône change : les PNG produits sont versionnés dans src/.
//   npm run assets
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const svg = await readFile(path.join(SRC, "icons/icon.svg"), "utf8");
const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
// Le même dessin sans le carré arrondi : pour l'icône maskable (fond plein) et le badge.
const artwork = svg.replace(/<rect width="512" height="512" rx="112" fill="#2f6b4f"\/>/, "");
const artworkUri = `data:image/svg+xml;base64,${Buffer.from(artwork).toString("base64")}`;

const page = (body, size, background = "transparent") => `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${size.width}px; height: ${size.height}px; background: ${background}; overflow: hidden; }
  body { display: grid; place-items: center; font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });
const tab = await context.newPage();

async function render(file, html, size, { transparent = true } = {}) {
  await tab.setViewportSize(size);
  await tab.setContent(html);
  await tab.waitForLoadState("load");
  await mkdir(path.dirname(path.join(SRC, file)), { recursive: true });
  await tab.screenshot({ path: path.join(SRC, file), omitBackground: transparent });
  console.log(`✔ ${file}`);
}

for (const size of [192, 512]) {
  await render(`icons/icon-${size}.png`, page(`<img src="${dataUri}" width="${size}" height="${size}">`, { width: size, height: size }), { width: size, height: size });
}

// Maskable : fond plein jusqu'aux bords, dessin dans la zone sûre (cercle de 80 %).
for (const size of [192, 512]) {
  const art = Math.round(size * 0.78);
  await render(`icons/icon-maskable-${size}.png`,
    page(`<img src="${artworkUri}" width="${art}" height="${art}">`, { width: size, height: size }, "#2f6b4f"),
    { width: size, height: size }, { transparent: false });
}

// iOS ignore la transparence et arrondit lui-même : fond plein.
await render("icons/apple-touch-icon.png",
  page(`<img src="${artworkUri}" width="160" height="160">`, { width: 180, height: 180 }, "#2f6b4f"),
  { width: 180, height: 180 }, { transparent: false });

// Badge de notification Android : silhouette blanche sur fond transparent.
await render("icons/badge-96.png",
  page(`<img src="${artworkUri}" width="96" height="96" style="filter: brightness(0) invert(1)">`, { width: 96, height: 96 }),
  { width: 96, height: 96 });

const shortcut = (symbol, color) => page(`<div style="width:96px;height:96px;border-radius:22px;background:${color};display:grid;place-items:center;color:#fff;font-size:58px;font-weight:700;line-height:1">${symbol}</div>`, { width: 96, height: 96 });
await render("icons/shortcut-add-96.png", shortcut("+", "#2f6b4f"), { width: 96, height: 96 });
await render("icons/shortcut-urgent-96.png", shortcut("!", "#b45309"), { width: 96, height: 96 });

// Image de partage (Open Graph) : 1200 × 630.
const ogItems = [
  ["Lait entamé", "Demain", "#9a4a07"],
  ["Lasagnes", "Aujourd'hui", "#9a4a07"],
  ["Yaourts", "Périmés", "#b3261e"],
].map(([name, label, color]) => `<li style="display:flex;justify-content:space-between;gap:24px;padding:20px 24px;border-radius:16px;background:#fffdf8;margin-bottom:14px;font-size:30px;white-space:nowrap"><span style="font-weight:650;color:#1d2a22">${name}</span><span style="color:${color};font-weight:700">${label}</span></li>`).join("");
await render("social/og-image.png", page(`
  <div style="display:grid;grid-template-columns:1fr 520px;gap:56px;align-items:center;width:1080px">
    <div>
      <img src="${dataUri}" width="132" height="132" style="margin-bottom:28px">
      <div style="font-size:84px;font-weight:800;color:#1d2a22;letter-spacing:-1px">Réserve</div>
      <div style="font-size:36px;color:#2f4a3b;margin-top:12px;line-height:1.25">L'inventaire du garde-manger, même hors ligne.</div>
    </div>
    <ul style="list-style:none;margin:0;padding:28px;border-radius:24px;background:#dcebe2">
      <li style="font-size:24px;font-weight:700;color:#1f4d38;margin:0 0 18px 4px">À consommer vite</li>
      ${ogItems}
    </ul>
  </div>`, { width: 1200, height: 630 }, "#f6f3ec"), { width: 1200, height: 630 }, { transparent: false });

await browser.close();
