// A download must not rebuild the application on every tick.
//
// WHAT THIS COVERS THAT NOTHING ELSE DID. The install-progress subscription in
// main.ts called render() for every event the backend emitted, which for a large
// model is several per second for many minutes. render() does `app.innerHTML =
// ""` and builds the whole tree again, so the element holding the user's scroll
// position ceased to exist on every tick, and the card whose download they were
// watching scrolled away from under them. It was reported twice from real use
// before it was believed, because reading the handler does not make the cost
// obvious: `render()` is one word.
//
// The fix repaints the one bar in place. What proves it is NOT that the bar
// shows the right width, which was true before and after; it is that the DOM
// node holding it is the SAME object across ticks. Node identity is the only
// assertion a rebuild cannot survive, so it is the one this file makes.
//
// linkedom does no layout, so nothing here can assert what the user sees. It
// asserts what the user's scroll position depends on: that the tree it lives in
// is not thrown away. That is the defect, stated in the only terms a DOM without
// a viewport can state it.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { clearIpcCalls, installDom, ipcCallsFor, routeIpc, waitFor } from "./env";

/** One certified, installable, downloadable model: enough to draw a card. */
const MODEL = {
  id: "olmoe-1b-7b",
  name: "OLMoE 1B-7B",
  arch: "olmoe",
  gguf_bytes: 4_000_000_000,
  non_expert_bytes: 500_000_000,
  expert_bytes_total: 3_000_000_000,
  layers_moe: 16,
  experts: 64,
  experts_used: 8,
  min_ram_gb: 16,
  status: "certified_bit_transparent",
  installed: false,
  download: { base: "https://example.invalid/x", files: ["a.gguf"] },
  measured: [{ cache_gb: 1, prompt_tps: 10, gen_tps: 10, passes: 3, spread_pct: 1 }],
};

function routeBoot(): void {
  routeIpc((cmd) => {
    switch (cmd) {
      case "settings_get":
        // app_mode_chosen keeps the two-door screen away; view_last opens on the
        // models page, which is the surface under test.
        // `root` is what takes render() past the first-run screen, which has no
        // navigation at all: without it the models tab does not exist to click.
        return { app_mode: "app", app_mode_chosen: "1", root: "/tmp/galactus" };
      // load_registry IS the model catalogue: api.registry() invokes it. Routing
      // it to a placeholder gave a card that failed every verdict and so drew no
      // install controls, which is how the first version of this test timed out.
      case "load_registry":
        return [MODEL];
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
        return { chip: "Apple M2", cores: 8, ram_gb: 64, disk_free_gb: 900 };
      case "kb_stats":
        return null;
      case "jobs_list":
        return { jobs: [], state: {}, error: "" };
      case "plugin:app|version":
        return "0.1.11";
      case "memory_read":
      case "learned_folder":
      case "server_log":
        return "";
      default:
        return null;
    }
  });
}

/**
 * The callback main.ts registered for one Tauri event.
 *
 * listen() hands its handler to transformCallback, which the harness stores on
 * globalThis under a numeric id, and then invokes `plugin:event|listen` carrying
 * that id. Reading the id back out of the recorded call is how a test delivers
 * an event the backend would otherwise have to emit.
 */
function listenerFor(eventName: string): ((payload: unknown) => void) | null {
  for (const call of ipcCallsFor("plugin:event|listen")) {
    const args = call.args as Record<string, unknown>;
    if (args.event !== eventName) continue;
    const id = args.handler as number;
    const fn = (globalThis as unknown as Record<number, unknown>)[id];
    if (typeof fn === "function") {
      return (payload: unknown) => (fn as (v: unknown) => void)({ event: eventName, payload });
    }
  }
  return null;
}

let booted = false;
async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  installDom();
  routeBoot();
  clearIpcCalls();
  await import("../../src/main");
  await waitFor(() => ipcCallsFor("settings_get").length > 0, "boot to read its settings");
  await waitFor(
    () => document.querySelector("#app .layout") !== null,
    "boot() to render a view",
  );
  await waitFor(
    () => ipcCallsFor("plugin:event|listen").length > 0,
    "boot() to reach its event subscriptions",
  );
  // The app opens on the chat. The models page is reached the way a user reaches
  // it, by clicking its navigation button, so `view` is set by the same code
  // path the install handler later reads.
  const tab = document.querySelector('[data-v="models"]') as HTMLElement | null;
  if (!tab) throw new Error("no models tab in the navigation");
  tab.click();
  await waitFor(() => document.querySelector("[data-mcard]") !== null, "the models page to draw a card");
}

test("a progress tick moves the bar without rebuilding the tree", async () => {
  await boot();
  const fire = listenerFor("galactus://install-progress");
  assert.ok(fire, "main.ts must subscribe to galactus://install-progress");

  // First tick. This one IS allowed to rebuild: the card has to turn its
  // Download button into a cancel button, which no in-place repaint does.
  fire!({ model_id: MODEL.id, pct: 10, label: "download", done: false });
  await waitFor(
    () => document.querySelector("[data-mcard] [data-prog] > div") !== null,
    "the card to show an install bar",
  );

  const layoutBefore = document.querySelector("#app .layout");
  const cardBefore = document.querySelector("[data-mcard]");
  const barBefore = document.querySelector("[data-mcard] [data-prog] > div") as HTMLElement;
  assert.ok(layoutBefore && cardBefore && barBefore);

  // Every subsequent tick must be in place.
  fire!({ model_id: MODEL.id, pct: 47, label: "download", done: false });
  fire!({ model_id: MODEL.id, pct: 62, label: "pack", done: false });

  assert.equal(
    document.querySelector("#app .layout"),
    layoutBefore,
    "the layout was rebuilt: every scroll position in it is gone",
  );
  assert.equal(
    document.querySelector("[data-mcard]"),
    cardBefore,
    "the model card was replaced rather than repainted",
  );
  assert.equal(
    document.querySelector("[data-mcard] [data-prog] > div"),
    barBefore,
    "the bar element was replaced rather than moved",
  );
  assert.equal(barBefore.style.width, "62%", "the bar must still follow the download");
});

test("a tick for a model with no card on screen falls back to a full render", async () => {
  await boot();
  const fire = listenerFor("galactus://install-progress");
  assert.ok(fire);
  // An id the catalogue does not hold has no card, so the in-place path cannot
  // handle it and must say so rather than silently dropping the update.
  const before = document.querySelector("#app .layout");
  fire!({ model_id: "not-in-the-catalogue", pct: 5, label: "download", done: false });
  await waitFor(
    () => document.querySelector("#app .layout") !== before,
    "an unknown model to fall back to a full render",
  );
});
