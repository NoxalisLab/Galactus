// Resolve the app's extensionless relative imports under plain Node.
//
// WHY THIS FILE EXISTS, stated once so nobody rediscovers it the hard way.
//
// Every other test project in tools/ compiles with moduleResolution NodeNext,
// which is why every module they test writes `from "../../src/runs.js"`. The
// app's own sources do not: `src/runsview.ts` says `from "./api"`, because
// Vite resolves it and the app is built by Vite. NodeNext rejects that at
// COMPILE time (TS2835), so the view modules could never be added to one of
// those projects, and that is the real reason they were untested rather than
// any difficulty with the DOM.
//
// The fix is to compile the views the way the app compiles them (bundler
// resolution, extensionless imports preserved in the output) and to teach the
// Node that runs the output the one thing Vite knows and Node does not: when a
// relative specifier does not resolve, try it with `.js`, then as a directory
// index. That is the whole hook. It changes nothing else about module loading,
// it never touches bare specifiers, and it only fires on a path Node was about
// to fail on anyway.
//
// The alternative was rewriting the emitted files with a regex after tsc, or
// bundling with esbuild. Both put a transform between the source and what the
// test runs, and a transform is a place for a test to pass on code that is not
// the code that ships.
//
// Used as: node --import ./tools/dom/loader.mjs --test "tools/dom/out/**/*.test.js"
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      for (const suffix of [".js", "/index.js"]) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, format: "module", shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
