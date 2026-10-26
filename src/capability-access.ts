import { secureEqual } from './http-security';

// The owner explicitly chooses one shared, password-free capability URL.
// Derive it from the existing credential; never advertise it at the root.
let cached: { secret: string; path: Promise<string> } | undefined;
export async function capabilityPath(secret: string): Promise<string> {
  if (!cached || cached.secret !== secret) {
    const path = crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)).then(hash =>
      `/mcp/${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`);
    cached = { secret, path };
  }
  return cached.path;
}

export async function hasCapabilityPath(path: string, secret?: string): Promise<boolean> {
  if (!secret || secret.length < 32 || !/^\/mcp\/[a-f0-9]{64}$/.test(path)) return false;
  return secureEqual(path, await capabilityPath(secret));
}

// Clients with secret vaults often substitute credentials only in headers.
// Accept the same URL capability as a bearer value; no additional key exists.
export async function hasCapabilityToken(token: string, secret?: string): Promise<boolean> {
  if (!secret || secret.length < 32 || !/^[a-f0-9]{64}$/.test(token)) return false;
  return secureEqual(token, (await capabilityPath(secret)).slice('/mcp/'.length));
}
