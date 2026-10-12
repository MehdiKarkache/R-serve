// Serveur local : http://localhost:8888
// - reconstruit dist/ à chaque modification de src/ ou content/ ;
// - sert dist/ avec les en-têtes de src/_headers (les mêmes que Netlify : CSP comprise) ;
// - exécute la vraie fonction netlify/functions/api.mjs, branchée sur un serveur Netlify Blobs local (.netlify/blobs-local).
import { createServer } from "node:http";
import { existsSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";
import { build } from "./build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8888;
const DIST = path.join(ROOT, process.env.DIST_DIR || "dist");
const SITE_URL = `http://localhost:${PORT}`;

if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

// Netlify Blobs en local : même API, mêmes écritures conditionnelles, données dans un dossier.
const blobs = new BlobsServer({ directory: path.join(ROOT, ".netlify/blobs-local"), token: "dev-token" });
const { port: blobsPort } = await blobs.start();
const blobsUrl = `http://localhost:${blobsPort}`;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
  edgeURL: blobsUrl,
  uncachedEdgeURL: blobsUrl,
  siteID: "reserve-local",
  token: "dev-token",
})).toString("base64");

const api = (await import(pathToFileURL(path.join(ROOT, "netlify/functions/api.mjs")).href)).default;
const { sendDailyReminders } = await import(pathToFileURL(path.join(ROOT, "server/push.mjs")).href);
const { openStore } = await import(pathToFileURL(path.join(ROOT, "server/store.mjs")).href);
const { purgeExpired } = await import(pathToFileURL(path.join(ROOT, "server/foyer.mjs")).href);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** Lecture minimale du format _headers de Netlify : un chemin (avec *), puis des lignes « Nom: valeur » indentées. */
async function loadHeaderRules() {
  const rules = [];
  const text = await readFile(path.join(DIST, "_headers"), "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
      rules.push({ pattern, headers: {} });
    } else {
      const index = line.indexOf(":");
      rules.at(-1).headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return rules;
}

let headerRules = [];
async function rebuild(reason) {
  try {
    const { version } = await build({ siteUrl: SITE_URL, outDir: DIST });
    headerRules = await loadHeaderRules();
    console.log(`✔ build ${version}${reason ? ` (${reason})` : ""}`);
  } catch (error) {
    console.error("✖ build", error.message);
  }
}

async function toWebRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { ...req.headers };
  // STRIP_CONDITIONAL=1 imite le CDN de Netlify, qui ne transmet pas toujours If-Match / If-None-Match aux fonctions.
  if (process.env.STRIP_CONDITIONAL) {
    delete headers["if-match"];
    delete headers["if-none-match"];
  }
  return new Request(new URL(req.url, SITE_URL), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
}

async function sendWeb(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, SITE_URL);
  let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(301, { Location: `${pathname}/` }).end();
      return;
    }
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  const status = info ? 200 : 404;
  if (!info) file = path.join(DIST, "404.html");
  const headers = { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate" };
  for (const rule of headerRules) if (rule.pattern.test(pathname)) Object.assign(headers, rule.headers);
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : await readFile(file));
}

await rebuild();

// Tests (E2E=1) : coupure réseau simulée côté serveur. Playwright ne peut pas mettre le Service Worker
// hors ligne : sans cela, Background Sync enverrait pendant un test « hors ligne ».
let networkDown = false;

const server = createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, SITE_URL);
    if (process.env.E2E && pathname === "/__dev/network" && req.method === "POST") {
      networkDown = searchParams.get("state") === "down";
      res.writeHead(204).end();
    } else if (pathname.startsWith("/api/")) {
      if (networkDown) {
        req.socket.destroy();
        return;
      }
      await sendWeb(res, await api(await toWebRequest(req)));
    } else if (pathname === "/__dev/reminders" && req.method === "POST") {
      // Déclenche la tâche planifiée à la main (en production : chaque matin, netlify/functions/daily-reminders.mjs).
      const report = await sendDailyReminders(openStore());
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
    } else if (pathname === "/__dev/purge" && req.method === "POST") {
      // La purge de la tâche quotidienne, éventuellement « dans N jours » (?days=400) pour tester la durée de conservation.
      const now = new Date(Date.now() + Number(searchParams.get("days") ?? 0) * 86_400_000);
      const report = await purgeExpired(openStore(), now);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500).end("Erreur du serveur de développement");
  }
});

server.listen(PORT, () => console.log(`→ ${SITE_URL}`));

if (!process.env.NO_WATCH) {
  let timer = null;
  for (const dir of ["src", "content"]) {
    watch(path.join(ROOT, dir), { recursive: true }, (event, file) => {
      if (/\.png$/.test(file ?? "")) return; // images générées par les scripts : pas de rebuild en pleine capture
      clearTimeout(timer);
      timer = setTimeout(() => rebuild(`${dir}/${file}`), 150);
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await blobs.stop();
    process.exit(0);
  });
}
