// The two guards that ended the loop of 27 August, pinned by that loop.
//
// This exercises src/toolloop.ts itself, not a copy of it: the rules were
// extracted out of agent.ts precisely so the Node runner could reach them.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { RepeatGuard, isSpillPath, looksMissing, missingPathHint, spillWindow } from "../../src/toolloop.js";

// ---------------------------------------------------------------- spill paths

test("a scratch spill is recognised by its path", () => {
  const dir = "/Users/x/Library/Application Support/Galactus/scratch";
  assert.equal(isSpillPath(`${dir}/tool-mtbe3odo-edit_document.txt`), true);
  assert.equal(isSpillPath(`${dir}/tool-mtbe6f1c-read_file.txt`), true);
});

test("an ordinary file is not", () => {
  assert.equal(isSpillPath("/Users/x/Desktop/CARCITEK-traduit.docx"), false);
  assert.equal(isSpillPath("/Users/x/scratch/notes.txt"), false, "not a tool- spill");
  assert.equal(isSpillPath("/Users/x/scratch/tool-a/inner.txt"), false, "a directory, not the file");
});

// --------------------------------------------------------------- spill window

test("a window says where it is and how to advance it", () => {
  const body = "x".repeat(5000);
  const out = spillWindow(body, 2000, "/s/scratch/tool-a.txt", 0);
  assert.ok(out.length < body.length, "the window is smaller than the file");
  assert.match(out, /\[WINDOW: bytes 0 to 1500 of \/s\/scratch\/tool-a\.txt\./);
  assert.match(out, /offset: 1500/, "names the offset that advances it");
  assert.match(out, /retrieve\("\/s\/scratch\/tool-a\.txt"/, "offers the cheaper way");
});

test("advancing twice reaches the end and says so", () => {
  const body = "y".repeat(2600);
  const first = spillWindow(body, 2000, "/s/scratch/tool-a.txt", 0);
  const next = Number(/offset: (\d+)/.exec(first)![1]);
  assert.equal(next, 1500);
  const second = spillWindow(body.slice(next), 2000, "/s/scratch/tool-a.txt", next);
  assert.match(second, /This is the end of the file\.\]/);
  assert.doesNotMatch(second, /offset:/, "nothing left to advance to");
});

test("the offset it hands back is in BYTES, not characters", () => {
  // The report that started all this was French. Counting characters here
  // would send the next read into the middle of a multi-byte letter.
  const body = "é".repeat(3000);
  const out = spillWindow(body, 2000, "/s/scratch/tool-a.txt", 0);
  const next = Number(/offset: (\d+)/.exec(out)![1]);
  assert.equal(next, 3000, "1500 accented characters are 3000 bytes");
});

test("a window prefers to stop on a line boundary", () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const out = spillWindow(body, 2000, "/s/scratch/tool-a.txt", 0);
  const shown = out.slice(0, out.indexOf("\n\n[WINDOW"));
  assert.ok(shown.endsWith(shown.split("\n").pop()!), "no half line");
  assert.doesNotMatch(shown.split("\n").pop()!, /^line \d+ /, "the last line is whole");
});

test("a tiny allowance still yields a usable window", () => {
  const out = spillWindow("z".repeat(9000), 10, "/s/scratch/tool-a.txt", 0);
  assert.match(out, /\[WINDOW: bytes 0 to 1000 /, "floors at 1000, never at zero");
});

// ---------------------------------------------------------------- repeat guard

test("the first call is free", () => {
  const g = new RepeatGuard();
  assert.deepEqual(g.verdict("read_file", { path: "/a" }), {});
});

test("the second identical call runs, with a note", () => {
  const g = new RepeatGuard();
  g.verdict("read_file", { path: "/a" });
  const v = g.verdict("read_file", { path: "/a" });
  assert.equal(v.stop, undefined, "it still runs");
  assert.match(v.note!, /twice this turn/);
});

test("the third does not run at all", () => {
  const g = new RepeatGuard();
  g.verdict("read_document", { path: "/big.docx" });
  g.verdict("read_document", { path: "/big.docx" });
  const v = g.verdict("read_document", { path: "/big.docx" });
  assert.match(v.stop!, /^error: not run\./);
  assert.match(v.stop!, /call number 3 to read_document/);
  assert.match(v.stop!, /tell the user what you have established/);
});

test("the loop of 27 August is cut at the third round, not the thirtieth", () => {
  // read_document on the same 187 KB file, five times across ninety minutes.
  const g = new RepeatGuard();
  const call = { path: "/Users/x/notice.docx" };
  const ran = [1, 2, 3, 4, 5].filter((_) => !g.verdict("read_document", call).stop);
  assert.deepEqual(ran, [1, 2], "two rounds, then it is refused");
});

test("different arguments are a different call", () => {
  const g = new RepeatGuard();
  g.verdict("read_file", { path: "/a" });
  g.verdict("read_file", { path: "/a" });
  assert.deepEqual(g.verdict("read_file", { path: "/b" }), {}, "another file is free");
  assert.deepEqual(g.verdict("write_file", { path: "/a" }), {}, "another tool is free");
});

test("a new turn forgets everything", () => {
  const g = new RepeatGuard();
  g.verdict("run_command", { command: "ls" });
  g.verdict("run_command", { command: "ls" });
  g.clear();
  assert.deepEqual(g.verdict("run_command", { command: "ls" }), {}, "asking again tomorrow is new");
});

test("arguments that cannot be serialised never block a call", () => {
  const g = new RepeatGuard();
  const cyclic: any = {};
  cyclic.self = cyclic;
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(g.verdict("run_command", cyclic), {}, "no verdict without a comparison");
  }
});

// ------------------------------------------------------------- missing paths

test("a missing path names the one call that fixes it", () => {
  assert.equal(looksMissing("No such file or directory (os error 2)"), true);
  assert.equal(looksMissing("Input file not found!"), true);
  assert.equal(looksMissing("permission denied"), false);
});

test("the hint points at the parent folder, not at another guess", () => {
  // The real case: the model invented "M24001C_Traduction/IFU_final.xlsx" for a
  // file actually called "M24001C_Traduction IFU_final.xlsx", and tried three
  // more spellings before listing the folder.
  const h = missingPathHint("/Users/x/Downloads/swiss_395fe/M24001C_Traduction/IFU_final.xlsx");
  assert.match(h, /list_directory\("\/Users\/x\/Downloads\/swiss_395fe\/M24001C_Traduction"\)/);
  assert.match(h, /Do NOT guess another spelling/);
});

test("a path with no parent produces no hint rather than a broken one", () => {
  assert.equal(missingPathHint("notes.txt"), "");
  assert.equal(missingPathHint("/notes.txt"), "");
  assert.equal(missingPathHint(""), "");
});
