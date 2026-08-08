// Proof for app/src/code/phrases.ts: the CodeMirror strings are translated,
// completely, in both languages, and the $ placeholders survive translation.

import { EditorState } from "@codemirror/state";
import { PHRASE_KEYS, cmPhrases, placeholderCount } from "../../src/code/phrases.js";

const NODE_TEST = "node:test";
const NODE_ASSERT = "node:assert/strict";
const { test } = (await import(NODE_TEST)) as {
  test: (name: string, fn: () => unknown) => void;
};
const assert = ((await import(NODE_ASSERT)) as { default: any }).default;

const LANGS = ["en", "fr"] as const;

test("the key list is frozen, unique and not empty", () => {
  assert.ok(Object.isFrozen(PHRASE_KEYS));
  assert.equal(new Set(PHRASE_KEYS).size, PHRASE_KEYS.length);
  assert.equal(PHRASE_KEYS.length, 33);
  for (const k of PHRASE_KEYS) assert.ok(k.length > 0, JSON.stringify(k));
});

test("every key is covered in both languages, with no empty string", () => {
  for (const lang of LANGS) {
    const table = cmPhrases(lang);
    assert.deepEqual(Object.keys(table), [...PHRASE_KEYS], `key order, ${lang}`);
    for (const k of PHRASE_KEYS) {
      const v = table[k];
      assert.equal(typeof v, "string", `${lang}: ${k}`);
      assert.ok(v.trim().length > 0, `${lang}: ${k} is empty`);
    }
  }
});

test("translations keep the same $ placeholders", () => {
  const fr = cmPhrases("fr");
  for (const k of PHRASE_KEYS) {
    assert.equal(placeholderCount(fr[k]), placeholderCount(k), `placeholders in ${k}`);
  }
});

test("french is actually french, english is the identity", () => {
  const en = cmPhrases("en");
  for (const k of PHRASE_KEYS) assert.equal(en[k], k);

  const fr = cmPhrases("fr");
  // Every key whose English wording is a word is expected to move. The three
  // that legitimately do not are the ones French spells the same way.
  const same = PHRASE_KEYS.filter((k) => fr[k] === k);
  assert.deepEqual(same, ["Diagnostics"]);
});

test("the table drives EditorState.phrase, placeholders included", () => {
  const state = EditorState.create({ extensions: [EditorState.phrases.of(cmPhrases("fr"))] });
  assert.equal(state.phrase("Find"), "Rechercher");
  assert.equal(state.phrase("Revert this chunk"), "Annuler ce bloc");
  assert.equal(state.phrase("replaced $ matches", 3), "3 correspondances remplacées");
  assert.equal(
    state.phrase("replaced match on line $", 12),
    "correspondance remplacée à la ligne 12"
  );
  assert.equal(state.phrase("$ unchanged lines", 7), "7 lignes inchangées");
  // A string CodeMirror does not translate falls through unchanged.
  assert.equal(state.phrase("Galactus"), "Galactus");
});
