// Build de Réserve : du SSG sans framework.
// 1. copie src/ dans dist/ ;
// 2. génère le contenu public (guide de conservation) dans le HTML initial, à partir de content/*.json ;
// 3. écrit les fichiers de découverte : robots.txt, sitemap.xml, llms.txt, jumelles Markdown ;
// 4. calcule l'empreinte de l'App Shell et l'inscrit dans sw.js (= version du cache).
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

// Hors App Shell : inutiles hors ligne (robots, sitemap…) ou lourds et jamais affichés dans l'app (images de partage).
const NOT_PRECACHED = [/^sw\.js$/, /^_headers$/, /^robots\.txt$/, /^sitemap\.xml$/, /^llms\.txt$/, /^404\.html$/, /^index\.md$/, /^social\//, /^screenshots\//];

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const jsonLd = (data) => JSON.stringify(data, null, 2).replaceAll("<", "\\u003c");
const frenchDate = (iso) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
// data-label : sur mobile, le tableau devient une fiche par aliment et chaque cellule affiche le nom de sa colonne.
const cell = (value, label) => (value
  ? `<td data-label="${label}">${escapeHtml(value)}</td>`
  : `<td data-label="${label}" class="cell-empty"><span class="muted" aria-label="Déconseillé">—</span></td>`);

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }));
  return files.flat().sort();
}

function guideRows(entries) {
  return entries.map((entry) => `
            <tr>
              <th scope="row">${escapeHtml(entry.name)}${entry.tip ? `<span class="tip">${escapeHtml(entry.tip)}</span>` : ""}</th>
              ${cell(entry.frigo, "Réfrigérateur")}
              ${cell(entry.congelateur, "Congélateur")}
              ${cell(entry.placard, "Placard")}
            </tr>`).join("");
}

function guideTable(entries, caption) {
  return `<div class="table-scroll">
          <table class="guide-table">
            <caption>${escapeHtml(caption)}</caption>
            <thead><tr><th scope="col">Aliment</th><th scope="col">Réfrigérateur</th><th scope="col">Congélateur</th><th scope="col">Placard</th></tr></thead>
            <tbody>${guideRows(entries)}
            </tbody>
          </table>
        </div>`;
}

function renderPlaceholders(html, values, file) {
  const output = html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`${file} : variable inconnue ${match}`);
    return values[key];
  });
  return output;
}

function markdownGuide(guide, siteUrl) {
  const lines = [
    `# ${guide.title}`,
    "",
    `> ${guide.description}`,
    "",
    `Mis à jour le ${frenchDate(guide.updated)}. ${guide.disclaimer}`,
    "",
  ];
  for (const category of guide.categories) {
    lines.push(`## ${category.name}`, "", "| Aliment | Réfrigérateur | Congélateur | Placard |", "|---|---|---|---|");
    for (const entry of category.entries) {
      lines.push(`| ${entry.name} | ${entry.frigo ?? "—"} | ${entry.congelateur ?? "—"} | ${entry.placard ?? "—"} |`);
    }
    const tips = category.entries.filter((entry) => entry.tip);
    if (tips.length) lines.push("", ...tips.map((entry) => `- ${entry.name} : ${entry.tip}`));
    lines.push("");
  }
  lines.push("## Questions fréquentes", "");
  for (const item of guide.faq) {
    const source = guide.sources[item.source];
    lines.push(`### ${item.q}`, "", item.a, "", `Source : [${source.name}](${source.url}), ${source.publisher}.`, "");
  }
  lines.push("## Sources", "", ...guide.sources.map((source) => `- [${source.name}](${source.url}) — ${source.publisher}, ${frenchDate(source.date)}`), "");
  lines.push(`Page HTML : ${siteUrl}/guide/`, "");
  return lines.join("\n");
}

function markdownHome(site, guide, excerpt, siteUrl) {
  return [
    `# ${site.name}`,
    "",
    `> ${site.description}`,
    "",
    "## Ce que fait l'application",
    "",
    "- Inventaire du réfrigérateur, du congélateur et du placard, avec la date de péremption de chaque produit.",
    "- Fonctionne hors ligne : les produits sont enregistrés sur l'appareil, puis synchronisés au retour du réseau.",
    "- Partagé entre les membres du foyer grâce à un lien d'invitation.",
    "- Rappel chaque matin des produits qui périment dans les deux jours (notification push).",
    "- Photo du produit et lecture du code-barres avec la caméra du téléphone.",
    "- Liste de courses partageable.",
    "",
    "## Repères de conservation",
    "",
    "| Aliment | Réfrigérateur | Congélateur | Placard |",
    "|---|---|---|---|",
    ...excerpt.map((entry) => `| ${entry.name} | ${entry.frigo ?? "—"} | ${entry.congelateur ?? "—"} | ${entry.placard ?? "—"} |`),
    "",
    `Le guide complet : [${guide.title}](${siteUrl}/guide.md).`,
    "",
  ].join("\n");
}

export async function build({ siteUrl = process.env.SITE_URL || process.env.URL || "http://localhost:8888", outDir = path.join(ROOT, "dist") } = {}) {
  siteUrl = siteUrl.replace(/\/$/, "");
  const site = JSON.parse(await readFile(path.join(ROOT, "content/site.json"), "utf8"));
  const guide = JSON.parse(await readFile(path.join(ROOT, "content/guide.json"), "utf8"));
  const entries = guide.categories.flatMap((category) => category.entries.map((entry) => ({ ...entry, category: category.name })));
  const excerpt = site.excerpt.map((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`content/site.json : repère inconnu ${id}`);
    return entry;
  });

  await rm(outDir, { recursive: true, force: true });
  await cp(SRC, outDir, { recursive: true });
  await mkdir(path.join(outDir, "vendor"), { recursive: true });
  await cp(path.join(ROOT, "node_modules/idb/build/umd.js"), path.join(outDir, "vendor/idb.js"));

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    name: guide.title,
    description: guide.description,
    url: `${siteUrl}/guide/`,
    inLanguage: "fr",
    dateModified: guide.updated,
    isPartOf: { "@type": "WebSite", name: site.name, url: `${siteUrl}/` },
    citation: guide.sources.map((source) => ({ "@type": "CreativeWork", name: source.name, url: source.url, publisher: source.publisher })),
    mainEntity: guide.faq.map((item) => ({ "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })),
  };

  const values = {
    SITE_URL: siteUrl,
    SITE_TITLE: escapeHtml(site.title),
    SITE_DESCRIPTION: escapeHtml(site.description),
    GUIDE_TITLE: escapeHtml(guide.title),
    GUIDE_DESCRIPTION: escapeHtml(guide.description),
    GUIDE_DISCLAIMER: escapeHtml(guide.disclaimer),
    GUIDE_UPDATED: guide.updated,
    GUIDE_UPDATED_LABEL: frenchDate(guide.updated),
    GUIDE_COUNT: String(entries.length),
    GUIDE_EXCERPT: guideTable(excerpt, "Durées de conservation de quelques aliments courants"),
    GUIDE_TOC: guide.categories.map((category) => `
            <li><a href="#${category.id}">${escapeHtml(category.name)}</a></li>`).join(""),
    GUIDE_TABLES: guide.categories.map((category) => `
        <section class="guide-category" id="${category.id}" aria-labelledby="${category.id}-title">
          <h2 id="${category.id}-title">${escapeHtml(category.name)}</h2>
          ${guideTable(category.entries, `Durées de conservation — ${category.name}`)}
        </section>`).join(""),
    GUIDE_FAQ: guide.faq.map((item) => {
      const source = guide.sources[item.source];
      return `
          <article class="faq-item">
            <h3>${escapeHtml(item.q)}</h3>
            <p>${escapeHtml(item.a)}</p>
            <p class="source">Source : <a href="${source.url}" rel="noopener">${escapeHtml(source.name)}</a>, ${escapeHtml(source.publisher)}.</p>
          </article>`;
    }).join(""),
    GUIDE_SOURCES: guide.sources.map((source) => `
            <li><a href="${source.url}" rel="noopener">${escapeHtml(source.name)}</a> — ${escapeHtml(source.publisher)}, <time datetime="${source.date}">${frenchDate(source.date)}</time></li>`).join(""),
    GUIDE_JSONLD: jsonLd(faqJsonLd),
    PRIVACY_UPDATED: site.privacyUpdated,
    PRIVACY_UPDATED_LABEL: frenchDate(site.privacyUpdated),
    AUTHOR: escapeHtml(site.author),
    // Les repères du guide, lus par le formulaire pour proposer une date de péremption (data-frigo = jours au réfrigérateur…).
    GUIDE_DATALIST: entries.map((entry) => {
      const days = Object.entries(entry.days ?? {}).map(([location, count]) => ` data-${location}="${count}"`).join("");
      return `<option value="${escapeHtml(entry.name)}"${days}></option>`;
    }).join("\n        "),
  };

  if (site.author.startsWith("‹")) console.warn("⚠ content/site.json : renseignez « author » (affiché sur /confidentialite/).");

  for (const file of ["index.html", "guide/index.html", "confidentialite/index.html", "offline.html", "404.html"]) {
    const target = path.join(outDir, file);
    await writeFile(target, renderPlaceholders(await readFile(target, "utf8"), values, file));
  }

  await writeFile(path.join(outDir, "guide.md"), markdownGuide(guide, siteUrl));
  await writeFile(path.join(outDir, "index.md"), markdownHome(site, guide, excerpt, siteUrl));

  await writeFile(path.join(outDir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${siteUrl}/</loc><lastmod>${site.updated}</lastmod></url>
  <url><loc>${siteUrl}/guide/</loc><lastmod>${guide.updated}</lastmod></url>
  <url><loc>${siteUrl}/confidentialite/</loc><lastmod>${site.privacyUpdated}</lastmod></url>
</urlset>
`);

  await writeFile(path.join(outDir, "robots.txt"), `# robots.txt — ${site.name}
# Réserve est un produit : être trouvé et cité, c'est être utilisé. Tout le contenu public est ouvert.
# Seule l'API est fermée : elle ne sert que des données privées, derrière un jeton de foyer.
User-agent: *
Allow: /
Disallow: /api/

# Crawlers d'IA : une décision par robot, avec sa raison.
# GPTBot, ClaudeBot : un modèle qui connaît le guide de conservation peut recommander l'application.
User-agent: GPTBot
User-agent: ClaudeBot
Allow: /
Disallow: /api/

# OAI-SearchBot, Claude-SearchBot, PerplexityBot : réponses avec lien vers la source, donc des visites.
User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
Allow: /
Disallow: /api/

# Google-Extended : Gemini peut s'appuyer sur le guide et le citer ; le bloquer ne protégerait rien.
User-agent: Google-Extended
Allow: /
Disallow: /api/

# CCBot (Common Crawl) : archive redistribuée sans lien vers la source. Coût de bande passante, aucune visite.
User-agent: CCBot
Disallow: /

Sitemap: ${siteUrl}/sitemap.xml
# llms.txt : ${siteUrl}/llms.txt
`);

  await writeFile(path.join(outDir, "llms.txt"), `# ${site.name}

> ${site.description}

Projet du cours M2 Informatique, Università di Corsica. Application gratuite, sans compte : l'inventaire reste sur l'appareil et se synchronise entre les membres du foyer.

## Contenu public

- [${guide.title} (Markdown)](${siteUrl}/guide.md) : ${entries.length} aliments, durées au réfrigérateur, au congélateur et au placard ; différence entre DLC et DDM ; sources officielles.
- [Présentation de l'application (Markdown)](${siteUrl}/index.md)

## Pages

- [Accueil et application](${siteUrl}/)
- [${guide.title}](${siteUrl}/guide/)
- [Vos données et vos droits](${siteUrl}/confidentialite/) : ce que l'application enregistre, où, combien de temps

## Technique

- PWA sans framework : Service Worker, API Cache, IndexedDB (idb), Web App Manifest
- Synchronisation : outbox IndexedDB, Background Sync, contrôle de version If-Match
- Notifications : Web Push (VAPID), rappel quotidien par une fonction planifiée
- Hébergement : Netlify (fichiers statiques, Functions, Blobs)
`);

  // Empreinte de l'App Shell : elle change dès qu'un fichier précaché change, donc sw.js change,
  // donc le navigateur détecte une nouvelle version. Plus besoin d'incrémenter CACHE_NAME à la main.
  const files = await listFiles(outDir);
  const precached = files.filter((file) => !NOT_PRECACHED.some((pattern) => pattern.test(file)));
  const hash = createHash("sha256");
  for (const file of precached) {
    hash.update(file);
    hash.update(await readFile(path.join(outDir, file)));
  }
  const version = hash.digest("hex").slice(0, 12);
  const urls = precached.map((file) => (file === "index.html" ? "/" : `/${file.replace(/(^|\/)index\.html$/, "$1")}`));

  const swPath = path.join(outDir, "sw.js");
  const sw = await readFile(swPath, "utf8");
  const marker = 'const BUILD = { version: "dev", precache: [] };';
  if (!sw.includes(marker)) throw new Error("sw.js : marqueur BUILD introuvable");
  await writeFile(swPath, sw.replace(marker, `const BUILD = ${JSON.stringify({ version, precache: urls }, null, 2)};`));

  for (const file of files.filter((name) => /\.(html|txt|xml|md|webmanifest)$/.test(name))) {
    if ((await readFile(path.join(outDir, file), "utf8")).includes("{{")) throw new Error(`${file} : variable non remplacée`);
  }
  return { version, precache: urls, siteUrl, outDir };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await build();
  console.log(`✔ Build ${result.version} → ${path.relative(ROOT, result.outDir)} (${result.precache.length} fichiers précachés, ${result.siteUrl})`);
}
