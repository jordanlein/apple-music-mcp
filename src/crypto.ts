const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array | string): string {
  const input = typeof bytes === "string" ? textEncoder.encode(bytes) : bytes;
  const data = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function randomToken(): Promise<string> {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function encryptJson(value: unknown, secret: string): Promise<string> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext)
  });
}

export async function decryptJson<T>(encrypted: string, secret: string): Promise<T> {
  const payload = JSON.parse(encrypted) as { iv: string; ciphertext: string };
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecode(payload.iv)) },
    key,
    toArrayBuffer(base64UrlDecode(payload.ciphertext))
  );
  return JSON.parse(textDecoder.decode(plaintext)) as T;
}

export async function signEs256Jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  let material: Uint8Array;
  try {
    material = base64UrlDecode(secret);
  } catch {
    material = new Uint8Array();
  }
  if (material.byteLength !== 32) {
    material = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(secret)));
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(material), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  return toArrayBuffer(Uint8Array.from(atob(body), (char) => char.charCodeAt(0)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
