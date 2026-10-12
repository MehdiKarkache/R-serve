// Foyer : un identifiant partagé par tous les appareils de la maison, transmis par un lien d'invitation.
// Et les droits sur ces données (RGPD) : les télécharger, les effacer.
import { showToast } from "./pwa.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ERASE_CONFIRM_MS = 6000;

const code = document.querySelector("#foyer-code");
const inviteButton = document.querySelector("#invite-button");
const joinForm = document.querySelector("#join-form");
const joinInput = document.querySelector("#join-input");
const result = document.querySelector("#foyer-result");
const banner = document.querySelector("#join-banner");
const exportButton = document.querySelector("#export-button");
const eraseButton = document.querySelector("#erase-button");

function say(message, state = "neutral") {
  result.textContent = message;
  result.dataset.state = state;
}

async function copy(text) {
  if (!navigator.clipboard?.writeText) throw new Error("presse-papiers indisponible");
  await navigator.clipboard.writeText(text);
}

/** Droit d'accès et à la portabilité : tout ce que cet appareil connaît, dans un fichier JSON. */
async function exportData(db) {
  const { foyerId } = await db.getIdentity();
  const data = {
    application: "Réserve",
    exportedAt: new Date().toISOString(),
    foyer: foyerId,
    items: await db.listItems(),
    pendingChanges: (await db.listOutbox()).length,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `reserve-donnees-${data.exportedAt.slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function initFoyer({ db, sync, onJoined, onErased, invitedFoyer }) {
  const currentFoyer = async () => (await db.getIdentity()).foyerId;
  const renderCode = async () => {
    code.textContent = `${(await currentFoyer()).slice(0, 8)}…`;
  };
  await renderCode();

  const join = async (newFoyerId) => {
    if (newFoyerId === (await currentFoyer())) {
      say("Cet appareil fait déjà partie de ce foyer.");
      return;
    }
    await db.joinFoyer(newFoyerId);
    await renderCode();
    say("Foyer rejoint : vos produits y sont ajoutés, l'inventaire partagé arrive.", "success");
    await onJoined();
  };

  inviteButton.addEventListener("click", async () => {
    const url = `${location.origin}/?foyer=${await currentFoyer()}`;
    const data = { title: "Réserve", text: "Rejoins l'inventaire de notre garde-manger sur Réserve :", url };
    if (navigator.share) {
      try {
        await navigator.share(data);
        say("Invitation partagée.", "success");
      } catch (error) {
        if (error.name !== "AbortError") say(`Partage impossible : ${error.message}`, "error");
      }
      return;
    }
    try {
      await copy(url);
      say("Lien d'invitation copié : envoyez-le aux membres du foyer.", "success");
    } catch {
      say(`Copiez ce lien et envoyez-le : ${url}`);
    }
  });

  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const match = joinInput.value.match(UUID);
    if (!match) {
      say("Lien non reconnu : collez le lien d'invitation complet.", "error");
      return;
    }
    joinForm.reset();
    await join(match[0].toLowerCase());
  });

  // Ouverture d'un lien d'invitation : on demande confirmation avant de changer de foyer.
  const invited = invitedFoyer?.match(UUID)?.[0].toLowerCase();
  if (invited && invited !== (await currentFoyer())) {
    banner.hidden = false;
    document.querySelector("#join-confirm").addEventListener("click", async () => {
      banner.hidden = true;
      await join(invited);
      showToast("Foyer rejoint.");
    }, { once: true });
    document.querySelector("#join-cancel").addEventListener("click", () => {
      banner.hidden = true;
    }, { once: true });
  }

  exportButton.addEventListener("click", async () => {
    await exportData(db);
    say("Vos données sont téléchargées (fichier JSON).", "success");
  });

  // Effacement en deux temps : le premier clic arme le bouton, le second (dans les 6 s) efface.
  let armedUntil = 0;
  const label = eraseButton.textContent;
  eraseButton.addEventListener("click", async () => {
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + ERASE_CONFIRM_MS;
      eraseButton.textContent = "Confirmer : tout effacer";
      say("Tout l'inventaire du foyer sera effacé du serveur, de cet appareil et des autres appareils du foyer. Cliquez de nouveau pour confirmer.", "error");
      setTimeout(() => {
        if (Date.now() >= armedUntil) eraseButton.textContent = label;
      }, ERASE_CONFIRM_MS);
      return;
    }
    armedUntil = 0;
    eraseButton.textContent = label;
    eraseButton.disabled = true;
    say("Effacement…");
    try {
      await sync.eraseFoyer();
      await renderCode();
      say("Données du foyer effacées. Cet appareil repart avec un inventaire vide.", "success");
      await onErased();
    } catch (error) {
      say(`Effacement impossible : ${error.message}. Rien n'a été effacé sur cet appareil.`, "error");
    } finally {
      eraseButton.disabled = !navigator.onLine;
    }
  });

  return { renderCode };
}

export { copy as copyToClipboard };
