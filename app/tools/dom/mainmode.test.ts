// The launch mode choice, asserted on the real boot path.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. `modePending` is decided by one line
// inside boot() and consumed by one branch inside render(), both in main.ts.
// main.ts is 4400 lines, imports the whole app, and calls boot() at module
// scope, so no test project in tools/ could reach it: every assertion about the
// two door screen was therefore a reading of the source, not a run of it.
//
// It is reachable here because the harness supplies the two things Node lacks,
// a document and window.__TAURI_INTERNALS__, and because boot() asks for its
// settings through that bridge. Feeding a settings map and then reading the
// rendered tree is the actual behaviour, end to end: the same file, the same
// render(), the same class names the stylesheet targets.
//
// THE SETTINGS THAT MATTER, and why the distinction is the whole feature:
//
//   app_mode          which mode. Pre-exists on installs, written for two
//                     releases by a settings row nobody could find.
//   app_mode_chosen   whether the question was ever PUT to a human.
//   app_mode_ask      ask again at every launch.
//
// Keying the screen on app_mode would hide it from exactly the people it is
// for: the ones holding a mode they never chose. So the test that matters is
// the third one below, where app_mode is set and the screen must still appear.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { clearIpcCalls, installDom, ipcCallsFor, routeIpc, waitFor } from "./env";

// @ts-ignore the one Node global this file reads, declared rather than pulled
// in with @types/node, which would be a dependency for a single string.
declare const process: { env: Record<string, string | undefined> };

/**
 * Everything boot() asks for, answered with the shape each caller expects.
 *
 * Unrouted commands return null rather than throwing. boot() wraps most of its
 * calls in a catch, so a throw would be swallowed and the test would pass for
 * the wrong reason; null keeps the failure visible where it matters and lets
 * the paths under test run.
 */
function routeBoot(settings: Record<string, string>): void {
  routeIpc((cmd) => {
    switch (cmd) {
      case "settings_get":
        return settings;
      case "settings_set":
        return null;
      // A non-empty registry is what keeps render() past the onboarding branch:
      // `if (!root)` draws the first run screen and returns before the mode
      // choice is ever considered.
      case "load_registry":
        return [{ id: "m", name: "m", path: "/tmp/m", bytes: 1, quant: "Q4", family: "x" }];
      case "conv_list":
      case "mcp_tools":
      case "skills_list":
      case "kb_folders":
      case "learned_list":
      case "list_volumes":
        return [];
      case "relay_addresses":
        return ["127.0.0.1", ""];
      case "relay_status":
        return { running: false, bind: "127.0.0.1", port: 0, keyed: false };
      case "server_status":
        return { running: false, phase: "stopped", port: 0 };
      case "hw_info":
        return { chip: "Apple M2", cores: 8, ram_gb: 16, disk_free_gb: 400 };
      case "kb_stats":
        return null;
      case "jobs_list":
        return { jobs: [], state: {}, error: "" };
      case "plugin:app|version":
        return "0.1.9";
      case "memory_read":
      case "learned_folder":
      case "server_log":
        return "";
      default:
        return null;
    }
  });
}

/** Import main.ts once per process and wait for boot() to have painted. */
async function boot(settings: Record<string, string>): Promise<void> {
  installDom();
  routeBoot(settings);
  clearIpcCalls();
  await import("../../src/main");
  // settings_get is the first thing boot() awaits, so its arrival proves the
  // module body ran rather than merely being resolved.
  await waitFor(() => ipcCallsFor("settings_get").length > 0, "boot to read its settings");
  // Wait for render() to have put SOMETHING in #app. Waiting on the absence of
  // the boot placeholder would be satisfied instantly and for the wrong reason:
  // the harness serves a bare `<div id="app"></div>`, so the placeholder that
  // index.html ships was never there to disappear.
  await waitFor(
    () => document.querySelector("#app .layout") !== null || bootFailed() !== null,
    "boot() to render a view",
  );
  // ...and then for boot() to have finished, which is not the same moment.
  //
  // render() is called more than once on the way through boot(), so a rendered
  // .layout only proves the app drew SOMETHING. Everything after the last
  // render, syncTray among it, would still be pending. The event subscriptions
  // are the last thing boot() does, so the first `plugin:event|listen` is the
  // marker that the tail ran. A boot that failed skips them, which is why the
  // failure shell is an accepted outcome of this wait rather than a timeout.
  await waitFor(
    () => ipcCallsFor("plugin:event|listen").length > 0 || bootFailed() !== null,
    "boot() to reach its event subscriptions",
  );
  const failure = bootFailed();
  // A boot that fell over renders a failure shell and every assertion about the
  // mode screen would then be true for a reason that has nothing to do with the
  // mode screen. Surface the real message instead of reporting a missing div.
  if (failure) throw new Error(`boot() failed: ${failure}`);
}

/** The message on the failure shell, or null when boot() got through. */
function bootFailed(): string | null {
  const shell = document.querySelector(".boot-failed");
  return shell ? (shell.textContent ?? "") : null;
}

/** True when the two door screen is the thing on screen. */
function modeScreenShown(): boolean {
  return document.querySelector(".modechoice") !== null;
}

/** The two doors, by the value they write to app_mode. */
function doors(): string[] {
  return [...document.querySelectorAll(".modechoice [data-m]")].map(
    (b) => (b as HTMLElement).dataset.m ?? "",
  );
}

// A module is imported once per process, and boot() runs on that import, so
// each state needs its own process. node:test gives every FILE a process, not
// every test, which is why the state under test is selected by an environment
// variable and the three cases are three spawns of this same file. GALACTUS_MODE_CASE
// is set by the runner below.
const CASE = process.env.GALACTUS_MODE_CASE ?? "";

test("the mode screen appears when the question was never put", { skip: CASE !== "never" }, async () => {
  await boot({ root: "/tmp/root" });
  assert.equal(modeScreenShown(), true, "a fresh install must be asked");
  assert.deepEqual(doors(), ["app", "server"], "both doors are offered");
  // The other half of the "always" assertion: unset means unchecked, so that
  // test is pinning a value rather than a constant that happens to be right.
  assert.equal(
    document.querySelector("#modeask")!.hasAttribute("checked"),
    false,
    "ask-every-launch is off unless it was set",
  );
});

test(
  "a stored app_mode that nobody chose still gets asked",
  { skip: CASE !== "leftover" },
  async () => {
    // The regression this feature exists for: app_mode alone is a leftover, not
    // an answer, and reading it as one hides the screen from its whole audience.
    await boot({ root: "/tmp/root", app_mode: "server" });
    assert.equal(modeScreenShown(), true, "app_mode is not an answer to the question");
  },
);

test("a recorded choice is not asked again", { skip: CASE !== "chosen" }, async () => {
  await boot({ root: "/tmp/root", app_mode: "app", app_mode_chosen: "1" });
  assert.equal(modeScreenShown(), false, "a chosen mode must not re-ask");
  // Proof the app went on to draw itself rather than merely failing to draw
  // the mode screen, which would satisfy the assertion above for free.
  assert.ok(document.querySelector(".layout"), "the app shell is drawn instead");
  // Assistant mode has no tray item: the app owns a window, so a second way to
  // reach it is clutter. The server case below is the one that asks for it.
  const tray = ipcCallsFor("tray_set");
  assert.ok(tray.length > 0, "the tray is synced at boot, not left to chance");
  assert.equal(tray[tray.length - 1].args.on, false, "assistant mode shows no tray item");

  // The version in the sidebar is the one the BINARY reports.
  //
  // It used to be a literal inside the translation string and it said v0.1.7
  // in the 0.1.9 build, so every user of two consecutive releases was told the
  // wrong version by the only place in the app that states it on every screen.
  // The route above answers plugin:app|version with 0.1.9, so this fails if
  // the sidebar ever goes back to carrying a number of its own.
  const brand = document.querySelector(".brandby");
  assert.ok(brand, "the sidebar states a version");
  assert.match(
    brand!.textContent ?? "",
    /v0\.1\.9$/,
    "the sidebar shows the version the binary reports",
  );
});

test(
  "server mode boots without the assistant surfaces and asks for a tray item",
  { skip: CASE !== "server" },
  async () => {
    // The tray is what makes server mode usable at all: a machine serving a
    // model has no reason to keep a window open, and without a tray item there
    // is no way back to the app once that window is closed.
    await boot({ root: "/tmp/root", app_mode: "server", app_mode_chosen: "1" });
    assert.equal(modeScreenShown(), false, "the choice was recorded");
    const tray = ipcCallsFor("tray_set");
    assert.ok(tray.length > 0, "the tray is synced at boot");
    assert.equal(tray[tray.length - 1].args.on, true, "server mode asks for the tray item");
    // The other half of the mode: the chat and workspace entries are gone, so
    // the screen is not the assistant with a flag set on it.
    const nav = [...document.querySelectorAll(".nav [data-v]")].map(
      (b) => (b as HTMLElement).dataset.v ?? "",
    );
    assert.ok(nav.length > 0, "there is a nav to inspect");
    assert.ok(!nav.includes("chat"), `chat must not be reachable in server mode, got ${nav}`);
    assert.ok(nav.includes("runs"), `runs is what server mode is for, got ${nav}`);
  },
);

test("ask at every launch overrides a recorded choice", { skip: CASE !== "always" }, async () => {
  await boot({ root: "/tmp/root", app_mode: "app", app_mode_chosen: "1", app_mode_ask: "1" });
  assert.equal(modeScreenShown(), true, "the ask-every-launch setting wins");
  // The ATTRIBUTE, not the .checked property. linkedom does not implement the
  // checkedness IDL (it returns undefined for both a checked and an unchecked
  // box), so asserting on .checked would be asserting on the harness. The
  // attribute is what modeChoiceView actually emits and what the webview would
  // read, and the "never" case below asserts its absence, so the pair of tests
  // pins both directions rather than one constant.
  const box = document.querySelector("#modeask");
  assert.ok(box, "the checkbox is on the screen");
  assert.equal(box!.hasAttribute("checked"), true, "and it reflects the stored setting");
});

test(
  "choosing a door records the choice AND that the question was put",
  { skip: CASE !== "click" },
  async () => {
    await boot({ root: "/tmp/root" });
    assert.equal(modeScreenShown(), true);
    clearIpcCalls();
    const server = [...document.querySelectorAll(".modechoice [data-m]")].find(
      (b) => (b as HTMLElement).dataset.m === "server",
    ) as HTMLElement;
    server.dispatchEvent(new Event("click", { bubbles: true }));
    await waitFor(
      () => ipcCallsFor("settings_set").some((c) => c.args.key === "app_mode_chosen"),
      "the choice to be recorded",
    );
    const writes = ipcCallsFor("settings_set");
    const mode = writes.find((c) => c.args.key === "app_mode");
    const chosen = writes.find((c) => c.args.key === "app_mode_chosen");
    assert.equal(mode?.args.value, "server", "the picked mode is stored");
    // Without this second write the screen would come back at every launch,
    // which is the same defect as never showing it, in the other direction.
    assert.equal(chosen?.args.value, "1", "and so is the fact that it was asked");
    assert.equal(modeScreenShown(), false, "the screen gives way to the app");
  },
);
