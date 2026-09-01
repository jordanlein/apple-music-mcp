import type { AppleResource } from "./types";
import type { ResolvedTimeframe } from "./timeframe";

export const RECENTLY_PLAYED_LIMIT = 30;

export interface HistoryCursor {
  observedAt: string;
  id: number;
  timeframe: ResolvedTimeframe;
}

export interface RecentSnapshotState {
  capturedAt: string;
  fingerprints: string[];
}

export interface SnapshotDiff {
  newCount: number;
  overlapCount: number;
  gapDetected: boolean;
  initialSnapshot: boolean;
}

export function resourceFingerprint(resource: AppleResource): string {
  const attributes = resource.attributes ?? {};
  const playParams = attributes.playParams as { id?: string; catalogId?: string } | undefined;
  return [
    resource.id,
    resource.type,
    playParams?.id ?? "",
    playParams?.catalogId ?? "",
    attributes.name ?? "",
    attributes.artistName ?? "",
    attributes.albumName ?? ""
  ].join("|");
}

export function diffRecentSnapshots(current: string[], previous: string[]): SnapshotDiff {
  if (!previous.length) {
    return {
      newCount: current.length,
      overlapCount: 0,
      gapDetected: false,
      initialSnapshot: true
    };
  }

  let bestStart = -1;
  let bestOverlap = 0;
  for (let start = 0; start < current.length; start += 1) {
    let overlap = 0;
    while (
      start + overlap < current.length
      && overlap < previous.length
      && current[start + overlap] === previous[overlap]
    ) {
      overlap += 1;
    }
    if (overlap > bestOverlap || (overlap === bestOverlap && overlap > 0 && (bestStart < 0 || start < bestStart))) {
      bestStart = start;
      bestOverlap = overlap;
    }
  }

  if (bestStart < 0) {
    return {
      newCount: current.length,
      overlapCount: 0,
      gapDetected: current.length === RECENTLY_PLAYED_LIMIT,
      initialSnapshot: false
    };
  }

  return {
    newCount: bestStart,
    overlapCount: bestOverlap,
    gapDetected: false,
    initialSnapshot: false
  };
}

export function parseRecentSnapshot(value: string | undefined): RecentSnapshotState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<RecentSnapshotState>;
    if (
      typeof parsed.capturedAt !== "string"
      || !Array.isArray(parsed.fingerprints)
      || !parsed.fingerprints.every((item) => typeof item === "string")
    ) {
      return undefined;
    }
    return {
      capturedAt: parsed.capturedAt,
      fingerprints: parsed.fingerprints
    };
  } catch {
    return undefined;
  }
}

export function estimateObservedTimes(
  count: number,
  capturedAt: string,
  previousCapturedAt?: string
): string[] {
  if (count <= 0) return [];
  const endMs = Date.parse(capturedAt);
  const parsedStartMs = previousCapturedAt ? Date.parse(previousCapturedAt) : Number.NaN;
  const startMs = Number.isFinite(parsedStartMs) && parsedStartMs < endMs
    ? parsedStartMs
    : endMs - Math.max(count, 1);
  const interval = Math.max(1, endMs - startMs);

  return Array.from({ length: count }, (_, index) => {
    const newestFirstFraction = (count - index) / (count + 1);
    return new Date(startMs + interval * newestFirstFraction).toISOString();
  });
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeHistoryCursor(value: string | undefined): HistoryCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(base64UrlDecode(value)) as Partial<HistoryCursor>;
    if (
      typeof parsed.observedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.observedAt))
      || !Number.isInteger(parsed.id)
      || (parsed.id ?? 0) < 1
      || !isCursorTimeframe(parsed.timeframe)
    ) {
      throw new Error("invalid cursor fields");
    }
    return {
      observedAt: parsed.observedAt,
      id: parsed.id as number,
      timeframe: parsed.timeframe as ResolvedTimeframe
    };
  } catch {
    throw new Error("The history cursor is invalid or expired. Start a new history query without a cursor.");
  }
}

function isCursorTimeframe(value: unknown): value is ResolvedTimeframe {
  if (!value || typeof value !== "object") return false;
  const timeframe = value as Partial<ResolvedTimeframe>;
  return (
    (timeframe.mode === "preset" || timeframe.mode === "custom")
    && typeof timeframe.endIso === "string"
    && Number.isFinite(Date.parse(timeframe.endIso))
    && (timeframe.startIso === undefined || (
      typeof timeframe.startIso === "string" && Number.isFinite(Date.parse(timeframe.startIso))
    ))
    && typeof timeframe.label === "string"
    && typeof timeframe.timeZone === "string"
  );
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
