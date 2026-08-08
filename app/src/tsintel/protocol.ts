// Galactus, the worker protocol and the pure dispatcher behind it.
//
// Everything that crosses the worker boundary is declared here, and everything
// that answers a request is `handle`, which is a plain function: a request, a
// language service, a host, one response out. No `postMessage`, no DOM, no
// timers. That is deliberate. A language service driven through a worker is
// almost impossible to debug from a window; driven through `handle` it is nine
// lines of Node and a fixture directory.
//
// Only serialisable values cross. No `ts.*` object is ever posted: a Diagnostic
// carries a SourceFile, which carries the whole program, and structured clone
// would either fail or copy the world.

import type * as TS from "typescript";
import { lineColOf, lineTextOf, toPath, toRel, ts, type SnapshotStats } from "./host.js";

// ---------------------------------------------------------------- requests

export type ReqKind =
  | "init"
  | "setSnapshot"
  | "updateBuffer"
  | "hover"
  | "definition"
  | "references"
  | "completions"
  | "diagnostics"
  | "renameLocations";

export interface ReqBase {
  id: number;
  kind: ReqKind;
}

export interface InitReq extends ReqBase {
  kind: "init";
  root: string;
}
export interface SetSnapshotReq extends ReqBase {
  kind: "setSnapshot";
  files: Array<[string, string]>;
  truncated: boolean;
  totalBytes: number;
}
export interface UpdateBufferReq extends ReqBase {
  kind: "updateBuffer";
  rel: string;
  text: string;
}
export interface AtReq extends ReqBase {
  kind: "hover" | "definition" | "references" | "completions";
  rel: string;
  pos: number;
}
export interface DiagnosticsReq extends ReqBase {
  kind: "diagnostics";
  rel: string;
}
export interface RenameReq extends ReqBase {
  kind: "renameLocations";
  rel: string;
  pos: number;
  newName: string;
}

export type Req =
  | InitReq
  | SetSnapshotReq
  | UpdateBufferReq
  | AtReq
  | DiagnosticsReq
  | RenameReq;

// ---------------------------------------------------------------- values

/** A place in the workspace, in both the forms the app needs: the offset the
 *  editor selects with, and the line and column a file opens at. */
export interface Loc {
  rel: string;
  start: number;
  length: number;
  line: number;
  col: number;
}

export interface RefHit extends Loc {
  /** The whole source line, so the references list reads without opening
   *  anything. */
  text: string;
  isWrite: boolean;
  isDefinition: boolean;
}

export interface HoverInfo {
  /** The signature, already flattened out of ts display parts. */
  signature: string;
  docs: string;
  tags: string[];
  start: number;
  length: number;
}

export interface CompletionItem {
  name: string;
  kind: string;
  sortText: string;
  /** Set when the name is not what should be typed, e.g. a string member. */
  insertText?: string;
  /** True when accepting this needs an import; the app does not add it, and
   *  saying so is better than inserting a name that does not resolve. */
  hasAction: boolean;
  source?: string;
}

export type DiagCategory = "error" | "warning" | "info" | "hint";

export interface Diag {
  start: number;
  length: number;
  message: string;
  category: DiagCategory;
  code: number;
  /** "semantic" or "syntactic": a syntax error usually explains every semantic
   *  error under it, and the UI can say so. */
  origin: "semantic" | "syntactic";
}

export interface RenameHit {
  rel: string;
  start: number;
  length: number;
  /** Shorthand property renames need text on one side, e.g. `{ a }` becoming
   *  `{ a: b }`. Dropping these silently corrupts the file. */
  prefixText?: string;
  suffixText?: string;
}

export interface RenamePlan {
  canRename: boolean;
  reason: string;
  displayName: string;
  hits: RenameHit[];
}

export interface InitInfo {
  root: string;
  configPath: string | null;
  libFiles: number;
  libBytes: number;
  missingLibs: string[];
  snapshot: SnapshotStats;
  /** Wall time for the first `getProgram()`, which is what the tier gate
   *  actually cares about. */
  programMs: number;
}

export interface SnapshotInfo {
  snapshot: SnapshotStats;
  programMs: number;
}

export interface BufferInfo {
  rel: string;
  version: number;
}

// ---------------------------------------------------------------- responses

export type ResValue =
  | { kind: "init"; value: InitInfo }
  | { kind: "setSnapshot"; value: SnapshotInfo }
  | { kind: "updateBuffer"; value: BufferInfo }
  | { kind: "hover"; value: HoverInfo | null }
  | { kind: "definition"; value: Loc[] }
  | { kind: "references"; value: RefHit[] }
  | { kind: "completions"; value: CompletionItem[] }
  | { kind: "diagnostics"; value: Diag[] }
  | { kind: "renameLocations"; value: RenamePlan };

export type Res = ({ id: number; ok: true } & ResValue) | { id: number; ok: false; error: string };

// ---------------------------------------------------------------- host view

/**
 * What `handle` is allowed to know about the host. Narrow on purpose: the
 * dispatcher must not be able to reach a filesystem, a fetch or a worker even
 * by accident, because then it would stop being testable in nine lines.
 */
export interface HostCtx {
  root: string;
  setRoot(root: string): void;
  setSnapshot(files: Array<[string, string]>, truncated: boolean, totalBytes: number): void;
  updateBuffer(rel: string, text: string): number;
  text(rel: string): string | undefined;
  stats(): SnapshotStats;
  libStats(): { files: number; bytes: number };
  readonly missedLibs: Set<string>;
  readonly configPath: string | null;
}

// ---------------------------------------------------------------- helpers

const KINDS: ReadonlySet<string> = new Set<ReqKind>([
  "init",
  "setSnapshot",
  "updateBuffer",
  "hover",
  "definition",
  "references",
  "completions",
  "diagnostics",
  "renameLocations",
]);

function err(id: number, message: string): Res {
  return { id, ok: false, error: message };
}

function categoryOf(c: TS.DiagnosticCategory): DiagCategory {
  switch (c) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "hint";
    default:
      return "info";
  }
}

function locOf(ctx: HostCtx, fileName: string, start: number, length: number): Loc {
  const rel = toRel(fileName);
  const text = ctx.text(rel) ?? "";
  const { line, col } = lineColOf(text, start);
  return { rel, start, length, line, col };
}

/** Time one call, in whole milliseconds, without pulling in a clock the worker
 *  and Node do not share. */
function timed<T>(fn: () => T): [T, number] {
  const t0 = Date.now();
  const out = fn();
  return [out, Date.now() - t0];
}

// ---------------------------------------------------------------- dispatcher

/**
 * The whole language service surface, as one pure function.
 *
 * Never throws: a malformed request, an unknown kind and a crash inside the
 * service all come back as `{ok:false}`. A worker that dies on a bad message
 * takes the feature down for the session, and the message that killed it is
 * exactly the one nobody can reproduce.
 */
export function handle(req: Req, svc: TS.LanguageService, ctx: HostCtx): Res {
  const id = typeof (req as ReqBase)?.id === "number" ? (req as ReqBase).id : -1;
  try {
    if (!req || typeof req !== "object") return err(id, "malformed request: not an object");
    const kind = (req as ReqBase).kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      return err(id, `malformed request: unknown kind ${JSON.stringify(kind)}`);
    }
    if (typeof (req as ReqBase).id !== "number") {
      return err(id, "malformed request: id must be a number");
    }

    switch (req.kind) {
      case "init": {
        if (typeof req.root !== "string") return err(id, "init: root must be a string");
        ctx.setRoot(req.root);
        const [, programMs] = timed(() => svc.getProgram());
        const libs = ctx.libStats();
        return {
          id,
          ok: true,
          kind: "init",
          value: {
            root: req.root,
            configPath: ctx.configPath,
            libFiles: libs.files,
            libBytes: libs.bytes,
            missingLibs: [...ctx.missedLibs],
            snapshot: ctx.stats(),
            programMs,
          },
        };
      }

      case "setSnapshot": {
        if (!Array.isArray(req.files)) return err(id, "setSnapshot: files must be an array");
        for (const f of req.files) {
          if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== "string" || typeof f[1] !== "string") {
            return err(id, "setSnapshot: files must be [path, content] pairs");
          }
        }
        ctx.setSnapshot(req.files, !!req.truncated, Number(req.totalBytes) || 0);
        const [, programMs] = timed(() => svc.getProgram());
        return { id, ok: true, kind: "setSnapshot", value: { snapshot: ctx.stats(), programMs } };
      }

      case "updateBuffer": {
        if (typeof req.rel !== "string" || typeof req.text !== "string") {
          return err(id, "updateBuffer: rel and text must be strings");
        }
        const version = ctx.updateBuffer(req.rel, req.text);
        return { id, ok: true, kind: "updateBuffer", value: { rel: req.rel, version } };
      }

      case "hover": {
        const file = fileOf(req, ctx);
        if (typeof file !== "string") return err(id, file.error);
        const info = svc.getQuickInfoAtPosition(file, req.pos);
        if (!info) return { id, ok: true, kind: "hover", value: null };
        return {
          id,
          ok: true,
          kind: "hover",
          value: {
            signature: ts.displayPartsToString(info.displayParts),
            docs: ts.displayPartsToString(info.documentation),
            tags: (info.tags ?? []).map(
              (t) => `@${t.name} ${ts.displayPartsToString(t.text)}`.trim()
            ),
            start: info.textSpan.start,
            length: info.textSpan.length,
          },
        };
      }

      case "definition": {
        const file = fileOf(req, ctx);
        if (typeof file !== "string") return err(id, file.error);
        const defs = svc.getDefinitionAtPosition(file, req.pos) ?? [];
        return {
          id,
          ok: true,
          kind: "definition",
          value: defs.map((d) => locOf(ctx, d.fileName, d.textSpan.start, d.textSpan.length)),
        };
      }

      case "references": {
        const file = fileOf(req, ctx);
        if (typeof file !== "string") return err(id, file.error);
        // `findReferences` rather than `getReferencesAtPosition`: it is the one
        // that says which hit IS the declaration, and a references list that
        // cannot point at the definition is half a feature.
        const symbols = svc.findReferences(file, req.pos) ?? [];
        const value: RefHit[] = [];
        // Two symbols can claim the same span, typically an import alias and
        // the thing it aliases. One line in the list, not two.
        const seen = new Set<string>();
        for (const sym of symbols) {
          for (const h of sym.references) {
            if (seen.has(`${h.fileName}:${h.textSpan.start}`)) continue;
            seen.add(`${h.fileName}:${h.textSpan.start}`);
            const loc = locOf(ctx, h.fileName, h.textSpan.start, h.textSpan.length);
            const text = ctx.text(loc.rel) ?? "";
            value.push({
              ...loc,
              text: lineTextOf(text, h.textSpan.start),
              isWrite: !!h.isWriteAccess,
              isDefinition: !!h.isDefinition,
            });
          }
        }
        return { id, ok: true, kind: "references", value };
      }

      case "completions": {
        const file = fileOf(req, ctx);
        if (typeof file !== "string") return err(id, file.error);
        const out = svc.getCompletionsAtPosition(file, req.pos, {
          includeCompletionsForModuleExports: false,
          includeCompletionsWithInsertText: true,
        });
        return {
          id,
          ok: true,
          kind: "completions",
          value: (out?.entries ?? []).map((e) => ({
            name: e.name,
            kind: String(e.kind),
            sortText: e.sortText,
            insertText: e.insertText,
            hasAction: !!e.hasAction,
            source: e.source,
          })),
        };
      }

      case "diagnostics": {
        const file = fileOf(req, ctx);
        if (typeof file !== "string") return err(id, file.error);
        const out: Diag[] = [];
        // Syntactic first. When the parse is broken every semantic answer under
        // it is noise, and the caller can see which is which.
        for (const d of svc.getSyntacticDiagnostics(file)) out.push(toDiag(d, "syntactic"));
        for (const d of svc.getSemanticDiagnostics(file)) out.push(toDiag(d, "semantic"));
        return { id, ok: true, kind: "diagnostics", value: out };
      }

      case "renameLocations": {
        const file = fileOf(req, ctx);
        if (typeof file !== "string") return err(id, file.error);
        if (typeof req.newName !== "string" || !req.newName.trim()) {
          return err(id, "renameLocations: newName is empty");
        }
        const info = svc.getRenameInfo(file, req.pos, { allowRenameOfImportPath: false });
        if (!info.canRename) {
          return {
            id,
            ok: true,
            kind: "renameLocations",
            value: {
              canRename: false,
              reason: info.localizedErrorMessage ?? "this cannot be renamed",
              displayName: "",
              hits: [],
            },
          };
        }
        const locs =
          svc.findRenameLocations(file, req.pos, false, false, {
            providePrefixAndSuffixTextForRename: true,
          }) ?? [];
        return {
          id,
          ok: true,
          kind: "renameLocations",
          value: {
            canRename: true,
            reason: "",
            displayName: info.displayName,
            hits: locs.map((l) => ({
              rel: toRel(l.fileName),
              start: l.textSpan.start,
              length: l.textSpan.length,
              prefixText: l.prefixText,
              suffixText: l.suffixText,
            })),
          },
        };
      }
    }
  } catch (e) {
    return err(id, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}

function toDiag(d: TS.Diagnostic, origin: "semantic" | "syntactic"): Diag {
  return {
    start: d.start ?? 0,
    length: d.length ?? 0,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    category: categoryOf(d.category),
    code: d.code,
    origin,
  };
}

/** Validate the file of a positional request and turn it into a path the
 *  service knows. Returns the path, or the error to send back. */
function fileOf(
  req: { rel?: unknown; pos?: unknown; kind: ReqKind },
  ctx: HostCtx
): string | { error: string } {
  if (typeof req.rel !== "string" || !req.rel) {
    return { error: `${req.kind}: rel must be a non-empty string` };
  }
  if (req.kind !== "diagnostics" && (typeof req.pos !== "number" || !Number.isFinite(req.pos) || req.pos < 0)) {
    return { error: `${req.kind}: pos must be a non-negative number` };
  }
  if (ctx.text(req.rel) === undefined) {
    // The workspace snapshot is a photograph. A file the app knows and the
    // snapshot does not is the honest signal that it is out of date.
    return { error: `${req.kind}: ${req.rel} is not in the snapshot` };
  }
  return toPath(req.rel);
}
