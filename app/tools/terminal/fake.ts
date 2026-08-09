// Fixtures for the integrated terminal tests.
//
// The fake host records every call rather than merely satisfying the types:
// half of what is worth asserting about the gate is not "did the write
// happen" but "was the dialog even raised", and only a recording fake can
// answer that.

import type {
  PtyOutputEvent,
  SpawnResult,
  TerminalHost,
  WriteOrigin,
} from "../../src/code/terminal.js";

export interface RecordedWrite {
  id: string;
  data: string;
  origin: WriteOrigin;
  gated: boolean;
}

export class FakeTerminalHost implements TerminalHost {
  readonly spawns: { cwd: string; cols: number; rows: number; owner: WriteOrigin }[] = [];
  readonly writes: RecordedWrite[] = [];
  readonly resizes: [string, number, number][] = [];
  readonly kills: string[] = [];
  /** Every command the shell permission dialog was raised for, in order. */
  readonly permissionAsks: string[] = [];

  /** What the dialog answers. Change it per test. */
  permissionAnswer: string | (() => string | Promise<string>) = "once";
  /** Make `spawn` fail, to exercise the error path. */
  spawnError: string | null = null;
  /** Clamp the backend applies, so the controller's trust in it can be tested. */
  resizeClamp: ((cols: number, rows: number) => [number, number]) | null = null;

  private listeners: ((ev: PtyOutputEvent) => void)[] = [];
  private seq = 0;

  async spawn(req: { cwd: string; cols: number; rows: number; owner: WriteOrigin }): Promise<SpawnResult> {
    if (this.spawnError) throw new Error(this.spawnError);
    this.spawns.push(req);
    this.seq++;
    return {
      id: `t${this.seq}`,
      cols: req.cols,
      rows: req.rows,
      shell: "/bin/zsh",
      cwd: req.cwd,
    };
  }

  async write(req: RecordedWrite): Promise<void> {
    this.writes.push({ ...req });
  }

  async resize(id: string, cols: number, rows: number): Promise<[number, number]> {
    this.resizes.push([id, cols, rows]);
    return this.resizeClamp ? this.resizeClamp(cols, rows) : [cols, rows];
  }

  async kill(id: string): Promise<void> {
    this.kills.push(id);
  }

  onOutput(cb: (ev: PtyOutputEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  async requestShellPermission(detail: string): Promise<string> {
    this.permissionAsks.push(detail);
    const a = this.permissionAnswer;
    return typeof a === "function" ? await a() : a;
  }

  /** Push output as if the pty had produced it. */
  emit(id: string, data: string): void {
    for (const l of [...this.listeners]) l({ id, data, done: false, exit_code: null });
  }

  /** End a session as if the child had exited. */
  emitExit(id: string, code: number | null): void {
    for (const l of [...this.listeners]) l({ id, data: "", done: true, exit_code: code });
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}
