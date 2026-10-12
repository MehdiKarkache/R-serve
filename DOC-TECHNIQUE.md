# Réserve — document technique

Auteur : *‹ Karkache EL Mehdi ›* · 12 octobre 2026 · Site : [Reserve](https://reservve.netlify.app) · Dépôt : [github.com/MehdiKarkache/R-serve](https://github.com/MehdiKarkache/R-serve) · Statut : brouillon, à passer en final après les mesures en production (§ 11)

## 1. En bref

Réserve, c'est l'inventaire du garde-manger d'un foyer : ce qu'il y a dans le frigo, le congélateur et le placard, avec les dates de péremption. Elle s'ouvre sans réseau, se partage entre les téléphones de la maison et prévient le matin quand quelque chose va périmer.

Le choix qui structure tout le reste : **le téléphone est la référence, pas le serveur**. Chaque modification est d'abord écrite dans IndexedDB, puis envoyée quand c'est possible. L'application n'attend donc jamais le réseau, et un numéro de version empêche deux téléphones de s'écraser mutuellement.

## 2. Contexte et objectifs

Sujet du Hub : *inventaire*. Ce que l'application doit faire :

- noter des produits (nom, quantité, emplacement, date, photo, code-barres), triés par urgence ;
- tenir une liste de courses avec ce qui est fini ;
- fonctionner entièrement hors ligne ;
- partager l'inventaire avec le foyer ;
- envoyer un rappel chaque matin ;
- publier un guide de conservation public, qui sert aussi à proposer une date dans le formulaire.

Ce que je n'ai volontairement pas fait : des comptes avec mot de passe (le foyer se partage par un lien), des recettes, des statistiques et du temps réel (un frigo n'a pas besoin d'une mise à jour à la seconde : une synchronisation par minute suffit).

## 3. Architecture

Tout est écrit en HTML, CSS et JavaScript, sans framework. La seule bibliothèque côté navigateur est `idb`, qui simplifie IndexedDB. J'ai écrit le Service Worker à la main (environ 130 lignes) plutôt que d'utiliser Workbox : je voulais pouvoir expliquer chaque stratégie ligne par ligne.

Un script de build (`scripts/build.mjs`) génère les pages publiques à partir de fichiers JSON, écrit `robots.txt`, `sitemap.xml` et `llms.txt`, puis grave dans le Service Worker une empreinte des fichiers.

Côté serveur : des **Netlify Functions** sur le même domaine que le site, et **Netlify Blobs** pour le stockage. Le cours propose Firebase ; j'ai préféré une petite API REST à moi, pour trois raisons :

1. la CSP reste limitée au domaine du site (`'self'`) ;
2. Blobs sait écrire « seulement si personne n'a modifié entre-temps », ce qu'il faut pour gérer les conflits ;
3. le standard VAPID suffit pour le push, sans Firebase.

Pour la partie Android, l'application native appellera la même API ; il faudra seulement ajouter un envoi FCM pour les notifications natives.

```text
Page ──► IndexedDB (produits, outbox) ◄── Service Worker (même code de synchronisation)
  │                                            │  Cache Storage : l'application elle-même
  └──────────── /api/* ─────────────► Netlify Function ──► Netlify Blobs
                                       Tâche de 7 h ──► web-push ──► notification
```

Chaque `git push` redéploie le site ; les clés VAPID sont des variables d'environnement Netlify.

## 4. Cache et hors ligne

| Quoi | Stratégie | Pourquoi |
|---|---|---|
| Pages HTML, CSS, JS, icônes | Cache First, préchargés à l'installation | Ils forment une seule version et arrivent toujours ensemble |
| Inventaire | IndexedDB d'abord, synchronisé ensuite | L'écran s'affiche depuis le téléphone, avec ou sans réseau |
| `/api/*` | Réseau seulement | Données privées : jamais servies périmées depuis un cache |

Le tableau du cours conseille SWR pour le HTML. Je ne l'ai pas suivi : avec SWR, on peut recevoir un HTML neuf avec un JavaScript ancien. Chez moi, le HTML change avec le reste, au moment où l'utilisateur accepte la mise à jour (§ 5).

En mode avion, l'application s'ouvre avec tout l'inventaire. On peut ajouter, modifier et supprimer, et le guide reste lisible. Une bannière signale le hors ligne, et la pastille indique combien de modifications attendent. Les boutons qui ont besoin du réseau sont grisés avec la mention « hors ligne » : synchroniser, chercher un code-barres, activer les rappels, supprimer les données. Une adresse inconnue affiche `offline.html`.

## 5. Mise à jour

Je propose la mise à jour, je ne l'impose pas : une bannière dit « Une nouvelle version de Réserve est prête », et c'est l'utilisateur qui clique. On se sert de l'appli debout devant le frigo, souvent avec le formulaire ouvert ou la caméra allumée : un rechargement surprise ferait perdre la saisie.

Concrètement :

- le build calcule une empreinte SHA-256 des fichiers et l'écrit dans `sw.js`. Dès qu'un fichier change, `sw.js` change, et le navigateur voit la nouvelle version. Je n'ai jamais à penser à incrémenter `CACHE_NAME`, donc je ne peux pas l'oublier ;
- `sw.js` est servi sans cache HTTP. Le nouveau Service Worker attend, sans `skipWaiting` automatique ;
- le clic sur la bannière l'active : les anciens caches sont supprimés, puis la page se recharge ;

## 6. Données et synchronisation

IndexedDB contient quatre tables :

- `items` : les produits ;
- `outbox` : ce qui reste à envoyer, une ligne par produit ; cinq modifications hors ligne donnent donc un seul envoi ;
- `conflicts` : les désaccords à trancher ;
- `meta` : les identifiants du foyer et de l'appareil.

Le produit et sa ligne d'outbox sont écrits dans la même transaction : si l'un est enregistré, l'autre aussi. Quand l'app est installée, je demande au navigateur un stockage persistant, pour qu'il n'efface pas la base quand l'espace manque.

L'envoi suit un protocole simple. Une création dit « ce produit ne doit pas encore exister » (`If-None-Match: *`) ; une modification dit « je pars de la version 3 » (`If-Match: "3"`). Ensuite, l'appli récupère ce que les autres appareils ont changé depuis la dernière fois. La synchronisation part :

- après chaque modification, par Background Sync (sur Chrome, même si l'app est fermée) et directement si la page est ouverte ;
- au retour du réseau (événement `online`, le repli pour Firefox et Safari) ;
- au lancement, au retour au premier plan, puis toutes les minutes.

Un verrou (Web Locks) évite deux synchronisations simultanées ; en cas de coupure, la modification reste dans l'outbox et repart plus tard.

**Un bug trouvé en route.** Sur Netlify, des ajouts étaient parfois refusés avec l'erreur 428 (« précondition requise »). La cause : le CDN de Netlify utilise lui-même `If-None-Match` pour son cache et ne le transmet pas toujours à la fonction. J'ai doublé chaque précondition dans un en-tête à moi, `X-Base-Version`, que le CDN laisse passer, et j'ai reproduit le problème en local pour vérifier la correction.

**Conflits.** Si deux téléphones modifient le même produit hors ligne, le serveur refuse le second envoi (412) et renvoie sa version ; l'écriture côté serveur est atomique, donc rien n'est jamais écrasé. L'appli affiche alors un bandeau « À vérifier » avec les différences, par exemple « Quantité : 7 ici, 5 sur l'autre appareil », et l'utilisateur garde sa version ou prend l'autre.

## 7. Permissions et capacités de l'appareil

| Capacité | Demandée quand | Si c'est refusé ou absent |
|---|---|---|
| Caméra (photo du produit) | Au clic sur « Prendre une photo » | Un message dit quoi faire, et « Choisir une image » marche sans permission |
| Lecture du code-barres | Au clic sur « Scanner » | Absente sur Firefox, Safari et Chrome Windows : bouton masqué, on tape les chiffres |
| Notifications | Au clic sur « Activer les rappels », sous l'explication | Message avec la marche à suivre ; l'appli fonctionne sans |
| Badge sur l'icône | Sans demande | Les compteurs restent visibles dans la page |
| Partage de la liste | Au clic | Copie dans le presse-papiers |

Rien n'est demandé au chargement : chaque permission arrive quand l'utilisateur comprend pourquoi.

## 8. Notifications

J'ai choisi le vrai push (Web Push, VAPID) plutôt qu'une notification locale. Le rappel doit arriver application fermée, et seul le serveur, qui a l'inventaire à jour, peut décider le matin qui prévenir. Une tâche planifiée tourne chaque jour à 7 h UTC et envoie au plus un rappel par jour et par appareil, par exemple « 3 produits à consommer vite ». La règle « périme dans les deux jours » est dans un seul fichier, partagé par l'écran et le serveur, pour qu'ils ne puissent jamais se contredire.

Un clic sur la notification ouvre la liste filtrée sur les produits urgents. Un bouton « Envoyer un rappel maintenant » sert à tester : la notification est bien arrivée sur Edge le 11 octobre.

## 9. Visibilité : SEO et agents IA

Un robot ne voit que le HTML renvoyé par le serveur. J'ai donc mis dans le HTML, généré au build, tout ce qui est public :

- sur l'accueil : la description et huit repères de conservation ;
- sur `/guide/` : 30 aliments, une FAQ et les sources officielles datées ;
- sur `/confidentialite/` : la page « Vos données ».

L'inventaire, lui, est privé et reste dans IndexedDB.

Chaque page a son titre, sa description, une URL canonique, Open Graph et du JSON-LD (`WebApplication`, `FAQPage`). Les versions Markdown (`index.md`, `guide.md`) sont générées à partir des mêmes données que le HTML, donc elles disent la même chose ; elles sont exclues de Google par `noindex`. Je n'ai pas fait de négociation par `Accept` : un hébergement statique ne la permet pas, comme on l'a vu au TD 9.

Dans `robots.txt`, j'ai pris une décision par robot :

- **Ouverts** : GPTBot, ClaudeBot et Google-Extended, parce qu'une IA qui connaît le guide peut recommander l'appli ; OAI-SearchBot, Claude-SearchBot et PerplexityBot, qui citent leurs sources et amènent des visites.
- **Fermé** : CCBot, qui archive sans renvoyer personne.


## 10. Sécurité et vie privée

Il n'y a ni compte, ni e-mail, ni cookie, ni outil de statistiques ; donc pas de bandeau cookies. Le foyer est identifié par un code aléatoire de 122 bits qui sert de clé d'accès. Le lien d'invitation est donc un secret : l'interface le dit et demande confirmation avant de rejoindre un foyer.

Côté RGPD, la page `/confidentialite/` décrit chaque donnée, à quoi elle sert et combien de temps elle est gardée. Trois boutons permettent d'exercer ses droits :

- télécharger ses données en JSON ;
- tout effacer : le serveur supprime le foyer et répond ensuite 410 aux autres appareils, qui effacent leur copie ;
- couper les rappels.

Les durées annoncées sont réellement appliquées : un foyer inactif depuis un an est supprimé, un produit supprimé disparaît du serveur après 90 jours.

Pour le reste :

- le serveur valide chaque champ avant de l'enregistrer ;
- la page n'insère jamais de texte en HTML (`textContent` partout) ;
- la clé privée VAPID ne quitte pas Netlify ;
- les journaux ne contiennent jamais le code complet d'un foyer ;
- les en-têtes de sécurité sont tous présents : CSP stricte, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy` et `Permissions-Policy`.

## 11. Mesures

Mesures prises en local le 12 octobre avec Lighthouse 13.5, à refaire sur le site en ligne :

| Page | Perf. | Accessibilité | Bonnes pratiques | SEO | Agentic browsing | LCP | CLS |
|---|---|---|---|---|---|---|---|
| Accueil (mobile) | 99 | 100 | 100 | 100 | 3/3 | 2,0 s | 0,001 |
| Guide (mobile) | 100 | 100 | 100 | 100 | 3/3 | 1,4 s | 0,003 |
| Vos données (mobile) | 100 | 100 | 100 | 100 | 3/3 | 1,2 s | 0,003 |
| Accueil (ordinateur) | 100 | 100 | 100 | 100 | 3/3 | 0,4 s | 0 |

Au premier essai, le CLS valait 0,094 : le bouton « Installer » faisait grandir l'en-tête et décalait toute la page. J'ai fixé la hauteur de l'en-tête. Avec `curl -A GPTBot`, le guide renvoie bien ses 30 aliments, sans JavaScript.

17 tests automatiques (`npm test`) rejouent les critères dans un vrai Chromium :

- installation ;
- hors ligne, et outbox vidée au retour du réseau ;
- deuxième appareil et conflit ;
- effacement des données ;
- mise à jour par la bannière ;
- refus de la caméra et des notifications ;
- console sans erreur.

## 12. Limites et suite

- **iPhone** : pas de Background Sync (l'envoi se fait à l'ouverture ou au retour du réseau), pas de lecture de code-barres, notifications seulement si l'app est installée.
- **Firefox** : pas de Background Sync ni de lecture de code-barres.
- **Sécurité** : le lien de foyer ne se révoque pas, et l'API n'a pas de limite de débit.
- **Effacement** : un appareil resté hors ligne plus de 90 jours peut faire réapparaître un produit supprimé ailleurs.

Pour une v2 : pouvoir changer le code du foyer, limiter le débit de l'API, lire un ticket de caisse et proposer des recettes avec ce qui va périmer.
