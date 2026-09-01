import type { ResolvedSong, SongLookupInput, SongResolutionIssue } from "./apple";
import type { AppleResource } from "./types";

type CandidateScore = {
  resource: AppleResource;
  score: number;
  exactTitle: boolean;
  exactArtist: boolean;
};

export function chooseSongMatch(
  input: SongLookupInput,
  query: string,
  songs: AppleResource[],
  inputIndex: number
):
  | { status: "resolved"; value: ResolvedSong & { inputIndex: number } }
  | { status: "unresolved" | "ambiguous"; issue: SongResolutionIssue } {
  const candidates = songs.map(compactSongCandidate);
  if (!songs.length) {
    return {
      status: "unresolved",
      issue: { inputIndex, input, query, reason: "Apple Music returned no song candidates.", candidates }
    };
  }

  const ranked = songs
    .map((resource) => scoreSongCandidate(input, query, resource))
    .filter((candidate): candidate is CandidateScore => candidate !== undefined)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];

  const minimumScore = input.name && input.artist ? 145 : input.name || input.artist ? 105 : 60;
  if (!best || best.score < minimumScore) {
    return {
      status: "unresolved",
      issue: {
        inputIndex,
        input,
        query,
        reason: "No candidate matched the requested title, artist, and version with high confidence.",
        candidates: candidates.slice(0, 5)
      }
    };
  }
  if (
    runnerUp &&
    runnerUp.score >= best.score - 5 &&
    runnerUp.resource.id !== best.resource.id &&
    materiallyDifferent(best.resource, runnerUp.resource)
  ) {
    return {
      status: "ambiguous",
      issue: {
        inputIndex,
        input,
        query,
        reason: "Multiple Apple Music songs matched too closely to choose safely.",
        candidates: ranked.slice(0, 5).map((candidate) => compactSongCandidate(candidate.resource))
      }
    };
  }

  const attributes = best.resource.attributes ?? {};
  return {
    status: "resolved",
    value: {
      inputIndex,
      id: best.resource.id,
      type: "songs",
      query,
      name: stringAttribute(attributes, "name"),
      artist: stringAttribute(attributes, "artistName"),
      album: stringAttribute(attributes, "albumName"),
      url: stringAttribute(attributes, "url"),
      match: best.exactTitle && (!input.artist || best.exactArtist) ? "exact" : "high_confidence"
    }
  };
}

function scoreSongCandidate(input: SongLookupInput, query: string, resource: AppleResource): CandidateScore | undefined {
  const attributes = resource.attributes ?? {};
  const candidateName = stringAttribute(attributes, "name") ?? "";
  const candidateArtist = stringAttribute(attributes, "artistName") ?? "";
  const wantedTitle = input.name ?? "";
  const wantedArtist = input.artist ?? "";
  const normalizedCandidateTitle = normalize(candidateName);
  const normalizedWantedTitle = normalize(wantedTitle);
  const normalizedCandidateArtist = normalize(candidateArtist);
  const normalizedWantedArtist = normalize(wantedArtist);
  const exactTitle = Boolean(normalizedWantedTitle) && normalizedCandidateTitle === normalizedWantedTitle;
  const exactArtist = Boolean(normalizedWantedArtist) && normalizedCandidateArtist === normalizedWantedArtist;

  if (wantedArtist && !artistMatches(normalizedWantedArtist, normalizedCandidateArtist)) return undefined;
  if (wantedTitle && versionsConflict(wantedTitle, candidateName)) return undefined;

  let score = 0;
  if (wantedTitle) {
    if (exactTitle) score += 100;
    else if (baseTitle(normalizedCandidateTitle) === baseTitle(normalizedWantedTitle)) score += 82;
    else score += tokenCoverage(normalizedWantedTitle, normalizedCandidateTitle) * 65;
  }
  if (wantedArtist) {
    if (exactArtist) score += 60;
    else if (artistMatches(normalizedWantedArtist, normalizedCandidateArtist)) score += 42;
  }

  const normalizedQuery = normalize(query);
  const searchable = normalize(`${candidateName} ${candidateArtist}`);
  score += tokenCoverage(normalizedQuery, searchable) * 45;
  if (!wantedTitle && normalizedCandidateTitle && normalizedQuery.startsWith(normalizedCandidateTitle)) score += 20;
  return { resource, score, exactTitle, exactArtist };
}

function compactSongCandidate(resource: AppleResource): SongResolutionIssue["candidates"][number] {
  const attributes = resource.attributes ?? {};
  return {
    id: resource.id,
    name: stringAttribute(attributes, "name"),
    artist: stringAttribute(attributes, "artistName"),
    album: stringAttribute(attributes, "albumName"),
    url: stringAttribute(attributes, "url")
  };
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

export function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function baseTitle(value: string): string {
  const markers = [" remix", " live", " acoustic", " sped up", " slowed", " radio edit", " edit", " demo", " instrumental", " karaoke", " cover", " mixed", " dj mix"];
  let result = value;
  for (const marker of markers) {
    const index = result.indexOf(marker);
    if (index > 0) result = result.slice(0, index);
  }
  return result.trim();
}

export function versionsConflict(wanted: string, candidate: string): boolean {
  const qualifiers = ["remix", "live", "acoustic", "sped up", "slowed", "radio edit", "edit", "demo", "instrumental", "karaoke", "cover", "mixed", "dj mix"];
  const normalizedWanted = normalize(wanted);
  const normalizedCandidate = normalize(candidate);
  return qualifiers.some((qualifier) => normalizedCandidate.includes(qualifier) !== normalizedWanted.includes(qualifier));
}

function materiallyDifferent(left: AppleResource, right: AppleResource): boolean {
  const leftAttributes = left.attributes ?? {};
  const rightAttributes = right.attributes ?? {};
  return (
    normalize(stringAttribute(leftAttributes, "name") ?? "") !== normalize(stringAttribute(rightAttributes, "name") ?? "") ||
    normalize(stringAttribute(leftAttributes, "artistName") ?? "") !== normalize(stringAttribute(rightAttributes, "artistName") ?? "")
  );
}

function artistMatches(wanted: string, candidate: string): boolean {
  if (!wanted || !candidate) return false;
  if (wanted === candidate) return true;
  const wantedParts = new Set(wanted.split(/\s+(?:and|feat|featuring|with|x)\s+/));
  const candidateParts = new Set(candidate.split(/\s+(?:and|feat|featuring|with|x)\s+/));
  return [...wantedParts].some((part) => candidateParts.has(part));
}

function tokenCoverage(wanted: string, candidate: string): number {
  const wantedTokens = [...new Set(wanted.split(" ").filter((token) => token.length > 1))];
  if (!wantedTokens.length) return 0;
  const candidateTokens = new Set(candidate.split(" "));
  return wantedTokens.filter((token) => candidateTokens.has(token)).length / wantedTokens.length;
}
