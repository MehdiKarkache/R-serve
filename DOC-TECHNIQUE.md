# Réserve — Technical Design Doc

Auteur : *‹ votre nom ›* · Date : 12 octobre 2026 · Production : *‹ https://votre-site.netlify.app ›* · Dépôt : *‹ https://github.com/votre-compte/reserve-pwa ›* · Statut : **draft** (passe en *final* une fois les mesures refaites en production, § 11)

## 1. TL;DR

Réserve est l'inventaire du garde-manger d'un foyer : ce qu'il y a dans le réfrigérateur, le congélateur et le placard, avec les dates de péremption. Elle est faite pour les foyers qui jettent des produits oubliés ; elle marche hors ligne, se partage entre les téléphones de la maison et envoie chaque matin un rappel des produits à consommer vite. Le choix technique principal : **IndexedDB est la source de vérité sur l'appareil**, et chaque modification part au serveur par une **outbox avec contrôle de version** (`If-Match`). L'application n'attend jamais le réseau, et deux appareils ne s'écrasent jamais.

## 2. Contexte et objectifs

- **Problème** : on oublie ce qu'il y a au fond du frigo, et on le jette. Sujet du Hub : *inventaire*.
- **Goals (v1)** : produits (nom, quantité, unité, emplacement, date, photo, code-barres) triés par urgence et filtrables ; liste de courses (produits à quantité 0) partageable ; fonctionnement complet hors ligne ; inventaire partagé par foyer ; rappel push quotidien et badge sur l'icône ; guide public de conservation, qui sert aussi à proposer une date de péremption dans le formulaire.
- **Non-goals** : comptes et mots de passe (le foyer est un lien secret, § 10) ; recettes ; historique et statistiques ; temps réel (un sondage toutes les 60 s suffit pour un frigo) ; autre langue que le français.

## 3. Architecture

- **Stack** : HTML, CSS et JavaScript sans framework (modules ES), [`idb`](https://github.com/jakearchibald/idb) 8 pour IndexedDB, Service Worker écrit à la main (`src/sw.js`, ≈ 130 lignes). Pas de Workbox : chaque stratégie se lit en quelques lignes et se justifie. Pas de framework : l'interface est une liste et un formulaire, et sans dépendance le TBT reste à 0 ms.
- **Build** (`scripts/build.mjs`, du SSG sans framework) : il génère le contenu public du guide dans le HTML à partir de `content/guide.json`, écrit `robots.txt`, `sitemap.xml`, `llms.txt` et les jumelles Markdown, puis inscrit l'empreinte des fichiers dans `sw.js` (§ 5).
- **Serveur** : Netlify Functions, sur la même origin que la page (pas de CORS, CSP `connect-src 'self'`). `netlify/functions/api.mjs` sert toute l'API `/api/*` ; `netlify/functions/daily-reminders.mjs` est une fonction planifiée (`0 7 * * *`). Stockage : **Netlify Blobs** (clé-valeur avec écritures conditionnelles). Le cours propose Firebase ; j'ai préféré une API REST sur la même origin, pour trois raisons : la CSP reste `connect-src 'self'` sans SDK tiers, l'écriture conditionnelle sur l'ETag rend le contrôle de version atomique, et VAPID suffit pour le push sans Firebase (jour 2, ch. 5). Pour la partie Android, l'app native appellera la même API REST ; seul le push natif demandera d'ajouter un envoi FCM au serveur.

```text
 Page (js/app.js…)                     Service Worker (sw.js)                      Netlify
 ├─ IndexedDB « reserve » ◀─────────── importScripts shared/db.js + shared/sync.js
 │   items · outbox · conflicts · meta
 ├─ pages, CSS, JS, icônes ──────────▶ Cache API reserve-<empreinte> (Cache First)
 ├─ /api/* (réseau seul) ─────────────────────────────────────────────────────────▶ api.mjs ──▶ Blobs « reserve »
 │                                     sync (Background Sync) → syncAll ──────────▶   ▲
 │                                     push ◀── service push ◀── web-push ◀── daily-reminders.mjs (cron)
```

- **Hébergement et déploiement** : Netlify, relié au dépôt GitHub. Chaque push sur `main` lance `npm run build` (`netlify.toml`), publie `dist/` et déploie les fonctions. Les clés VAPID sont des variables d'environnement Netlify.

## 4. Cache et hors ligne

| Ressource | Stratégie | Stockage | Pourquoi |
|---|---|---|---|
| HTML (`/`, `/guide/`, `/confidentialite/`, `offline.html`) | Cache First sur le précache, `ignoreSearch` | Cache API `reserve-<empreinte>` | Le tableau du cours propose SWR pour le HTML. J'ai choisi Cache First parce que le HTML est versionné avec le CSS et le JS : ils arrivent toujours ensemble, alors que SWR afficherait un HTML neuf avec un JS ancien. Les nouveautés passent par la bannière (§ 5). `/?filtre=urgent` est servi par le même `index.html`. |
| CSS, JS, icônes, `guide.md`, `idb` | Cache First (précache) | Cache API | Ils ne changent qu'au déploiement, et chaque déploiement change l'empreinte. |
| Données de l'utilisateur | IndexedDB d'abord, synchronisation en arrière-plan | IndexedDB | L'écran se dessine depuis IndexedDB, en ligne comme hors ligne. |
| `/api/*` | Réseau seul (le SW ne répond pas) | — | Données privées : jamais servies périmées depuis un cache. |
| `robots.txt`, `sitemap.xml`, `llms.txt`, images de partage | Hors précache | — | Inutiles hors ligne. |

- **Hors ligne** (mode avion) : l'application s'ouvre avec tout l'inventaire. Ajouter, modifier ou supprimer reste possible (outbox), et le guide de conservation reste lisible. Une bannière « Hors ligne » s'affiche, et la pastille indique « Hors ligne · N en attente ».
- **Désactivé hors ligne**, avec la mention « · hors ligne » sur le bouton : Synchroniser, Trouver le nom (code-barres), Activer et tester les rappels, Supprimer les données du foyer (attribut `data-requires-network`, `js/pwa.js`).
- **Page de secours** : toute page non précachée affiche `offline.html`.

## 5. Mise à jour

- **Stratégie : la nouvelle version est proposée, pas imposée** (bannière « Une nouvelle version de Réserve est prête — Mettre à jour »). Pourquoi pour cette app : on s'en sert debout devant le frigo, formulaire en cours ou caméra ouverte, et un rechargement imposé ferait perdre la saisie. Une PWA installée reste aussi ouverte des jours, d'où `registration.update()` à chaque retour au premier plan.
- **Mécanisme** :
  1. Le build calcule un SHA-256 des fichiers précachés et l'écrit dans `sw.js` (`BUILD.version`). Le cache s'appelle `reserve-<12 caractères>` : **plus besoin d'incrémenter `CACHE_NAME` à la main**, donc impossible d'oublier.
  2. `sw.js` est servi en `Cache-Control: no-cache` (`_headers`) et enregistré avec `updateViaCache: "none"`.
  3. Pas de `skipWaiting` à l'installation. Le SW en attente est détecté par `updatefound` ou par `registration.waiting`, et la bannière s'affiche. Le clic envoie `postMessage({ type: "SKIP_WAITING" })`. L'activation supprime les anciens caches et appelle `clients.claim()`. L'événement `controllerchange` recharge alors la page, sauf au tout premier chargement.

## 6. Données et synchronisation

- **IndexedDB `reserve` v1** (`src/shared/db.js`) :
  - `items`, clé `id` (UUID). Champs : `name`, `quantity`, `unit`, `location`, `expiresOn` (AAAA-MM-JJ ou `null`), `photo` (JPEG ≤ 480 px en data URL), `barcode`, `createdAt`, `updatedAt`, ainsi que `version` et `serverUpdatedAt`, donnés par le serveur.
  - `outbox`, clé `itemId`. Champs : `op` (`put` ou `delete`), `baseVersion`, `queuedAt`, `blocked`. **La clé est le produit** : cinq modifications hors ligne donnent un seul envoi, celui du dernier état.
  - `conflicts`, clé `itemId` : la version du serveur reçue avec un 412.
  - `meta` : `foyerId`, `deviceId`, `lastPullAt`, `lastSyncAt`.
  - Aucun index : quelques centaines de produits au plus, triés et filtrés en mémoire. Le produit et son entrée d'outbox sont écrits **dans la même transaction**.
  - App installée : `navigator.storage.persist()`. Sans cela, le navigateur peut effacer IndexedDB, outbox comprise, quand l'espace manque.
- **Serveur** : clés Blobs `items/<foyer>/<id>`, avec une pierre tombale versionnée pour chaque suppression (les autres appareils l'apprennent), `push/<foyer>/<appareil>` et `foyers/<foyer>` (date de dernière activité, ou date d'effacement).
- **Effacement** (`DELETE /api/foyer`) : la fiche passe à « effacé », puis produits et abonnements sont supprimés. Toute requête suivante sur ce foyer reçoit **410 Gone**, et chaque appareil qui la reçoit vide sa base et repart avec un nouveau foyer (`syncAll`, `resetFoyer`).
- **Outbox** (`src/shared/sync.js`, script partagé par la page et le SW) :
  - **Envoi** : `PUT /api/items/:id`, avec `If-None-Match: *` pour une création et `If-Match: "<version>"` pour une modification ; `DELETE`, avec `If-Match`. Chaque précondition est doublée d'un en-tête `X-Base-Version` : le CDN de Netlify se sert de `If-None-Match` pour son propre cache et ne le transmet pas toujours à la fonction ; sans ce double, une création était refusée (428). Les envois refusés sont retentés une fois à chaque lancement. Ensuite, `GET /api/items?since=…` récupère les changements des autres appareils, avec 60 s de recouvrement.
  - **Quand** :
    - après chaque modification : tag Background Sync `reserve-sync` (Chrome, Edge ; l'envoi part même si l'app est fermée), plus un envoi direct si la page est ouverte et en ligne ;
    - à l'événement `online` (le repli pour Firefox et Safari) ;
    - au lancement, au retour au premier plan, et toutes les 60 s.
  - **Web Locks** : les onglets et le SW ne synchronisent jamais en même temps.
  - **En cas d'échec** : coupure réseau ou 5xx, l'entrée reste et le SW rejette la promesse pour que le navigateur réessaie. Erreur 4xx, l'entrée est marquée « refusé par le serveur » au lieu de boucler.
- **Conflits : gérés.** Le serveur compare `If-Match` à la version stockée et écrit de façon atomique (`onlyIfMatch` sur l'ETag Blobs) : même deux requêtes simultanées ne s'écrasent pas. Dans l'app, un bandeau « À vérifier » liste les différences champ par champ (« Quantité : 7 ici, 5 sur l'autre appareil ») et propose « Garder ma version » (renvoi sur la version du serveur) ou « Prendre la leur ». Les cas « supprimé ici, modifié ailleurs » et l'inverse sont traités.

## 7. Permissions et capacités de l'appareil

| Capacité / API | Déclenchée quand | Pourquoi à ce moment | Si refus |
|---|---|---|---|
| Caméra (`getUserMedia`), photo du produit | Clic sur « Prendre une photo » | C'est le moment où l'on tient le produit ; la demande s'explique d'elle-même. | Message qui dit quoi faire, et bouton « Choisir une image » (`<input type=file>`, sans permission). |
| `BarcodeDetector` + Open Food Facts | Clic sur « Scanner » ; le nom est cherché par le proxy `/api/barcode/:code` | Même raison | API absente (Firefox, Safari, Chrome sous Windows) : bouton masqué, saisie des chiffres expliquée. Hors ligne : le code est gardé. |
| Notifications + Push | Clic sur « Activer les rappels », sous le texte qui explique leur intérêt | La valeur est expliquée avant la demande. | Message avec la marche à suivre ; l'app fonctionne sans. Sur iOS non installée : « installez d'abord l'app ». Un changement dans les réglages du site est suivi en direct (`permissions.query`, événement `change`). |
| Badge (`setAppBadge`) | À chaque rendu, et à la réception d'un push | Aucune permission à demander sur ordinateur | API absente : rien, les compteurs restent visibles dans la page. |
| Web Share / presse-papiers | Clic sur « Partager la liste » et sur « Inviter » | Geste de l'utilisateur obligatoire | Repli sur le presse-papiers, puis sur le texte affiché. |

## 8. Notifications

- **Push, avec `web-push` et VAPID** (sans Firebase). Le rappel doit arriver **application fermée**, et seul le serveur, qui a l'inventaire synchronisé, peut décider le matin qui prévenir. Une notification locale ne le permettrait pas.
- **Quand** : la fonction planifiée tourne chaque jour à 7 h UTC. Pour chaque appareil abonné dont le foyer a des produits périmés ou qui périment dans les 2 jours, elle envoie **au plus une notification par jour** (`lastReminderOn`). La règle « dans les 2 jours » vient de `src/js/expiry.js`, le même fichier pour l'écran et pour le serveur.
- **Contenu** : « 3 produits à consommer vite », suivi de trois noms et de leur échéance ; le badge reçoit le nombre de produits.
- **Clic** : la notification remet au premier plan la fenêtre ouverte, ou ouvre `/?filtre=urgent` (liste déjà filtrée).
- **Robustesse** : un abonnement expiré (404 ou 410) est supprimé ; `pushsubscriptionchange` réabonne l'appareil. Le bouton « Envoyer un rappel maintenant » sert à tester.
- **Vérifié le 11/10** : Edge → service push WNS → notification « 1 produit à consommer vite — Lait UHT entamé (périme demain). »

## 9. Visibilité : SEO et agents IA

- **Dans le HTML initial** : sur l'accueil, le titre, la description, le mode d'emploi et un tableau de 8 repères de conservation ; sur `/guide/`, 30 aliments, une FAQ et les sources officielles datées. Tout est généré au build, donc lisible par `curl` sans JavaScript.
- **Hors du HTML initial** : l'inventaire, privé, qui vit dans IndexedDB.
- **Balises** : `<title>`, description, `canonical`, Open Graph (image 1200 × 630 en URL absolue), carte Twitter. JSON-LD : `WebApplication` sur l'accueil, `FAQPage` avec la citation des sources sur le guide. Google ne montre plus le résultat enrichi FAQ hors des sites officiels (août 2023) : ici, `FAQPage` sert surtout une lecture sans ambiguïté par les agents.
- **Rédaction GEO** : titres en question, réponse dans les deux premières phrases, chiffres, sources datées.
- **`robots.txt`** : tout est ouvert sauf `/api/`, avec une décision par robot.

  | Robot(s) | Décision | Raison |
  |---|---|---|
  | `GPTBot`, `ClaudeBot` | Autorisés | Un modèle qui connaît le guide peut recommander l'app. |
  | `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot` | Autorisés | Ils répondent avec un lien vers la source, donc ils apportent des visites. |
  | `Google-Extended` | Autorisé | Gemini peut citer le guide ; le bloquer ne protégerait rien. |
  | `CCBot` | Refusé | Archive redistribuée sans lien : un coût sans visite. |

  `Content-Signal` n'est pas utilisé : avec une politique tout ouverte, il n'ajouterait rien, et Lighthouse 12 le compte comme « directive inconnue » (SEO 92 au lieu de 100).
- **Autres fichiers** :
  - `sitemap.xml` : 3 URL (accueil, guide, « Vos données »). Le `lastmod` vient de la date `updated` de `content/*.json`, pas de la date du build, donc il est exact.
  - `llms.txt`.
  - Jumelles `index.md` et `guide.md`, servies en `text/markdown` avec `X-Robots-Tag: noindex` et annoncées par `rel=alternate`. Elles sont générées par le même build que le HTML, ce qui écarte le *cloaking*. Pas de négociation par `Accept` : un hébergement statique ne la fait pas (même conclusion que le TD 9).
- **WebMCP** : le formulaire d'ajout est annoté (`toolname="ajouter_produit"`, `toolparamdescription`) ; un agent ne peut qu'ajouter un produit, et il reçoit la phrase de résultat (`SubmitEvent.agentInvoked`, `respondWith`).

## 10. Sécurité et vie privée

- **Sur l'appareil** : l'inventaire, les vignettes photo et les identifiants de foyer et d'appareil (IndexedDB).
- **Sur le serveur** : les produits du foyer et les abonnements push. Pas de compte, pas d'e-mail, ni analytics ni traceur, donc pas de bandeau cookies.
- **RGPD** (jour 1, ch. 2) :
  - la page `/confidentialite/` décrit chaque donnée, sa finalité, sa durée et les sous-traitants (Netlify, services push, Open Food Facts) ;
  - **accès et portabilité** : bouton « Télécharger mes données » (JSON) ;
  - **effacement** : bouton « Supprimer les données du foyer » (§ 6), propagé aux autres appareils ;
  - **durées appliquées** par la tâche quotidienne et par la lecture des produits : foyer effacé après 12 mois sans synchronisation, pierres tombales après 90 jours ;
  - les journaux ne contiennent jamais l'identifiant complet d'un foyer, puisqu'il sert de clé d'accès.
- **Accès** : l'identifiant du foyer, un UUID v4 aléatoire (122 bits), sert de jeton `Bearer`. Le lien d'invitation est donc un secret : l'interface le dit, demande confirmation avant de rejoindre un foyer, et retire le lien de l'URL.
- **Contrôles serveur** (`server/items.mjs`, `server/http.mjs`) : chaque champ est validé (type, longueur, date réelle, data URL JPEG ou WebP de 150 000 caractères au plus). Le format UUID est vérifié avant de servir de préfixe de clé.
- **Secrets** : la clé privée VAPID n'existe que dans les variables d'environnement Netlify. Le navigateur ne reçoit que la clé publique.
- **Open Food Facts** : il est appelé par le serveur (proxy), donc l'adresse IP de l'utilisateur ne part pas chez un tiers.
- **XSS** : rendu uniquement par `textContent`, jamais d'`innerHTML` avec des données. Aucun script ni style inline : le JSON-LD n'est pas exécuté, la CSP ne le bloque pas.
- **En-têtes** (`src/_headers`) : CSP stricte, HSTS, `nosniff`, `X-Frame-Options: DENY` et `frame-ancestors 'none'`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy` (caméra pour l'origin seulement, le reste fermé).

## 11. Mesures

Mesures **locales** (`npm run dev`, 12/10/2026), à refaire sur l'URL de production avant de passer ce document en *final*.

| Lighthouse 13.5 (Edge) | Perf. | Access. | Bonnes pratiques | SEO | Agentic browsing | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| Accueil, mobile | 99 | 100 | 100 | 100 | 3/3 | 2,0 s | 0,001 | 0 ms |
| Guide, mobile | 100 | 100 | 100 | 100 | 3/3 | 1,4 s | 0,003 | 0 ms |
| Vos données, mobile | 100 | 100 | 100 | 100 | 3/3 | 1,2 s | 0,003 | 0 ms |
| Accueil, ordinateur | 100 | 100 | 100 | 100 | 3/3 | 0,4 s | 0 | 0 ms |

Agentic browsing : `llms.txt`, arbre d'accessibilité et CLS réussis. Les audits WebMCP sont « non applicables » : l'API n'est pas activée dans ce navigateur (origin trial).

- **CLS corrigé** : l'en-tête a une hauteur fixe. Avant, l'apparition du bouton « Installer » décalait toute la page (CLS 0,094).
- **`curl`** (commandes dans le `README`) :
  - `curl -A GPTBot /` : 8 repères de conservation dans le HTML. `/guide/` : 30 aliments.
  - `guide.md` : `text/markdown`, `X-Robots-Tag: noindex`.
  - `Accept: text/markdown` sur `/` : `text/html` (pas de négociation de contenu).
  - `robots.txt`, `sitemap.xml`, `llms.txt` : 200.
- **Tests de bout en bout** (`npm test`, Chromium) : **17/17**. Installabilité, ajout et synchronisation, photo, hors ligne (app, données, page de secours), outbox vidée au retour du réseau, second appareil, conflit 412, export puis effacement propagé à l'autre appareil et purge à 12 mois, mise à jour par bannière, refus de la caméra et des notifications, console sans erreur (CSP comprise).

## 12. Limites connues et suite

- **iOS / Safari** : pas de Background Sync (repli `online` et envoi au lancement), push seulement si l'app est installée (iOS 16.4+), pas de `BarcodeDetector`, pas de `beforeinstallprompt` (une astuce d'installation s'affiche).
- **Firefox** : pas de Background Sync ni de `BarcodeDetector` ; le push fonctionne.
- **Chrome sous Windows** : pas de `BarcodeDetector`.
- **Sécurité** : le lien de foyer ne se révoque pas, et l'API n'a pas de limitation de débit.
- **Performance** : le serveur relit tous les produits du foyer à chaque synchronisation, ce qui reste rapide sous quelques centaines. Chaque requête lit aussi la fiche du foyer (une lecture Blobs de plus).
- **Conservation** : un appareil resté hors ligne plus de 90 jours peut faire réapparaître un produit supprimé ailleurs, puisque la pierre tombale a disparu.
- **WebMCP** : non vérifié dans un navigateur, faute d'accès à l'origin trial (Chrome 149+) ; sans l'API, les attributs sont ignorés.
- **v2** :
  - rotation du code de foyer, et rôles par membre ;
  - limitation de débit ;
  - Periodic Background Sync pour tenir le badge à jour app fermée ;
  - lecture d'un ticket de caisse ;
  - suggestions de recettes avec ce qui périme.
