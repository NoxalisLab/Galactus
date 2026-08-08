// @ts-ignore Node's own test runner, no dependency added.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";
// @ts-ignore
import { readFileSync } from "node:fs";
// @ts-ignore
import { fileURLToPath } from "node:url";

import { planReplace, REPLACE_FILE_CAP, ReplaceCapError } from "../../src/code/replace.js";
import { utf8Len } from "../../src/code/workspace-api.js";
import type { SearchHit } from "../../src/code/workspace-api.js";
import { makeFake, opts, searchAll, WORKSPACE } from "./fake.js";

// This file runs from tools/nav/out/tools/nav/. Both roots are derived from
// its own URL so the grep below reads the real compiled output.
const OUT_DIR = fileURLToPath(new URL("../../", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../../../../../", import.meta.url));

function reader(fake: ReturnType<typeof makeFake>) {
  return (rel: string) => fake.read("/root", rel);
}

test("the plan rewrites every hit of every file, and returns them", async () => {
  const fake = makeFake();
  const hits = await searchAll(fake, "target");
  fake.resetCounts();
  const plan = await planReplace(hits, "target", "goal", opts(), reader(fake));

  const byRel = new Map(plan.map((p) => [p.rel, p.content]));
  assert.deepEqual(
    [...byRel.keys()].sort(),
    ["docs/readme.md", "src/accents.ts", "src/crlf.ts", "src/eof.ts", "src/main.ts", "vendor/skip.js"]
  );
  for (const [rel, content] of byRel) {
    assert.ok(!content.includes("target"), `${rel} still holds the old text`);
    assert.ok(content.includes("goal"), `${rel} did not get the new text`);
  }
  // The disk was never touched: the fake still holds its original content.
  assert.equal(fake.filesMap.get("src/main.ts"), WORKSPACE["src/main.ts"]);
});

test("two hits on one line both apply, left to right", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "target")).filter(
    (h) => h.path === "src/main.ts" && h.line === 2
  );
  assert.equal(hits.length, 2);
  const plan = await planReplace(hits, "target", "goal", opts(), reader(fake));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].content.split("\n")[1], "const other = goal + goal;");
});

test("overlapping hits on one line resolve left to right, the second dropped", async () => {
  // "aaaa" searched for "aa" reports overlapping matches at columns 1 and 2 if
  // the backend ever emits them. The plan must not corrupt the line.
  const fake = makeFake({ "a.txt": "aaaa\n" });
  const hits: SearchHit[] = [
    { path: "a.txt", line: 1, col: 1, text: "aaaa" },
    { path: "a.txt", line: 1, col: 2, text: "aaaa" },
    { path: "a.txt", line: 1, col: 3, text: "aaaa" },
  ];
  const plan = await planReplace(hits, "aa", "B", opts(), reader(fake));
  assert.deepEqual(plan, [{ rel: "a.txt", content: "BB\n" }]);
});

test("a hit at offset 0 of the first line is replaced", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "target")).filter(
    (h) => h.path === "src/main.ts" && h.line === 1
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].col, 1);
  const plan = await planReplace(hits, "target", "goal", opts(), reader(fake));
  assert.equal(plan[0].content.split("\n")[0], "goal = 1;");
});

test("a hit at EOF, on a file with no final newline, keeps the file newline-free", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "target")).filter((h) => h.path === "src/eof.ts");
  assert.equal(hits.length, 1);
  const plan = await planReplace(hits, "target", "goal", opts(), reader(fake));
  assert.equal(plan[0].content, "const a = 1;\nconst last = goal");
  assert.ok(!plan[0].content.endsWith("\n"));
});

test("a multi-byte line is cut at the right character, not at the right byte", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "target")).filter((h) => h.path === "src/accents.ts");
  assert.equal(hits.length, 2);
  // A CHARACTER column and a BYTE length, exactly what search.rs reports.
  const line1 = 'const café = "fête target fête";';
  assert.equal(hits[0].col, line1.indexOf("target") + 1);
  assert.notEqual(hits[0].col, utf8Len(line1.slice(0, line1.indexOf("target"))) + 1);
  assert.equal(hits[0].len, 6);

  const plan = await planReplace(hits, "target", "cible", opts(), reader(fake));
  assert.equal(
    plan[0].content,
    'const café = "fête cible fête";\nconst emoji = "🎉 cible 🎉";\n'
  );
});

test("a multi-byte NEEDLE is replaced whole, using the byte length of the match", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "fête")).filter((h) => h.path === "src/accents.ts");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].len, 5); // four characters, five bytes
  assert.equal(hits[0].col, 15);
  const plan = await planReplace(hits, "fête", "party", opts(), reader(fake));
  assert.equal(plan[0].content, 'const café = "party target party";\nconst emoji = "🎉 target 🎉";\n');
});

test("an emoji is replaced without leaving half a surrogate pair behind", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "🎉")).filter((h) => h.path === "src/accents.ts");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].len, 4);
  const plan = await planReplace(hits, "🎉", "[party]", opts(), reader(fake));
  assert.equal(
    plan[0].content,
    'const café = "fête target fête";\nconst emoji = "[party] target [party]";\n'
  );
});

test("CRLF terminators survive the rewrite", async () => {
  const fake = makeFake();
  const hits = (await searchAll(fake, "target")).filter((h) => h.path === "src/crlf.ts");
  const plan = await planReplace(hits, "target", "goal", opts(), reader(fake));
  assert.equal(plan[0].content, "line one\r\nconst x = goal;\r\nline three\r\n");
});

test("a stale hit is skipped, never guessed at", async () => {
  const fake = makeFake({ "a.txt": "the target moved\n" });
  const hits: SearchHit[] = [
    { path: "a.txt", line: 1, col: 40, text: "the target moved" }, // past the end
    { path: "a.txt", line: 9, col: 1, text: "the target moved" }, // no such line
    { path: "a.txt", line: 1, col: 1, text: "the target moved" }, // "the" is not "target"
  ];
  const plan = await planReplace(hits, "target", "goal", opts(), reader(fake));
  assert.deepEqual(plan, []);
});

test("whole-word narrows what the plan touches", async () => {
  const fake = makeFake({ "a.txt": "cat concatenate cat\n" });
  const all: SearchHit[] = [
    { path: "a.txt", line: 1, col: 1, text: "cat concatenate cat" },
    { path: "a.txt", line: 1, col: 8, text: "cat concatenate cat" },
    { path: "a.txt", line: 1, col: 17, text: "cat concatenate cat" },
  ];
  const loose = await planReplace(all, "cat", "dog", opts(), reader(fake));
  assert.equal(loose[0].content, "dog condogenate dog\n");
  const strict = await planReplace(all, "cat", "dog", opts({ wholeWord: true }), reader(fake));
  assert.equal(strict[0].content, "dog concatenate dog\n");
});

test("a file whose content does not change produces no proposal", async () => {
  const fake = makeFake({ "a.txt": "same\n" });
  const hits: SearchHit[] = [{ path: "a.txt", line: 1, col: 1, text: "same" }];
  assert.deepEqual(await planReplace(hits, "same", "same", opts(), reader(fake)), []);
});

test("GUARD 1: the base of each file is read exactly once, never once per hit", async () => {
  const fake = makeFake();
  const hits = await searchAll(fake, "target");
  assert.ok(hits.length > 6, "the fixture must have more hits than files");
  fake.resetCounts();
  await planReplace(hits, "target", "goal", opts(), reader(fake));
  const files = new Set(hits.map((h) => h.path)).size;
  assert.equal(fake.readTotal, files, `read ${fake.readTotal} times for ${files} files`);
  for (const [rel, n] of fake.readCounts) assert.equal(n, 1, `${rel} was read ${n} times`);
});

test("GUARD 2: the plan refuses more files than the review cap", async () => {
  const files: Record<string, string> = {};
  const hits: SearchHit[] = [];
  for (let i = 0; i < REPLACE_FILE_CAP + 1; i++) {
    const rel = `f${i}.txt`;
    files[rel] = "target\n";
    hits.push({ path: rel, line: 1, col: 1, text: "target" });
  }
  const fake = makeFake(files, []);
  await assert.rejects(
    () => planReplace(hits, "target", "goal", opts(), reader(fake)),
    (e: unknown) => {
      assert.ok(e instanceof ReplaceCapError);
      assert.equal((e as ReplaceCapError).files, REPLACE_FILE_CAP + 1);
      assert.match(String((e as Error).message), /exceeds the review cap of 40/);
      return true;
    }
  );
  // Refused before reading anything: the cap is a gate, not a filter.
  assert.equal(fake.readTotal, 0);

  // Exactly at the cap it goes through.
  const ok = await planReplace(hits.slice(0, REPLACE_FILE_CAP), "target", "goal", opts(), reader(fake));
  assert.equal(ok.length, REPLACE_FILE_CAP);
  assert.equal(REPLACE_FILE_CAP, 40);
});

test("NO WRITE CAPABILITY: the compiled module cannot reach the disk", () => {
  const js = readFileSync(OUT_DIR + "src/code/replace.js", "utf8");
  for (const forbidden of ["codeWrite", "code_write", "invoke(", "writeAccepted", "fileProposal", "@tauri-apps"]) {
    assert.ok(!js.includes(forbidden), `replace.js mentions ${forbidden}`);
  }
  // Its only import is the contract module, which has no write method either.
  const imports = [...js.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ["./workspace-api.js"]);
  const contract = readFileSync(OUT_DIR + "src/code/workspace-api.js", "utf8");
  for (const forbidden of ["codeWrite", "code_write", "invoke(", "@tauri-apps"]) {
    assert.ok(!contract.includes(forbidden), `workspace-api.js mentions ${forbidden}`);
  }
  // And the source says the same thing: no write, no api, no Tauri.
  const src = readFileSync(APP_DIR + "src/code/replace.ts", "utf8");
  assert.ok(!/from\s+["']\.\.\/api/.test(src));
});
