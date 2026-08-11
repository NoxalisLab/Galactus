// Thinking on the screen, driven by a real server stream.
//
// WHY THIS IS AN END TO END TEST AND NOT A UNIT ONE. The defect being fixed
// was never a wrong decision, it was a missing line: llama-server put the
// model's thoughts in `delta.reasoning_content`, streamChat read `delta.content`
// and `delta.tool_calls` and nothing else, and every thought was parsed and
// dropped. A test of the reasoning rules would have passed against that build,
// because the rules were fine and simply never ran. So this drives the whole
// path instead: an SSE body goes in at the socket, and the assertions are about
// what a person would be looking at.
//
// The only thing stubbed is `fetch`, which is the boundary between the app and
// the engine. api.ts, agent.ts, store.ts and main.ts are the real modules, the
// SSE frames are the frames llama-server emits, and the class names asserted
// on are the ones the stylesheet targets.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import {
  canvasTexts,
  clearCanvasTexts,
  clearIpcCalls,
  installDom,
  ipcCallsFor,
  routeIpc,
  settle,
  waitFor,
} from "./env";

// @ts-ignore the two Node globals this file reads, declared rather than pulling
// in @types/node for a queue and a promise.
declare const setTimeout: (fn: () => void, ms: number) => unknown;

const PORT = 8080;

/** Everything boot() and one chat turn ask the backend for. */
function routeBackend(): void {
  routeIpc((cmd) => {
    switch (cmd) {
      case "settings_get":
        // app_mode_chosen skips the two door screen, which would otherwise be
        // the only thing on screen and there would be no composer to type in.
        return { root: "/tmp/root", app_mode: "app", app_mode_chosen: "1" };
      case "load_registry":
        return [{ id: "m", name: "m", path: "/tmp/m", bytes: 1, quant: "Q4", family: "x" }];
      case "server_status":
        // Ready, or submitChat refuses the turn before a single byte moves.
        return { running: true, phase: "ready", port: PORT, model_id: "m", slots: 2, tools_ok: false };
      case "hw_info":
        return { chip: "Apple M2", cores: 8, ram_gb: 16, disk_free_gb: 400 };
      case "relay_status":
        return { running: false, bind: "127.0.0.1", port: 0, keyed: false };
      case "jobs_list":
        return { jobs: [], state: {}, error: "" };
      case "plugin:app|version":
        return "0.1.11";
      case "conv_list":
      case "mcp_tools":
      case "skills_list":
      case "kb_folders":
      case "learned_list":
      case "list_volumes":
      case "relay_addresses":
        return [];
      case "kb_stats":
        return null;
      case "memory_read":
      case "learned_folder":
      case "server_log":
        return "";
      default:
        return null;
    }
  });
}

/** A stream the test pushes frames into, one `data:` line at a time. */
class Frames {
  private queue: string[] = [];
  private waiting: ((v: void) => void) | null = null;
  private closed = false;

  push(obj: unknown): void {
    this.queue.push(`data: ${JSON.stringify(obj)}\n\n`);
    this.wake();
  }

  end(): void {
    this.queue.push("data: [DONE]\n\n");
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    if (w) w();
  }

  body(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const next = self.queue.shift();
          if (next !== undefined) {
            controller.enqueue(encoder.encode(next));
            return;
          }
          if (self.closed) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            self.waiting = resolve;
          });
        }
      },
    });
  }
}

/** The stream the next chat completion will be served from. */
let pending: Frames | null = null;

/** Replace fetch with the two endpoints one turn touches. */
function stubFetch(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  global.fetch = async (url: unknown): Promise<unknown> => {
    const href = String(url);
    if (href.endsWith("/props")) {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.endsWith("/v1/chat/completions")) {
      const frames = pending ?? new Frames();
      pending = null;
      return new Response(frames.body(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
}

/** One streaming delta, shaped exactly as llama-server shapes it. */
function delta(fields: Record<string, string>): unknown {
  return { choices: [{ index: 0, delta: fields }] };
}

/** Type a message and press send, returning the stream that will answer it. */
function ask(text: string): Frames {
  const frames = new Frames();
  pending = frames;
  const input = document.querySelector("#ci") as unknown as { value: string; disabled: boolean };
  assert.ok(input, "the composer is on screen");
  input.value = text;
  const send = document.querySelector("#send") as unknown as {
    dispatchEvent: (e: unknown) => boolean;
  };
  assert.ok(send, "the send button is on screen");
  send.dispatchEvent(new Event("click", { bubbles: true }));
  return frames;
}

/** Every reasoning block currently drawn. */
function blocks(): Element[] {
  return [...document.querySelectorAll(".think")];
}

/**
 * The text of the LAST reasoning block, or null when there is none.
 *
 * Last, not first: the tests share one booted app and one growing thread, so
 * the block that matters is always the one the turn under test just produced.
 */
function thought(): string | null {
  const all = [...document.querySelectorAll(".think .think-t")];
  const box = all[all.length - 1];
  return box ? (box.textContent ?? "") : null;
}

/** The answer text on screen. */
function answer(): string {
  return [...document.querySelectorAll(".msg-a")].map((n) => n.textContent ?? "").join("");
}

/**
 * How many reasoning blocks the last conv_save actually wrote to disk.
 *
 * The screen is not the only place a block can be left behind. A block that
 * renders as nothing but is stored anyway comes back on every reload, goes
 * into the markdown export and into the Rust side's conversation search, and
 * the only way to see that from here is to read what crossed the bridge.
 */
function storedReasoning(): number {
  const saves = ipcCallsFor("conv_save");
  const last = saves[saves.length - 1];
  if (!last) return 0;
  const items = JSON.parse(String(last.args.data)).items as { kind: string }[];
  return items.filter((i) => i.kind === "reasoning").length;
}

let booted = false;

/** Boot the app once for the whole file; node:test gives a file its own process. */
async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  installDom();
  routeBackend();
  stubFetch();
  clearIpcCalls();
  await import("../../src/main");
  await waitFor(() => ipcCallsFor("settings_get").length > 0, "boot to read its settings");
  await waitFor(() => document.querySelector("#ci") !== null, "the composer to be drawn");
  await waitFor(
    () => ipcCallsFor("plugin:event|listen").length > 0,
    "boot() to reach its event subscriptions",
  );
}

test("a model's thinking is on screen before any of its answer exists", async () => {
  await boot();
  const frames = ask("compare the two configs");

  // The engine is still thinking. Nothing of the answer exists yet, and this
  // is precisely the window that used to show a frozen application.
  frames.push(delta({ reasoning_content: "The user wants a diff. " }));
  frames.push(delta({ reasoning_content: "Both files are TOML." }));
  await waitFor(() => thought() !== null, "the reasoning block to appear");

  assert.equal(
    thought(),
    "The user wants a diff. Both files are TOML.",
    "the thoughts are on screen, in order, joined as one text",
  );
  assert.equal(answer(), "", "and not one character of the answer exists yet");
  assert.ok(
    document.querySelector(".think.open"),
    "the block is open while it streams: closed, it would show nothing moving",
  );

  // The answer starts. This is the moment the owner called "replace".
  frames.push(delta({ content: "They differ on one line." }));
  await waitFor(() => answer().includes("They differ"), "the answer to arrive");
  frames.end();
  await settle(8);

  assert.equal(
    document.querySelectorAll(".think.open").length,
    0,
    "the thinking gives way: it is no longer the thing being read",
  );
  assert.equal(blocks().length, 1, "but it is still there, collapsed, not destroyed");
  assert.match(answer(), /They differ on one line/, "and the answer has the reading surface");

  // Collapsed does not mean unreachable: the header carries the opening of the
  // thought, so the block can be recognised without being reopened.
  const gist = document.querySelector(".think-h .arg");
  assert.match(gist?.textContent ?? "", /The user wants a diff/, "the settled header names it");

  // Reopening is one click, which is the whole reason it was collapsed rather
  // than deleted: a reader checking what the model reasoned is a real reader.
  const head = document.querySelector(".think-h") as unknown as {
    dispatchEvent: (e: unknown) => boolean;
  };
  head.dispatchEvent(new Event("click", { bubbles: true }));
  assert.ok(document.querySelector(".think.open"), "and it reopens");
});

test("the activity label says the model is reasoning, from the first thought", async () => {
  await boot();
  // Through the app's own table rather than a hardcoded English string: the
  // harness runs in whatever locale the environment reports, and an assertion
  // on one language would be an assertion about the harness.
  const { t } = (await import("../../src/i18n")) as { t: (k: string) => string };
  const frames = ask("take your time");
  clearCanvasTexts();

  // THE POINT OF THE WHOLE FEATURE, stated as an assertion. Before this, the
  // activity scene said the generic "thinking" from the moment send was
  // pressed and kept saying it for as long as the model reasoned, which is a
  // label the app was in no position to back up. It now changes on the first
  // thought token, because that is the first moment the app actually knows
  // what is happening.
  frames.push(delta({ reasoning_content: "Let me work through this." }));
  await waitFor(
    () => canvasTexts().some((s) => s.includes(t("px.reasoning"))),
    `the scene to say the model is reasoning, saw: ${canvasTexts().join(" | ")}`,
  );

  clearCanvasTexts();
  frames.push(delta({ content: "Here it is." }));
  await waitFor(() => answer().includes("Here it is"), "the answer to arrive");
  await waitFor(
    () => canvasTexts().some((s) => s.includes(t("px.responding"))),
    `the scene to move on to writing, saw: ${canvasTexts().join(" | ")}`,
  );

  frames.end();
  await settle(8);
});

test("a model that emits no reasoning leaves nothing behind", async () => {
  await boot();
  const before = blocks().length;
  const frames = ask("what time is it");

  // THE TRAP. Most models emit nothing on this channel, and a model that
  // reasoned on the previous turn emits nothing on this one. No block, no
  // heading, no frame that appears and then goes away.
  frames.push(delta({ content: "Half past four." }));
  await waitFor(() => answer().includes("Half past four"), "the answer to arrive");
  frames.end();
  await settle(8);

  assert.equal(blocks().length, before, "no new block was drawn for a turn that had no thoughts");
});

test("a reasoning channel that carries only whitespace draws nothing", async () => {
  await boot();
  const before = blocks().length;
  const beforeStored = storedReasoning();
  const frames = ask("and now");

  // A server flushing a newline on the channel and then saying nothing more
  // is not a model that reasoned. An empty bordered box under the answer is
  // exactly the stray element this feature must never produce, and the window
  // in which it would appear is this one, BEFORE anything else has arrived.
  frames.push(delta({ reasoning_content: "\n" }));
  frames.push(delta({ reasoning_content: "  " }));
  await settle(6);
  assert.equal(blocks().length, before, "whitespace draws no block while it streams");

  frames.push(delta({ content: "Still half past four." }));
  await waitFor(() => answer().includes("Still half past"), "the answer to arrive");
  frames.end();
  await settle(8);

  assert.equal(blocks().length, before, "and none is left behind once the turn ends");
  // The other half, and the one the screen cannot show: a block that renders
  // as nothing must not be WRITTEN either, or it comes back on every reload
  // and follows the conversation into its export and its search index.
  assert.equal(
    storedReasoning(),
    beforeStored,
    "nothing was persisted for a turn whose reasoning channel said nothing",
  );
});

test("a delimiter split across chunks never reaches the screen", async () => {
  await boot();
  const before = blocks().length;
  const frames = ask("think about it");

  // Some builds hand the channel back with its own tags, and a tag is streamed
  // like everything else. The OPENING one splitting is the nastier half: the
  // first chunk is "<thi", which is not readable, and a renderer that waited
  // for readable text before opening a block would then open one on the second
  // chunk and put "nk>weighing" on screen as text the model wrote.
  frames.push(delta({ reasoning_content: "<thi" }));
  await settle(4);
  assert.equal(blocks().length, before, "half a tag is not a thought, so no block yet");

  frames.push(delta({ reasoning_content: "nk>weighing two options" }));
  await waitFor(() => blocks().length > before, "the reasoning block to appear");
  assert.equal(thought(), "weighing two options", "and no fragment of the tag survived it");

  // The closing one, same treatment: "</t" must not flash for a frame.
  frames.push(delta({ reasoning_content: "</t" }));
  await settle(4);
  assert.equal(thought(), "weighing two options", "no half-written closing tag either");

  frames.push(delta({ reasoning_content: "hink>" }));
  frames.push(delta({ content: "Option B." }));
  await waitFor(() => answer().includes("Option B"), "the answer to arrive");
  frames.end();
  await settle(8);

  const shown = [...document.querySelectorAll(".think")].map((n) => n.textContent ?? "").join("");
  assert.ok(!shown.includes("<thi"), `raw markup reached the screen: ${shown}`);
  assert.ok(!shown.includes("</t"), `a fragment of a closing tag survived: ${shown}`);
});
