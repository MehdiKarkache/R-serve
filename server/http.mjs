export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID.test(value);

/**
 * Le foyer est identifié par un UUID aléatoire (122 bits) envoyé en jeton Bearer :
 * le connaître donne accès à l'inventaire du foyer, comme un lien de partage.
 * Le format est vérifié avant de servir de préfixe de clé (pas d'injection de chemin).
 */
export function identify(request) {
  const foyerId = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const deviceId = request.headers.get("x-device-id");
  if (!isUuid(foyerId) || !isUuid(deviceId)) return null;
  return { foyerId: foyerId.toLowerCase(), deviceId: deviceId.toLowerCase() };
}
