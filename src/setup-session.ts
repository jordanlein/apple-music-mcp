export const SETUP_SESSION_TTL_MS = 10 * 60 * 1_000;

export type SetupSession = { version: 1; sessionId: string; expiresAt: number };

export async function createSetupSession(secret: string, now = Date.now()): Promise<string> {
  const payload: SetupSession = {
    version: 1,
    sessionId: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
    expiresAt: now + SETUP_SESSION_TTL_MS
  };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${base64UrlEncode(new Uint8Array(await hmac(encoded, secret)))}`;
}

export async function verifySetupSession(
  token: string,
  secret: string,
  now = Date.now()
): Promise<SetupSession | undefined> {
  try {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) return undefined;
    const expected = new Uint8Array(await hmac(encoded, secret));
    const decodedSignature = base64UrlDecode(signature);
    if (base64UrlEncode(decodedSignature) !== signature || !secureEqualBytes(decodedSignature, expected)) return undefined;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as Partial<SetupSession>;
    if (
      payload.version !== 1
      || typeof payload.sessionId !== "string"
      || payload.sessionId.length < 20
      || typeof payload.expiresAt !== "number"
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt < now
      || payload.expiresAt > now + SETUP_SESSION_TTL_MS
    ) return undefined;
    return payload as SetupSession;
  } catch {
    return undefined;
  }
}

async function hmac(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

function secureEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
