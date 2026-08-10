// A DOM and a Tauri bridge, so a view function can be rendered and asserted on.
//
// THE GAP THIS CLOSES. runsview.ts and learnedview.ts build real DOM trees and
// were untested, not because their logic is hard to check but because Node has
// no `document` and no `window.__TAURI_INTERNALS__`, so the module graph could
// not even be imported. Every existing test in tools/ therefore stops at the
// last import-free module, and everything downstream of it, which is every
// screen the user actually looks at, was verified by nobody.
//
// WHY linkedom AND NOT jsdom. Both would work; the views do no layout, read no
// computed style and depend on no rendering, so the only question is cost.
//
//   linkedom  one package, no transitive dependencies, no native build,
//             about 1 MB installed, imports in a few milliseconds.
//   jsdom     roughly forty transitive packages, an optional native canvas,
//             a full CSS parser and a URL implementation, none of which any
//             assertion here would use.
//
// This repo ships two devDependencies. Adding forty to render a div is the
// wrong trade, and the faithfulness jsdom buys is faithfulness about things
// (layout, styles, navigation) that these modules never touch. If a future
// test genuinely needs getComputedStyle or a real event loop for focus, that
// is the moment to reconsider, and the swap is confined to this file.
//
// WHY THE TAURI STUB IS THE OFFICIAL ONE. @tauri-apps/api ships a documented
// hook: everything invoke() does is call window.__TAURI_INTERNALS__.invoke.
// Filling that in is the supported way to run a Tauri frontend outside a
// webview, so no module here is mocked, patched or replaced. api.ts is the
// real api.ts and the command names asserted below are the real command names,
// which is what makes a rename on the Rust side able to fail a test here.

import { parseHTML } from "linkedom";

/** One call that crossed the bridge, in order. */
export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** Answers a command. Throwing rejects the invoke, exactly as Rust's Err does. */
export type IpcRoute = (cmd: string, args: Record<string, unknown>) => unknown;

const calls: IpcCall[] = [];

let route: IpcRoute = (cmd) => {
  throw new Error(`no route for command ${cmd}`);
};

/** Everything the frontend has asked the backend for, oldest first. */
export function ipcCalls(): readonly IpcCall[] {
  return calls;
}

/** The calls for one command, so a test can assert on what was sent. */
export function ipcCallsFor(cmd: string): IpcCall[] {
  return calls.filter((c) => c.cmd === cmd);
}

export function clearIpcCalls(): void {
  calls.length = 0;
}

/** Install the answers. A command with no answer rejects, it does not return undefined. */
export function routeIpc(handler: IpcRoute): void {
  route = handler;
}

type Timer = { unref?: () => void };

/**
 * Timers that cannot hold the process open.
 *
 * runsView() arms a one second interval and persist() arms a 1.5 second
 * timeout. Node keeps running while either is pending, so an honest test would
 * hang for as long as the view is mounted. Unreferencing them keeps the
 * behaviour (they still fire while the test is awaiting something) and drops
 * the hold on the loop.
 */
function unreferenced<T extends (...args: never[]) => unknown>(fn: T): T {
  return ((...args: never[]) => {
    const handle = fn(...args) as Timer;
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }) as unknown as T;
}

const PAGE = '<!doctype html><html><body><div id="app"></div></body></html>';

/**
 * Set a global, even one Node exposes through a getter only.
 *
 * `navigator`, `crypto` and friends are accessor properties on Node's global,
 * so a plain assignment throws in strict mode. defineProperty replaces them
 * outright, which is what a DOM environment has to be able to do.
 */
function define(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * Put a document, a window and a Tauri bridge on the global object.
 *
 * Must run BEFORE the module under test is imported, because api.ts binds
 * invoke at import time and the view modules read `document` as a global. That
 * is why every test file here uses a dynamic import after calling this.
 */
export function installDom(): void {
  const view = parseHTML(PAGE) as unknown as Record<string, unknown>;
  const global = globalThis as unknown as Record<string, unknown>;
  const window = view.window as Record<string, unknown>;
  const document = view.document as Record<string, unknown>;

  for (const name of [
    "document",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Node",
    "Event",
    "CustomEvent",
    "DocumentFragment",
    "MutationObserver",
  ]) {
    if (view[name] !== undefined) define(global, name, view[name]);
  }
  define(global, "window", window);

  // linkedom has no keyboard or mouse constructors. The views only ever read
  // `key` and `target`, so a subclass of its Event is enough and stays honest:
  // nothing here pretends to model bubbling phases that are not exercised.
  class KeyboardEventShim extends (view.Event as new (type: string, init?: unknown) => object) {
    key: string;
    constructor(type: string, init: { key?: string; bubbles?: boolean } = {}) {
      super(type, init);
      this.key = init.key ?? "";
    }
  }
  define(global, "KeyboardEvent", KeyboardEventShim);
  define(window, "KeyboardEvent", KeyboardEventShim);

  const raf = unreferenced((cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0));
  const setTimeoutShim = unreferenced(setTimeout);
  const setIntervalShim = unreferenced(setInterval);

  for (const target of [global, window]) {
    define(target, "setTimeout", setTimeoutShim);
    define(target, "setInterval", setIntervalShim);
    define(target, "clearTimeout", clearTimeout);
    define(target, "clearInterval", clearInterval);
    define(target, "requestAnimationFrame", raf);
    define(target, "cancelAnimationFrame", clearTimeout);
    define(target, "CSS", { escape: (value: string) => value.replace(/["\\]/g, "\\$&") });
    define(target, "matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    define(target, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  }

  // A minimal storage: the app reads it for the language and the last view.
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  define(global, "localStorage", storage);
  define(window, "localStorage", storage);

  // paintList asks for it before deciding whether a caret has to be restored.
  document.hasFocus = () => false;

  // A canvas that hands out a 2D context.
  //
  // WHY THIS IS NEEDED TO TEST ANYTHING AT ALL. linkedom has no canvas, so
  // getContext("2d") returns null, and PixelViz throws "canvas 2d context
  // unavailable" the moment the app shell is drawn. boot() catches that,
  // toasts, and returns early, so everything AFTER the last render (syncTray,
  // maybeAutoCheck, the event subscriptions) silently never ran. The failure
  // was invisible: a rendered .layout with a boot that had quietly given up.
  //
  // The stub records nothing and draws nothing, which is right: no assertion
  // here is about pixels, and pretending to rasterise would be inventing a
  // fidelity nothing needs. It only has to exist and to answer the calls
  // pixel.ts and cosmos.ts actually make.
  const context2d: Record<string, unknown> = {
    canvas: null,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    measureText: () => ({ width: 0 }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  for (const name of [
    "arc",
    "beginPath",
    "clearRect",
    "fill",
    "fillRect",
    "fillText",
    "lineTo",
    "moveTo",
    "restore",
    "roundRect",
    "save",
    "setTransform",
    "stroke",
    "strokeRect",
    "translate",
  ]) {
    context2d[name] = () => {};
  }
  const canvasProto = (view.HTMLCanvasElement as { prototype?: Record<string, unknown> } | undefined)
    ?.prototype;
  if (canvasProto) {
    canvasProto.getContext = function getContext(this: unknown, kind: string) {
      // Only 2d. A module asking for webgl is asking for something this cannot
      // honestly provide, and null is the answer a browser without it gives.
      return kind === "2d" ? { ...context2d, canvas: this } : null;
    };
  }

  const internals = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args: args ?? {} });
      return route(cmd, args ?? {});
    },
    transformCallback: (callback: (value: unknown) => void) => {
      const id = Math.floor(Math.random() * 1e9);
      (globalThis as unknown as Record<number, unknown>)[id] = callback;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  };
  define(global, "__TAURI_INTERNALS__", internals);
  define(window, "__TAURI_INTERNALS__", internals);
  const eventInternals = { unregisterListener: () => {} };
  define(global, "__TAURI_EVENT_PLUGIN_INTERNALS__", eventInternals);
  define(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", eventInternals);
}

/**
 * Wait until `check` is true, or fail with `what` in the message.
 *
 * The views load their data asynchronously and repaint on an animation frame,
 * so a fixed sleep would either be flaky or slow. Polling with a deadline is
 * neither, and the failure message names the thing that never appeared instead
 * of a bare timeout.
 */
export async function waitFor(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let every pending microtask and zero delay timer run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The rendered page, for assertions that are about text rather than structure. */
export function body(): Record<string, unknown> {
  const document = (globalThis as unknown as Record<string, unknown>).document as Record<
    string,
    unknown
  >;
  return document.body as Record<string, unknown>;
}

/** Mount a view and return it, replacing whatever was on screen. */
export function mount(node: unknown): unknown {
  const page = body() as unknown as {
    innerHTML: string;
    appendChild: (n: unknown) => unknown;
  };
  page.innerHTML = "";
  page.appendChild(node);
  return node;
}
