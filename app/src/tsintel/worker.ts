// Galactus, the language service worker.
//
// Thin on purpose. It owns the 9 MB TypeScript parse and the workspace Map, and
// it does exactly three things: load the default libraries, keep one language
// service alive, and pass messages to `handle`. Every decision lives in
// protocol.ts and host.ts, where a test can reach it without a worker.
//
// This file must be reached as `new Worker(new URL("./worker.ts", import.meta.url),
// {type:"module"})`, which makes Vite emit it as a same-origin chunk. The app's
// CSP is `default-src 'self'` with no `worker-src`, so it falls back through
// child-src to 'self': the `blob:` worker several bundler recipes default to is
// blocked at runtime, silently, in the packaged app only.

import { WorkspaceHost, LIB_DIR, ts } from "./host.js";
import { handle, type Req, type Res } from "./protocol.js";

// The worker global, reached through `globalThis` rather than `self`. The app
// type-checks with the DOM lib, where `self` is a Window and `postMessage`
// wants a target origin; casting once here beats splitting the build into two
// lib configurations for one file.
const ctx = globalThis as unknown as {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (message: unknown) => void;
  fetch: (input: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
};

const host = new WorkspaceHost();
const svc = ts.createLanguageService(host, ts.createDocumentRegistry());

/** Read one bundled library file. Same origin, inside the app bundle: this is a
 *  read of a packaged asset, not a network call, and the app stays offline. */
async function readLib(name: string): Promise<string> {
  const res = await ctx.fetch(LIB_DIR + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

let libsReady: Promise<void> | null = null;

function ensureLibs(): Promise<void> {
  if (!libsReady) libsReady = host.loadLibs(readLib);
  return libsReady;
}

ctx.onmessage = async (e) => {
  const req = e.data as Req;
  let res: Res;
  try {
    // Libraries are loaded before the first request that could need them, and
    // only once. `init` is the expected trigger; the guard is here so that a
    // client that skips it still gets right answers rather than a program
    // where every global is undefined.
    if (!host.hasLibs()) await ensureLibs();
    res = handle(req, svc, host);
    // A synchronous read may have asked for a library outside the shipped
    // closure. Fetch it and answer again rather than returning a program built
    // on a hole.
    if (host.missedLibs.size) {
      const missed = [...host.missedLibs];
      host.missedLibs.clear();
      let got = false;
      for (const path of missed) {
        try {
          await host.loadLibs(readLib, path.slice(LIB_DIR.length));
          got = true;
        } catch {
          /* recorded again by the next miss; not worth a second failure */
        }
      }
      if (got) res = handle(req, svc, host);
    }
  } catch (err) {
    const id = typeof (req as { id?: unknown })?.id === "number" ? (req as { id: number }).id : -1;
    res = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  ctx.postMessage(res);
};
