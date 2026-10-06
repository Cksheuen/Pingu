const enc = new TextEncoder();
export const bytes64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export const from64 = (value) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
export const randomToken = () =>
  bytes64(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
async function key(secret, usage) {
  return crypto.subtle.importKey("raw", from64(secret), "AES-GCM", false, [
    usage,
  ]);
}
export async function seal(value, secret, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) },
    await key(secret, "encrypt"),
    enc.encode(value),
  );
  return `${bytes64(iv)}.${bytes64(new Uint8Array(cipher))}`;
}
export async function open(value, secret, context) {
  const [iv, cipher] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: from64(iv), additionalData: enc.encode(context) },
      await key(secret, "decrypt"),
      from64(cipher),
    ),
  );
}
async function hmac(secret, value) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytes64(
    new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(value))),
  );
}
export async function session(secret) {
  const payload = `${Math.floor(Date.now() / 1000) + 3600}.${randomToken()}`;
  return `${payload}.${await hmac(secret, payload)}`;
}
export async function validSession(secret, value) {
  if (!value || value.length > 250) return false;
  const [expiry, nonce, signature] = value.split(".");
  if (
    !/^\d+$/.test(expiry) ||
    !/^[\w-]{43}$/.test(nonce || "") ||
    Number(expiry) < Date.now() / 1000 ||
    Number(expiry) > Date.now() / 1000 + 3610
  )
    return false;
  return (
    (await digest(signature || "")) ===
    (await digest(await hmac(secret, `${expiry}.${nonce}`)))
  );
}
