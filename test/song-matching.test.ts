import assert from "node:assert/strict";
import test from "node:test";
import { chooseSongMatch } from "../src/song-matching.ts";
import type { AppleResource } from "../src/types.ts";

function song(id: string, name: string, artistName: string, albumName = "Album"): AppleResource {
  return {
    id,
    type: "songs",
    attributes: {
      name,
      artistName,
      albumName,
      url: `https://music.apple.com/us/song/${id}`
    }
  };
}

test("exact title and artist wins over an unrelated remix result", () => {
  const outcome = chooseSongMatch(
    { name: "I Love It", artist: "Icona Pop" },
    "I Love It Icona Pop",
    [
      song("remix", "I Love It (Cobra Starship Remix)", "Icona Pop & Charli XCX"),
      song("original", "I Love It (feat. Charli XCX)", "Icona Pop")
    ],
    0
  );

  assert.equal(outcome.status, "resolved");
  if (outcome.status === "resolved") assert.equal(outcome.value.id, "original");
});

test("a title match by the wrong artist is unresolved", () => {
  const outcome = chooseSongMatch(
    { name: "Boys", artist: "Adéla" },
    "Boys Adéla",
    [song("wrong", "Boys", "Melanie Martinez")],
    0
  );

  assert.equal(outcome.status, "unresolved");
});

test("an unintended remix is rejected even when the artist matches", () => {
  const outcome = chooseSongMatch(
    { name: "I Love It", artist: "Icona Pop" },
    "I Love It Icona Pop",
    [song("remix", "I Love It (Cobra Starship Remix)", "Icona Pop")],
    0
  );

  assert.equal(outcome.status, "unresolved");
});

test("an explicitly requested remix can resolve to that version", () => {
  const outcome = chooseSongMatch(
    { name: "I Love It (Cobra Starship Remix)", artist: "Icona Pop" },
    "I Love It Cobra Starship Remix Icona Pop",
    [song("remix", "I Love It (Cobra Starship Remix)", "Icona Pop")],
    0
  );

  assert.equal(outcome.status, "resolved");
  if (outcome.status === "resolved") assert.equal(outcome.value.id, "remix");
});

test("duplicate catalog IDs for the same recording choose Apple's top result", () => {
  const outcome = chooseSongMatch(
    { name: "Song", artist: "Artist" },
    "Song Artist",
    [song("one", "Song", "Artist", "Album One"), song("two", "Song", "Artist", "Album Two")],
    0
  );

  assert.equal(outcome.status, "resolved");
  if (outcome.status === "resolved") assert.equal(outcome.value.id, "one");
});

test("equally strong materially different matches are reported as ambiguous", () => {
  const outcome = chooseSongMatch(
    { term: "Song Artist" },
    "Song Artist",
    [song("one", "Song", "Artist"), song("two", "Song Artist", "Someone Else")],
    0
  );

  assert.equal(outcome.status, "ambiguous");
});
