import { openStore } from "../../server/store.mjs";
import { sendDailyReminders } from "../../server/push.mjs";
import { purgeExpired } from "../../server/foyer.mjs";

// Fonction planifiée Netlify : chaque jour à 7 h UTC (9 h à Paris l'été, 8 h l'hiver).
// Elle tourne même si aucun appareil n'a l'application ouverte : c'est tout l'intérêt du push.
// Elle applique aussi la durée de conservation : un foyer inactif depuis 12 mois est effacé.
export default async () => {
  const store = openStore();
  console.log("Rappels de péremption", await sendDailyReminders(store));
  console.log("Durée de conservation", await purgeExpired(store));
};

export const config = { schedule: "0 7 * * *" };
