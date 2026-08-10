// What the app is willing to believe about a file on a CDN.
//
// The manifest is the one input to this feature that nobody reviews before a
// machine acts on it. scripts/release-manifest.sh runs manifestProblems over
// its own output before a release goes out, so these tests are also the
// acceptance criteria of the release script: the fixture below is the exact
// shape that script emits.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  UPDATE_TARGET,
  manifestProblems,
  parseManifest,
  platformEntry,
  summariseNotes,
  type UpdateManifest,
} from "../../src/update.js";

const SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVURnFiNVZ5dG85K3c9PQo=";

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.1.10",
    notes: "Unattended runs. A machine serving a model can now be given a task.",
    pub_date: "2026-08-10T09:00:00Z",
    platforms: {
      "darwin-aarch64": {
        signature: SIG,
        url: "https://github.com/NoxalisLab/Galactus/releases/download/app-v0.1.10/Galactus.app.tar.gz",
      },
    },
    ...over,
  };
}

test("the shape the release script emits is accepted", () => {
  assert.deepEqual(manifestProblems(fixture()), []);
  const r = parseManifest(fixture());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.manifest.version, "0.1.10");
  const p = platformEntry(r.manifest);
  assert.notEqual(p, null);
  assert.equal(p!.signature, SIG);
  assert.match(p!.url, /app-v0\.1\.10\/Galactus\.app\.tar\.gz$/);
});

test("the four things a manifest must name are each required", () => {
  // Version, signature, asset url, notes. Losing any one of them is a release
  // that installs the wrong thing, installs nothing, or installs silently.
  assert.deepEqual(manifestProblems(fixture({ version: "" })), ["version is missing or empty"]);
  assert.deepEqual(manifestProblems(fixture({ notes: "   " })), ["notes are missing or empty"]);
  assert.deepEqual(manifestProblems(fixture({ version: "0.1" })), [
    "version is not a semantic version: 0.1",
  ]);
  assert.deepEqual(
    manifestProblems(
      fixture({ platforms: { "darwin-aarch64": { signature: "", url: "https://x/y.tar.gz" } } }),
    ),
    ["platform darwin-aarch64 has no signature"],
  );
  assert.deepEqual(
    manifestProblems(fixture({ platforms: { "darwin-aarch64": { signature: SIG, url: "" } } })),
    ["platform darwin-aarch64 has no https url"],
  );
});

test("a plain http asset url is refused", () => {
  // The signature is the real defence, but an update fetched in the clear is
  // a download an intermediary gets to see and to stall.
  const p = manifestProblems(
    fixture({
      platforms: { "darwin-aarch64": { signature: SIG, url: "http://example.com/a.tar.gz" } },
    }),
  );
  assert.deepEqual(p, ["platform darwin-aarch64 has no https url"]);
});

test("a manifest for another machine is refused rather than half read", () => {
  const p = manifestProblems(
    fixture({
      platforms: { "windows-x86_64": { signature: SIG, url: "https://x/y.zip" } },
    }),
  );
  assert.deepEqual(p, [`no entry for ${UPDATE_TARGET} or darwin-universal`]);
});

test("a universal build serves this machine", () => {
  const m = fixture({
    platforms: { "darwin-universal": { signature: SIG, url: "https://x/y.tar.gz" } },
  });
  assert.deepEqual(manifestProblems(m), []);
  assert.equal(platformEntry(m as unknown as UpdateManifest)!.url, "https://x/y.tar.gz");
});

test("aarch64 wins over universal when both are offered", () => {
  const m = fixture({
    platforms: {
      "darwin-universal": { signature: SIG, url: "https://x/universal.tar.gz" },
      "darwin-aarch64": { signature: SIG, url: "https://x/aarch64.tar.gz" },
    },
  }) as unknown as UpdateManifest;
  assert.equal(platformEntry(m)!.url, "https://x/aarch64.tar.gz");
});

test("garbage is reported once, not as a cascade", () => {
  assert.deepEqual(manifestProblems(null), ["not a JSON object"]);
  assert.deepEqual(manifestProblems("{}"), ["not a JSON object"]);
  assert.deepEqual(manifestProblems([fixture()]), ["not a JSON object"]);
  assert.deepEqual(manifestProblems({}), [
    "version is missing or empty",
    "notes are missing or empty",
    "pub_date is missing or is not an RFC 3339 timestamp",
    "platforms is missing",
  ]);
});

test("a truncated upload names every fault at once", () => {
  const p = manifestProblems({ version: "0.1.10", platforms: {} });
  assert.equal(p.length, 4);
  assert.ok(p.includes("notes are missing or empty"));
  assert.ok(p.includes("platforms is empty"));
});

test("release notes lose their banner and keep their sections", () => {
  const body = [
    "# Galactus Desktop v0.1.8",
    "",
    "A native macOS app for the Galactus MoE engine.",
    "",
    "## Unattended runs",
    "",
    "Server mode hosted a model and stopped there.",
  ].join("\n");
  const s = summariseNotes(body);
  assert.equal(s.startsWith("A native macOS app"), true, s);
  assert.ok(s.includes("Unattended runs"));
  assert.ok(!s.includes("#"));
});

test("a long body is cut on a word boundary and marked", () => {
  const s = summariseNotes(`${"alpha beta ".repeat(300)}`, 100);
  assert.ok(s.length <= 104, String(s.length));
  assert.ok(s.endsWith("..."));
  assert.ok(!s.includes("alph..."));
});
