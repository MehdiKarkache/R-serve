// Caméra : photo du produit et lecture du code-barres.
// getUserMedia n'est appelé qu'après un clic : c'est ce clic qui déclenche la demande de permission.

const dialog = document.querySelector("#camera-dialog");
const title = document.querySelector("#camera-title");
const video = document.querySelector("#camera-video");
const status = document.querySelector("#camera-status");
const captureButton = document.querySelector("#camera-capture");
const scanGuide = document.querySelector("#scan-guide");

const PHOTO_SIZE = 480; // côté le plus long : une vignette nette, assez légère pour être synchronisée
const MAX_PHOTO_LENGTH = 140_000; // limite du serveur : 150 000 caractères
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

let stream = null;

export class CameraError extends Error {}

export const cameraSupported = () => Boolean(navigator.mediaDevices?.getUserMedia);
export const barcodeSupported = () => "BarcodeDetector" in window && cameraSupported();

function explain(error) {
  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Accès à la caméra refusé. Vous pouvez choisir une image depuis vos fichiers, ou autoriser la caméra dans les réglages du site (icône à gauche de l'adresse).";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Aucune caméra détectée sur cet appareil : choisissez une image depuis vos fichiers.";
    case "NotReadableError":
      return "La caméra est utilisée par une autre application. Fermez-la, puis réessayez.";
    case "NotSupportedError":
      return "Ce navigateur ne donne pas accès à la caméra ici : choisissez une image depuis vos fichiers.";
    default:
      return `Caméra indisponible (${error.message}).`;
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

function toDataUrl(source, width, height) {
  const scale = Math.min(1, PHOTO_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  let quality = 0.75;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_PHOTO_LENGTH && quality > 0.3) {
    quality -= 0.15;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return dataUrl;
}

/** Ouvre la fenêtre caméra et résout avec le résultat, ou null si l'utilisateur ferme. */
async function session({ heading, scanning, onReady }) {
  if (!cameraSupported()) throw new CameraError("Pas de caméra accessible dans ce navigateur : choisissez une image depuis vos fichiers.");
  title.textContent = heading;
  captureButton.hidden = scanning;
  scanGuide.hidden = !scanning;
  status.textContent = "Autorisez l'accès à la caméra si le navigateur le demande.";
  status.dataset.state = "neutral";
  dialog.showModal();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (!dialog.open) {
      // Fenêtre fermée pendant la demande de permission.
      stopCamera();
      return null;
    }
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    stopCamera();
    dialog.close();
    throw new CameraError(explain(error));
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stopCamera();
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(null), { once: true });
    onReady(finish);
  });
}

export function capturePhoto() {
  return session({
    heading: "Photo du produit",
    scanning: false,
    onReady(finish) {
      status.textContent = "Cadrez le produit, puis prenez la photo.";
      captureButton.onclick = () => finish(toDataUrl(video, video.videoWidth, video.videoHeight));
    },
  });
}

/** Lecture du code-barres avec BarcodeDetector (Chrome Android, macOS, ChromeOS). */
export async function scanBarcode() {
  const supported = await window.BarcodeDetector.getSupportedFormats();
  const formats = BARCODE_FORMATS.filter((format) => supported.includes(format));
  if (formats.length === 0) throw new CameraError("Ce navigateur ne sait pas lire les codes-barres de produits : saisissez les chiffres à la main.");
  const detector = new window.BarcodeDetector({ formats });

  return session({
    heading: "Scanner un code-barres",
    scanning: true,
    onReady(finish) {
      status.textContent = "Placez le code-barres dans le cadre.";
      const tick = async () => {
        if (!stream) return;
        try {
          const codes = await detector.detect(video);
          const code = codes.map((candidate) => candidate.rawValue).find((value) => /^\d{8,14}$/.test(value));
          if (code) {
            navigator.vibrate?.(60);
            finish(code);
            return;
          }
        } catch {
          // Image pas encore prête : on réessaie au tour suivant.
        }
        setTimeout(tick, 250);
      };
      tick();
    },
  });
}

/** Repli sans permission : une image choisie dans les fichiers (ou prise par l'appareil photo du système). */
export async function imageFileToDataUrl(file) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    const dataUrl = toDataUrl(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return dataUrl;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return toDataUrl(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
window.addEventListener("pagehide", stopCamera);
