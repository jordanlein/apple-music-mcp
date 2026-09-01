import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  APPLE_STOREFRONT?: string;
  APPLE_DEVELOPER_TOKEN_TTL_SECONDS?: string;
  TOKEN_ENCRYPTION_KEY: string;
  POKE_MCP_API_KEY: string;
  SETUP_TOKEN: string;
}

export interface AppleTokenSet {
  musicUserToken: string;
  capturedAt: string;
}

export interface ToolContext {
  env: Env;
  pokeUserId?: string;
}

export interface AppleArtwork {
  url?: string;
  width?: number | null;
  height?: number | null;
}

export interface AppleResource {
  id: string;
  type: string;
  href?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: AppleResource[]; next?: string }>;
  views?: Record<string, { data?: AppleResource[]; href?: string; next?: string }>;
  meta?: Record<string, unknown>;
}

export interface AppleListResponse {
  data?: AppleResource[];
  next?: string;
  meta?: Record<string, unknown>;
  results?: Record<string, { data?: AppleResource[] }>;
}
