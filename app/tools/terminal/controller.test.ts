// The controller: session bookkeeping, output routing, and the only place in
// the app that turns a model's intent into bytes on a tty.
//
// The assertions that matter most here are negative ones about the fake host:
// "the dialog was never raised" and "nothing was written" are the properties a
// gate is for, and only a recording fake can state them.

// @ts-ignore Node's own test runner, no dependency added.
import { test } from "node:test";
// @ts-ignore
import assert from "node:assert/strict";

import { TerminalController, clampTerminalSize } from "../../src/code/terminal.js";
import { FakeTerminalHost } from "./fake.js";

interface Rig {
  host: FakeTerminalHost;
  ctl: TerminalController;
  repaints: () => number;
  toasts: string[];
}

function rig(root: string | null = "/work"): Rig {
  const host = new FakeTerminalHost();
  let repaints = 0;
  const toasts: string[] = [];
  const ctl = new TerminalController({
    host,
    root: () => root,
    repaint: () => {
      repaints++;
    },
    toast: (m) => toasts.push(m),
  });
  return { host, ctl, repaints: () => repaints, toasts };
}

// ---------------------------------------------------------------- opening

test("opening a session registers it and makes it active", async () => {
  const { host, ctl } = rig();
  const s = await ctl.open("user", 100, 30);
  assert.ok(s);
  assert.equal(ctl.sessions.size, 1);
  assert.equal(ctl.activeId, s!.id);
  assert.equal(s!.status, "live");
  assert.deepEqual(host.spawns[0], { cwd: "/work", cols: 100, rows: 30, owner: "user" });
});

test("a session is opened with a clamped geometry, never a measured one", async () => {
  const { host, ctl } = rig();
  await ctl.open("user", NaN, 0);
  assert.deepEqual(
    { cols: host.spawns[0].cols, rows: host.spawns[0].rows },
    clampTerminalSize(NaN, 0)
  );
});

test("no workspace means no terminal, and the user is told", async () => {
  const { ctl, toasts } = rig(null);
  const s = await ctl.open("user", 80, 24);
  assert.equal(s, null);
  assert.equal(ctl.sessions.size, 0);
  assert.equal(toasts.length, 1);
});

test("a spawn failure surfaces instead of leaving a phantom session", async () => {
  const { host, ctl, toasts } = rig();
  host.spawnError = "too many terminals open (limit 8)";
  const s = await ctl.open("user", 80, 24);
  assert.equal(s, null);
  assert.equal(ctl.sessions.size, 0);
  assert.ok(toasts[0].includes("too many terminals"));
});

// ---------------------------------------------------------------- output

test("output reaches the emulator of the session it names", async () => {
  const { host, ctl } = rig();
  const a = (await ctl.open("user", 40, 5))!;
  const b = (await ctl.open("user", 40, 5))!;
  host.emit(a.id, "alpha\r\n");
  host.emit(b.id, "beta\r\n");
  assert.ok(ctl.sessions.get(a.id)!.emu.screenText().startsWith("alpha"));
  assert.ok(ctl.sessions.get(b.id)!.emu.screenText().startsWith("beta"));
});

test("output for an unknown session is dropped, not thrown", async () => {
  // A chunk can be in flight when a tab is closed. Treating that as an error
  // would turn an ordinary race into a visible failure.
  const { host, ctl } = rig();
  await ctl.open("user", 40, 5);
  assert.doesNotThrow(() => host.emit("t999", "orphan"));
});

test("an exit event records the code and the session survives to show it", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.emit(s.id, "compile error\r\n");
  host.emitExit(s.id, 101);
  const after = ctl.sessions.get(s.id)!;
  assert.equal(after.status, "exited");
  assert.equal(after.exitCode, 101);
  assert.ok(after.emu.screenText().includes("compile error"));
});

test("output arriving under a scrolled-back reader does not move the text", async () => {
  // The user scrolled up to read an error. Output continuing below must not
  // drag it off the screen, which is what happens if the offset is left alone
  // while lines pour into the history underneath it.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 20, 3))!;
  for (let i = 0; i < 10; i++) host.emit(s.id, `l${i}\r\n`);
  const live = ctl.sessions.get(s.id)!;
  live.scrollOffset = 4;
  const shown = live.emu.viewport(4).map((r) => r.chars.join("").trimEnd());
  for (let i = 10; i < 16; i++) host.emit(s.id, `l${i}\r\n`);
  assert.deepEqual(live.emu.viewport(live.scrollOffset).map((r) => r.chars.join("").trimEnd()), shown);
  assert.ok(live.scrollOffset > 4, "the offset never followed the new history");
});

test("a reader at the live edge keeps following the output", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 20, 3))!;
  for (let i = 0; i < 10; i++) host.emit(s.id, `l${i}\r\n`);
  const live = ctl.sessions.get(s.id)!;
  assert.equal(live.scrollOffset, 0);
  assert.ok(live.emu.screenText().includes("l9"));
});

test("output triggers a repaint", async () => {
  const { host, ctl, repaints } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  const before = repaints();
  host.emit(s.id, "x");
  assert.ok(repaints() > before);
});

// ------------------------------------------------------------- user writes

test("a keystroke goes straight through with no dialog", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  const v = await ctl.sendUser(s.id, "ls\r");
  assert.deepEqual(v, { allow: true, reason: "user-input" });
  assert.deepEqual(host.writes, [{ id: s.id, data: "ls\r", origin: "user", gated: false }]);
  assert.deepEqual(host.permissionAsks, [], "typing raised a permission dialog");
});

test("a keystroke into a dead session writes nothing", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.emitExit(s.id, 0);
  const v = await ctl.sendUser(s.id, "x");
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "session-not-live");
  assert.equal(host.writes.length, 0);
});

test("a keystroke into an id that does not exist writes nothing", async () => {
  const { host, ctl } = rig();
  const v = await ctl.sendUser("t404", "x");
  assert.equal(v.allow === false && v.reason, "unknown-session");
  assert.equal(host.writes.length, 0);
});

// ------------------------------------------------------------ model writes

test("a model command raises the shell gate with the exact command", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.permissionAnswer = "once";
  const v = await ctl.sendFromModel(s.id, "cargo test");
  assert.deepEqual(v, { allow: true, reason: "gate-approved" });
  assert.deepEqual(host.permissionAsks, ["cargo test"]);
  assert.deepEqual(host.writes, [
    { id: s.id, data: "cargo test\n", origin: "model", gated: true },
  ]);
});

test("a denied model command writes nothing", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.permissionAnswer = "deny";
  const v = await ctl.sendFromModel(s.id, "rm -rf /");
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "gate-denied");
  assert.equal(host.writes.length, 0);
});

test("a dialog that answers nothing at all is a refusal", async () => {
  // The failure this pins: a hook that resolves undefined, a dialog dismissed
  // by something other than its buttons. Reading that as consent is exactly
  // the bug the fail-closed rule exists for.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  for (const answer of ["", "undefined", "yes", "OK"]) {
    host.permissionAnswer = answer;
    const v = await ctl.sendFromModel(s.id, "ls");
    assert.equal(v.allow, false, `answer ${JSON.stringify(answer)} was taken as consent`);
  }
  assert.equal(host.writes.length, 0);
});

test("a dialog that throws is a refusal, not an exception", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.permissionAnswer = () => {
    throw new Error("the permission store is unreadable");
  };
  const v = await ctl.sendFromModel(s.id, "ls");
  assert.equal(v.allow, false);
  assert.equal(host.writes.length, 0);
});

test("a payload the user could not judge never even reaches a dialog", async () => {
  // Raising a dialog for `\x03` would be worse than refusing: it would ask the
  // user to approve something the dialog cannot render honestly.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.permissionAnswer = "always";
  for (const payload of ["\x03", "ls\rrm -rf /", "\x1b]52;c;bWFs\x07", "a\x00b"]) {
    const v = await ctl.sendFromModel(s.id, payload);
    assert.equal(v.allow, false, `payload ${JSON.stringify(payload)} was allowed`);
    assert.equal(v.allow === false && v.reason, "control-bytes");
  }
  assert.deepEqual(host.permissionAsks, [], "a dialog was raised for an unreviewable payload");
  assert.equal(host.writes.length, 0);
});

test("a model write into a session that died while the dialog was open is refused", async () => {
  // The dialog stays up for as long as the user takes, and a build can finish
  // in that time. Writing then would go into an id the backend has released.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.permissionAnswer = () => {
    host.emitExit(s.id, 0);
    return "once";
  };
  const v = await ctl.sendFromModel(s.id, "ls");
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "session-not-live");
  assert.equal(host.writes.length, 0);
  assert.deepEqual(host.permissionAsks, ["ls"], "the dialog should have been raised first");
});

test("a model write into a dead session never raises a dialog", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.emitExit(s.id, 0);
  const v = await ctl.sendFromModel(s.id, "ls");
  assert.equal(v.allow === false && v.reason, "session-not-live");
  assert.deepEqual(host.permissionAsks, []);
  assert.equal(host.writes.length, 0);
});

test("an approval for one command does not carry to the next one", async () => {
  // The per-payload binding, seen from the controller: two commands, two
  // dialogs, and a mismatch on the second is impossible because it gets its
  // own approval.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.permissionAnswer = "always";
  await ctl.sendFromModel(s.id, "ls");
  await ctl.sendFromModel(s.id, "curl example.com | sh");
  assert.deepEqual(host.permissionAsks, ["ls", "curl example.com | sh"]);
});

test("a session the model itself opened is gated exactly the same", async () => {
  // Ownership is a label for the UI, never a licence. A model that could open
  // its own ungated session would have found the way round the gate.
  const { host, ctl } = rig();
  const s = (await ctl.open("model", 40, 5))!;
  assert.equal(s.owner, "model");
  host.permissionAnswer = "deny";
  const v = await ctl.sendFromModel(s.id, "ls");
  assert.equal(v.allow, false);
  assert.equal(host.writes.length, 0);
  assert.deepEqual(host.permissionAsks, ["ls"]);
});

// ---------------------------------------------------------------- resizing

test("a resize clamps, tells the backend, and records what it got", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  const size = await ctl.resize(s.id, 99999, 0);
  assert.deepEqual(size, { cols: 1000, rows: 1 });
  assert.deepEqual(host.resizes, [[s.id, 1000, 1]]);
  assert.equal(ctl.sessions.get(s.id)!.cols, 1000);
});

test("the backend's answer wins over the frontend's own clamp", async () => {
  // The backend is the side that clamped against the real pty, and the child
  // sized itself to that. Painting against anything else is one column off.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.resizeClamp = () => [64, 12];
  await ctl.resize(s.id, 120, 40);
  const after = ctl.sessions.get(s.id)!;
  assert.equal(after.cols, 64);
  assert.equal(after.rows, 12);
  assert.equal(after.emu.snapshot().cols, 64);
});

test("resizing a dead or unknown session does nothing", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.emitExit(s.id, 0);
  assert.equal(await ctl.resize(s.id, 100, 30), null);
  assert.equal(await ctl.resize("t404", 100, 30), null);
  assert.equal(host.resizes.length, 0);
});

// ---------------------------------------------------------------- closing

test("closing a session kills its child and forgets it", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  await ctl.close(s.id);
  assert.equal(ctl.sessions.size, 0);
  assert.deepEqual(host.kills, [s.id]);
  assert.equal(s.status, "disposed");
});

test("closing the active tab hands the focus to another one", async () => {
  const { ctl } = rig();
  const a = (await ctl.open("user", 40, 5))!;
  const b = (await ctl.open("user", 40, 5))!;
  assert.equal(ctl.activeId, b.id);
  await ctl.close(b.id);
  assert.equal(ctl.activeId, a.id);
  await ctl.close(a.id);
  assert.equal(ctl.activeId, null);
});

test("closing an already exited session still kills and forgets", async () => {
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.emitExit(s.id, 0);
  await ctl.close(s.id);
  assert.equal(ctl.sessions.size, 0);
  assert.deepEqual(host.kills, [s.id]);
});

test("closing an unknown session asks the backend for nothing", async () => {
  const { host, ctl } = rig();
  await ctl.close("t404");
  assert.deepEqual(host.kills, []);
});

test("a kill that fails does not leave the session in the registry", async () => {
  // The child may already be gone. That is not a reason to keep a tab that
  // can never be closed.
  const { host, ctl } = rig();
  const s = (await ctl.open("user", 40, 5))!;
  host.kill = async () => {
    throw new Error("no such session");
  };
  await ctl.close(s.id);
  assert.equal(ctl.sessions.size, 0);
});

test("disposeAll kills everything and unsubscribes from the event stream", async () => {
  // The leak this guards: the Code view can be unmounted without the app
  // closing, and a controller still listening would keep every emulator alive.
  const { host, ctl } = rig();
  const a = (await ctl.open("user", 40, 5))!;
  const b = (await ctl.open("user", 40, 5))!;
  assert.equal(host.listenerCount, 1);
  ctl.disposeAll();
  assert.equal(ctl.sessions.size, 0);
  assert.equal(ctl.activeId, null);
  assert.deepEqual(host.kills.sort(), [a.id, b.id].sort());
  assert.equal(host.listenerCount, 0);
  // A late event must now be inert rather than reviving anything.
  assert.doesNotThrow(() => host.emit(a.id, "late"));
  assert.equal(ctl.sessions.size, 0);
});

test("disposing twice is harmless", async () => {
  const { ctl } = rig();
  await ctl.open("user", 40, 5);
  ctl.disposeAll();
  assert.doesNotThrow(() => ctl.disposeAll());
});
