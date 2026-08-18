// The decisions the preview pane makes before it renders anything.
//
// The rendering itself needs a webview and is checked by hand. These four
// answers do not, and each one is a place where a plausible-looking choice is
// wrong in a way nobody would notice until a layout lied to them.

// @ts-ignore Node's built-in runner, used without adding @types/node.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { affectsPreview, chooseEntry, frameScale } from "../../src/code/preview-pane.js";

test("a device frame is scaled down to fit, and never up", () => {
  // Scaling up would show a 375px mobile layout at desktop size, which is a
  // picture of nothing: the media queries answered for 375 either way.
  assert.equal(frameScale(390, 800), 1, "it already fits");
  // 390 device, 24 of padding: 219 of pane leaves exactly half the width.
  assert.equal(frameScale(390, 219), 0.5, "half the room, half the size");
  assert.ok(frameScale(768, 300) < 1);
});

test("a pane too narrow to hold anything does not divide by zero", () => {
  assert.equal(frameScale(390, 0), 1);
  assert.equal(frameScale(390, 24), 1, "no room left after the padding");
});

test("the page being edited wins over index.html", () => {
  // Someone editing about.html is looking at about.html. Rendering index
  // instead would answer a question they did not ask.
  assert.equal(chooseEntry("about.html", ["index.html", "about.html"]), "about.html");
  assert.equal(chooseEntry("styles.css", ["index.html"]), "index.html", "css is not a page");
  assert.equal(chooseEntry(null, ["index.html"]), "index.html");
});

test("a folder with no page at all yields nothing to preview", () => {
  // Rather than an empty frame, which reads as a broken page rather than as an
  // absent one.
  assert.equal(chooseEntry(null, ["main.rs", "Cargo.toml"]), null);
  assert.equal(chooseEntry("main.rs", []), null);
});

test("any other html is better than nothing", () => {
  assert.equal(chooseEntry(null, ["home.html", "notes.md"]), "home.html");
});

test("only files the page could load trigger a reload", () => {
  // A reload throws away the scroll position of the page being looked at. A
  // README changing is not worth that.
  for (const f of ["index.html", "css/app.css", "js/main.mjs", "img/logo.svg", "f.woff2"]) {
    assert.equal(affectsPreview(f), true, f);
  }
  for (const f of ["README.md", ".gitignore", "src/main.rs", "notes.txt"]) {
    assert.equal(affectsPreview(f), false, f);
  }
});
