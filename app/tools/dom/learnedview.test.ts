// The learned skills panel, rendered, and the one claim it has to keep.
//
// THE CLAIM. A skill the agent wrote for itself out of an unattended run is
// stored and shown, but it is NOT part of what the model can call until a
// human accepted it. That claim lives in two places at once and both of them
// have to hold at the same time:
//
//   on screen, the card says pending, shows the text without a click, and
//     offers Approve;
//   in the catalogue handed to the model, the slug does not appear at all.
//
// Either half alone is a lie. A card marked pending whose skill is already in
// the system prompt is worse than no marking; a skill kept out of the prompt
// with no way to see or accept it is a feature nobody can use. The unit tests
// under tools/learned cover the rule; nothing covered the screen, and the
// screen is where a user checks whether the rule is being kept.
//
// The approval round trip goes through a stub that behaves like the Rust side:
// learned_write stores the file, learned_list serves back what was stored. So
// approving really rewrites a file, really re-reads it, and the assertions
// after it are about parsed content and not about a flag in memory.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { installDom, ipcCallsFor, mount, routeIpc, waitFor } from "./env";

installDom();

const learnedview = await import("../../src/learnedview");
const bank = await import("../../src/learnedbank");
const { admitBody, parseSkillFile, renderSkillFile } = await import("../../src/learned");

type Html = {
  querySelector: (sel: string) => Html | null;
  querySelectorAll: (sel: string) => Html[];
  textContent: string;
  className: string;
  hidden: boolean;
  click: () => void;
};

function find(sel: string): Html | null {
  return (globalThis as unknown as { document: Html }).document.querySelector(sel);
}

function findAll(sel: string): Html[] {
  return (globalThis as unknown as { document: Html }).document.querySelectorAll(sel);
}

// ---------------------------------------------------------------- fixtures

const BODY = [
  "## Steps",
  "",
  "1. Read the lockfile and the manifest side by side.",
  "2. Compare every declared range with the version that is installed.",
  "3. Report the first disagreement and stop there rather than editing anything.",
  "",
  "```",
  "npm ls --depth=0",
  "git status --short",
  "```",
  "",
  "## Verification",
  "",
  "Run the two commands again once the report is written. The tree is consistent",
  "when the second listing is identical to the first one and nothing is staged.",
].join("\n");

const PENDING_SLUG = "lockfile-drift-check";
const ACTIVE_SLUG = "stale-branch-report";

function file(slug: string, state: "pending" | "active", origin: "run" | "conversation"): string {
  return renderSkillFile({
    slug,
    description: `what ${slug} does, in one line`,
    origin,
    state,
    created: "2026-08-09",
    signature: `sig-${slug}`,
    body: BODY,
  });
}

// The fixture must be admissible, otherwise the panel would quarantine it and
// this file would be testing the quarantine path while claiming otherwise.
{
  const parsed = parseSkillFile(PENDING_SLUG, file(PENDING_SLUG, "pending", "run"));
  assert.ok(parsed, "the fixture must parse as an authored skill");
  const verdict = admitBody(parsed!.body);
  assert.ok(verdict.ok, `the fixture body must be admissible, got ${String(verdict.reason)}`);
}

/** Stands in for the learned skills directory on disk. */
const disk = new Map<string, string>([
  [PENDING_SLUG, file(PENDING_SLUG, "pending", "run")],
  [ACTIVE_SLUG, file(ACTIVE_SLUG, "active", "conversation")],
]);

const settings: Record<string, string> = {};

routeIpc((cmd, args) => {
  switch (cmd) {
    case "settings_get":
      return { ...settings };
    case "settings_set":
      settings[String(args.key)] = String(args.value);
      return null;
    case "learned_list":
      return [...disk.entries()].map(([slug, body]) => ({ slug, body }));
    case "learned_write":
      disk.set(String(args.slug), String(args.body));
      return `/tmp/learned/${String(args.slug)}/SKILL.md`;
    case "learned_delete":
      if (args.slug === undefined || args.slug === null) disk.clear();
      else disk.delete(String(args.slug));
      return null;
    case "learned_folder":
      return "/Users/someone/Library/Application Support/Galactus/learned";
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});

function card(slug: string): Html | null {
  return findAll(".card.learned").find((c) => c.textContent.includes(slug)) ?? null;
}

// ---------------------------------------------------------------- the tests

test("a pending authored skill is shown, marked, and NOT callable", async () => {
  // Learning ON, so exclusion cannot be explained away by the feature switch.
  await bank.setLearningEnabled(true);
  assert.equal(bank.learningEnabled(), true);

  mount(learnedview.learnedView());
  await waitFor(() => card(PENDING_SLUG) !== null, "the pending skill card");

  const pending = card(PENDING_SLUG)!;
  assert.match(pending.className, /pending/, "the card must be marked pending");
  assert.ok(pending.querySelector(".tag.warn"), "a pending skill carries a warning tag");
  assert.ok(pending.querySelector("[data-approve]"), "a pending skill offers Approve");
  // Opened, not one click behind a button: accepting a text nobody read is the
  // failure this layout exists to prevent.
  const text = pending.querySelector(".learned-body")!;
  assert.equal(text.hidden, false, "a pending body is shown without a click");
  assert.match(text.textContent, /npm ls --depth=0/);

  // THE LOAD BEARING ASSERTION. Not on screen: in what the model is handed.
  const callable = bank.usableLearnedSkills().map((s) => s.slug);
  assert.ok(!callable.includes(PENDING_SLUG), "a pending skill must not be callable");
  const catalogue = bank.learnedCatalogueLines().join("\n");
  assert.ok(!catalogue.includes(PENDING_SLUG), "a pending skill must not be in the catalogue");
});

test("an accepted skill is callable and is not offered for approval again", async () => {
  // Set here as well as in the test above, so this file has no test that only
  // passes because another one ran first. An order dependent suite is a suite
  // whose failures cannot be reproduced one at a time.
  await bank.setLearningEnabled(true);
  mount(learnedview.learnedView());
  await waitFor(() => card(ACTIVE_SLUG) !== null, "the active skill card");

  const active = card(ACTIVE_SLUG)!;
  assert.doesNotMatch(active.className, /pending/);
  assert.equal(active.querySelector("[data-approve]"), null, "an active skill has nothing to approve");
  assert.equal(
    active.querySelector(".learned-body")!.hidden,
    true,
    "an active body starts folded, it has already been read",
  );

  const callable = bank.usableLearnedSkills().map((s) => s.slug);
  assert.ok(callable.includes(ACTIVE_SLUG), "an accepted skill must be callable");
  assert.match(bank.learnedCatalogueLines().join("\n"), new RegExp(ACTIVE_SLUG));
});

test("approving writes the file back as active and only then does it become callable", async () => {
  await bank.setLearningEnabled(true);
  mount(learnedview.learnedView());
  await waitFor(() => card(PENDING_SLUG) !== null, "the pending skill card");

  const before = ipcCallsFor("learned_write").length;
  card(PENDING_SLUG)!.querySelector("[data-approve]")!.click();
  await waitFor(
    () => ipcCallsFor("learned_write").length > before,
    "the approval to reach the backend",
  );
  await waitFor(
    () => bank.usableLearnedSkills().some((s) => s.slug === PENDING_SLUG),
    "the approved skill to become callable",
  );

  // What landed on disk is a file that reads back as active, not a flag that
  // only exists in this process.
  const written = parseSkillFile(PENDING_SLUG, disk.get(PENDING_SLUG)!);
  assert.ok(written, "the rewritten file must still parse");
  assert.equal(written!.state, "active");
  assert.equal(written!.origin, "run", "approving must not launder where it came from");

  await waitFor(
    () => card(PENDING_SLUG) !== null && !/pending/.test(card(PENDING_SLUG)!.className),
    "the card to stop showing as pending",
  );
  assert.equal(card(PENDING_SLUG)!.querySelector("[data-approve]"), null);
});

test("the panel prints the folder the agent writes into", async () => {
  mount(learnedview.learnedView());
  await waitFor(
    () => (find("#lpath")?.textContent ?? "").includes("Galactus/learned"),
    "the learned folder path",
  );
  // The point of showing it is that it is NOT where the shipped skills live.
  assert.doesNotMatch(find("#lpath")!.textContent, /packaged|Resources/);
});
