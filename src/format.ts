import type { AppleResource } from "./types";

export function jsonText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function compactResource(resource: AppleResource): Record<string, unknown> {
  const attributes = resource.attributes ?? {};
  const artwork = attributes.artwork as { url?: string; width?: number; height?: number } | undefined;
  return {
    id: resource.id,
    type: resource.type,
    name: attributes.name,
    artistName: attributes.artistName,
    albumName: attributes.albumName,
    url: attributes.url,
    isrc: attributes.isrc,
    genreNames: attributes.genreNames,
    durationInMillis: attributes.durationInMillis,
    canEdit: attributes.canEdit,
    description: normalizeDescription(attributes.description),
    artworkUrl: artwork?.url ? formatArtworkUrl(artwork.url, 300, 300) : undefined
  };
}

export function compactResources(resources: AppleResource[]): Array<Record<string, unknown>> {
  return resources.map(compactResource);
}

function normalizeDescription(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "standard" in value) {
    return String((value as { standard?: string }).standard ?? "");
  }
  return undefined;
}

function formatArtworkUrl(url: string, width: number, height: number): string {
  return url.replace("{w}", String(width)).replace("{h}", String(height)).replace("{f}", "jpg");
}
