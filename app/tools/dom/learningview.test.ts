// The Apprentissage settings panel, rendered.
//
// THE CLAIMS. Nothing happens until the user turns it on: both switches are
// off and the toolkit shows its size before any download. The student cannot
// be switched on before a checkpoint passed the gate. A rejected training is
// shown with its numbers, not hidden. Deleting traces asks first.
//
// The deps are stubs that record what the panel asked for; the backend's
// shapes are the ones learning.ts parses.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { installDom, mount, settle, waitFor } from "./env";

installDom();

const { learningSection } = await import("../../src/learningview");
type Deps = Parameters<typeof learningSection>[0];

type Html = {
  querySelector: (sel: string) => Html | null;
  textContent: string;
  disabled: boolean;
  getAttribute: (n: string) => string | null;
  click: () => void;
};

const doc = (): Html => (globalThis as unknown as { document: Html }).document;
const find = (sel: string): Html | null => doc().querySelector(sel);

function harness(status: Record<string, unknown>, settings: Record<string, string> = {}, confirmAnswer = true) {
  const calls: string[] = [];
  const store = { ...settings };
  let emit: (p: unknown) => void = () => {};
  const deps: Deps = {
    esc: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: (m) => calls.push(`toast:${m}`),
    settings: async () => ({ ...store }),
    setSetting: async (k, v) => { calls.push(`set:${k}=${v}`); store[k] = v; },
    status: async () => status,
    install: async () => { calls.push("install"); },
    cancelInstall: async () => { calls.push("cancel"); },
    train: async () => { calls.push("train"); },
    cancelTrain: async () => { calls.push("canceltrain"); },
    forgetAll: async () => { calls.push("forget"); },
    setActive: async (on) => { calls.push(`active:${on}`); },
    rollback: async () => { calls.push("rollback"); },
    exportTraces: async () => { calls.push("export"); return "ok"; },
    clearTraces: async () => { calls.push("clear"); },
    confirm: async () => { calls.push("confirm"); return confirmAnswer; },
    listen: async (cb) => { emit = cb; return () => {}; },
    primaryReady: () => true,
    changed: (s) => calls.push(`changed:${s.collect}/${s.active}`),
  };
  mount(learningSection(deps));
  return { calls, emit: (p: unknown) => emit(p) };
}

test("fresh install: everything off, the download size is shown, training needs the toolkit", async () => {
  harness({ installed: false, traces: 0, download_bytes: 2_400_000_000 });
  await waitFor(() => find("#lrncollect")?.getAttribute("aria-disabled") !== "true", "loaded panel");
  assert.equal(find("#lrncollect")!.getAttribute("aria-checked"), "false");
  assert.equal(find("#lrnactive")!.getAttribute("aria-checked"), "false");
  assert.equal(find("#lrnactive")!.getAttribute("aria-disabled"), "true");
  assert.match(find("#lrninstall")!.textContent, /2\.4 GB/);
  assert.equal(find("#lrntrain")!.disabled, true);
  assert.equal(find("#lrnexport")!.disabled, true);
});

test("turning collection on writes the setting and tells the app", async () => {
  const h = harness({ installed: false, traces: 0 });
  await waitFor(() => find("#lrncollect")?.getAttribute("aria-disabled") !== "true", "loaded panel");
  find("#lrncollect")!.click();
  await waitFor(() => h.calls.includes("changed:true/false"), "changed callback");
  assert.ok(h.calls.includes("set:learning_collect=1"));
  assert.equal(find("#lrncollect")!.getAttribute("aria-checked"), "true");
});

test("a rejected training is shown with its numbers and the failed gate", async () => {
  harness({
    installed: true,
    traces: 120,
    last: {
      accepted: false,
      student: { acc: 0.86, ece: 0.14, n: 72 },
      heuristic: { acc: 0.85, n: 72 },
      labels: { teacher: 100, outcome: 0, hand: 340 },
    },
  });
  await waitFor(() => (find(".learn-table")?.textContent ?? "").includes("86.0"), "result table");
  const text = find(".learn")!.textContent;
  assert.match(text, /85\.0/);
  assert.match(text, /0\.140/);
  assert.ok(find(".learn-gate .bad"), "a failed gate condition is marked");
  // Rejected and no active checkpoint: the student stays off.
  assert.equal(find("#lrnactive")!.getAttribute("aria-disabled"), "true");
});

test("training shows live progress and ends on the result", async () => {
  const h = harness({ installed: true, traces: 300, active: "c1", previous: "c0" });
  await waitFor(() => find("#lrntrain")?.disabled === false, "train enabled");
  assert.equal(find("#lrnactive")!.getAttribute("aria-disabled"), null);
  find("#lrntrain")!.click();
  await settle();
  assert.ok(h.calls.includes("train"));
  h.emit({ phase: "train", pct: 42, message: "epoch 2/3" });
  assert.match(find(".learn-prog")!.textContent, /42 %.*epoch 2\/3/);
  // While it runs, the train button gives way to its cancel button.
  assert.equal(find("#lrntrain"), null);
  find("#lrntraincancel")!.click();
  await settle();
  assert.ok(h.calls.includes("canceltrain"));
  h.emit({ phase: "done", pct: 100, result: { accepted: true, student: { acc: 0.93, ece: 0.04, n: 80 }, heuristic: { acc: 0.86, n: 80 }, labels: { teacher: 90, outcome: 5, hand: 340 } } });
  await settle();
  assert.equal(find(".learn-prog"), null);
  assert.ok(h.calls.some((c) => c.startsWith("toast:")));
});

test("rollback and delete ask first, and a no stops them", async () => {
  const h = harness({ installed: true, traces: 12, active: "c1", previous: "c0" }, {}, false);
  await waitFor(() => find("#lrnclear")?.disabled === false, "clear enabled");
  find("#lrnclear")!.click();
  find("#lrnrollback")!.click();
  await settle();
  assert.equal(h.calls.filter((c) => c === "confirm").length, 2);
  assert.ok(!h.calls.includes("clear"));
  assert.ok(!h.calls.includes("rollback"));
});

test("erase everything deletes traces then checkpoints and switches the student off", async () => {
  const h = harness({ installed: true, traces: 5, active: "c1" }, { learning_active: "1" });
  await waitFor(() => find("#lrnforget")?.disabled === false, "forget enabled");
  find("#lrnforget")!.click();
  await waitFor(() => h.calls.includes("forget"), "forget called");
  await settle();
  const order = h.calls.filter((c) => ["confirm", "clear", "forget", "active:false"].includes(c));
  assert.deepEqual(order, ["confirm", "clear", "forget", "active:false"]);
  assert.ok(!h.calls.some((c) => c.startsWith("set:learning_active")), "the setting goes through decisions_set_active");
  assert.ok(h.calls.includes("changed:false/false"));
});

test("a backend error is shown in French with the backend's words underneath", async () => {
  const h = harness({ installed: true, traces: 300 });
  await waitFor(() => find("#lrntrain")?.disabled === false, "train enabled");
  find("#lrntrain")!.click();
  await settle();
  h.emit({ phase: "error", message: "label: teacher returned HTTP 503", job: "training" });
  await settle();
  assert.match(find(".learn-detail")!.textContent, /HTTP 503/);
  assert.ok(find(".learn-error .warn")!.textContent.length > 0);
  assert.equal(find("#lrntrain")!.disabled, false);
});

test("the student switch goes through decisions_set_active, and training says how many traces it needs", async () => {
  const h = harness({ installed: true, traces: 50, active: "c1" });
  await waitFor(() => find("#lrnactive")?.getAttribute("aria-disabled") === null, "switch enabled");
  assert.equal(find("#lrntrain")!.disabled, true);
  assert.match(find(".learn")!.textContent, /50.*240/);
  find("#lrnactive")!.click();
  await waitFor(() => h.calls.includes("active:true"), "set_active called");
  assert.ok(!h.calls.some((c) => c.startsWith("set:learning_active")));
});
