// Galactus, the arithmetic of an update, with nothing else in it.
//
// The updater plugin does the network, the signature check and the unpacking.
// What it does NOT do is decide anything: it hands back a version string and a
// blob of notes, and every judgement made from those is ours. Those judgements
// are here, in a file that imports nothing, because each one has already got a
// shipped app wrong somewhere:
//
//  1. "Is this newer" is not "is this different". A string compare calls 0.1.10
//     older than 0.1.9, and an endpoint that is briefly serving the previous
//     release would offer users a downgrade that installs cleanly and looks
//     like an update.
//  2. A manifest is a file on a CDN. It can be truncated, half written, or the
//     wrong platform's. Reading it optimistically turns a bad upload into an
//     app that offers an update whose URL is the string "undefined".
//  3. Restarting is the only irreversible thing here, and this app can be
//     running scheduled jobs with nobody in front of it. The rule that stops
//     that is a function, not a comment, so it has a test.
//
// Nothing in this file touches the DOM, the Tauri bridge or the clock, so the
// test runner can load it directly. Everything that does live in main.ts.

// ---------------------------------------------------------------- target

/**
 * The one platform key Galactus ships.
 *
 * Tauri names macOS on Apple Silicon `darwin-aarch64`, and it also accepts
 * `darwin-universal` for a fat build. Galactus is aarch64 only (the engine is
 * Metal), so a manifest that carries only a universal entry is a manifest this
 * app cannot use, and saying that out loud beats installing nothing quietly.
 */
export const UPDATE_TARGET = "darwin-aarch64";

/** Accepted as a fallback: a universal build serves an aarch64 machine. */
export const UPDATE_TARGET_FALLBACK = "darwin-universal";

// ---------------------------------------------------------------- versions

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot separated identifiers after the first `-`, empty for a release. */
  prerelease: string[];
}

/**
 * Parse `X.Y.Z`, `X.Y.Z-tag.N`, tolerating a leading `v` and a `+build` suffix.
 *
 * Returns null rather than a zeroed version on garbage. A version that failed
 * to parse must never compare equal to 0.0.0, because 0.0.0 is older than
 * everything and would make every malformed manifest look like an update.
 */
export function parseVersion(raw: string): Version | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : [];
  // An empty identifier ("1.0.0-alpha..1") is not a version, it is a typo.
  if (pre.some((p) => p.length === 0)) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: pre,
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // Semver rule, and the one people forget: having a prerelease makes you
  // OLDER. 1.0.0-rc.1 precedes 1.0.0.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Order two versions: negative when `a` precedes `b`, zero when they are the
 * same release, positive when `a` follows `b`.
 *
 * Throws nothing and parses nothing it cannot: an unparsable side is reported
 * through `compareVersionsSafe`, which is what callers use.
 */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * True when `candidate` is strictly newer than `current`.
 *
 * False whenever either side is unreadable. The failure mode of guessing here
 * is an unwanted install, so an unreadable version is treated as "no update",
 * never as "probably fine".
 */
export function isNewer(current: string, candidate: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  if (!a || !b) return false;
  return compareVersions(a, b) < 0;
}

/** Human wording for what the two versions are to each other. */
export type VersionRelation = "newer" | "same" | "older" | "unreadable";

export function versionRelation(current: string, candidate: string): VersionRelation {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  if (!a || !b) return "unreadable";
  const d = compareVersions(a, b);
  if (d < 0) return "newer";
  if (d > 0) return "older";
  return "same";
}

// ---------------------------------------------------------------- manifest

export interface UpdatePlatform {
  /** Base64 minisign signature of the archive, as emitted by the Tauri CLI. */
  signature: string;
  url: string;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  /** RFC 3339. Tauri parses it; we only ever show it. */
  pub_date: string;
  platforms: Record<string, UpdatePlatform>;
}

export type ManifestResult =
  | { ok: true; manifest: UpdateManifest }
  | { ok: false; problems: string[] };

/**
 * Everything wrong with a candidate manifest, as a list.
 *
 * A list rather than a first error because this function is also the release
 * script's acceptance test: a person cutting a release wants every fault at
 * once, not the first one, then a rebuild, then the second one.
 */
export function manifestProblems(raw: unknown): string[] {
  const bad: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["not a JSON object"];
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.version !== "string" || o.version.trim() === "") {
    bad.push("version is missing or empty");
  } else if (!parseVersion(o.version)) {
    bad.push(`version is not a semantic version: ${o.version}`);
  }

  if (typeof o.notes !== "string" || o.notes.trim() === "") {
    // Not cosmetic. The notes are the only thing the person deciding whether
    // to restart a working machine gets to read.
    bad.push("notes are missing or empty");
  }

  if (typeof o.pub_date !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(o.pub_date)) {
    bad.push("pub_date is missing or is not an RFC 3339 timestamp");
  }

  const plats = o.platforms;
  if (typeof plats !== "object" || plats === null || Array.isArray(plats)) {
    bad.push("platforms is missing");
    return bad;
  }
  const keys = Object.keys(plats as Record<string, unknown>);
  if (keys.length === 0) bad.push("platforms is empty");
  for (const k of keys) {
    const p = (plats as Record<string, unknown>)[k];
    if (typeof p !== "object" || p === null) {
      bad.push(`platform ${k} is not an object`);
      continue;
    }
    const e = p as Record<string, unknown>;
    if (typeof e.signature !== "string" || e.signature.trim() === "") {
      bad.push(`platform ${k} has no signature`);
    }
    if (typeof e.url !== "string" || !/^https:\/\//.test(e.url)) {
      bad.push(`platform ${k} has no https url`);
    }
  }
  if (!keys.includes(UPDATE_TARGET) && !keys.includes(UPDATE_TARGET_FALLBACK)) {
    bad.push(`no entry for ${UPDATE_TARGET} or ${UPDATE_TARGET_FALLBACK}`);
  }
  return bad;
}

/** Parse and validate in one step. */
export function parseManifest(raw: unknown): ManifestResult {
  const problems = manifestProblems(raw);
  if (problems.length) return { ok: false, problems };
  return { ok: true, manifest: raw as UpdateManifest };
}

/** The entry this machine would actually download, or null. */
export function platformEntry(m: UpdateManifest): UpdatePlatform | null {
  return m.platforms[UPDATE_TARGET] ?? m.platforms[UPDATE_TARGET_FALLBACK] ?? null;
}

// ---------------------------------------------------------------- restart

/**
 * Why a check may or may not happen without anyone asking for one.
 *
 * Server mode is the whole reason this exists. A machine in server mode may be
 * running scheduled jobs with the window hidden behind a menu bar item, and a
 * launch check there would be a network call, a banner and an offer nobody is
 * present to read or decline.
 */
export interface AutoCheckContext {
  mode: "app" | "server";
  /** The stored preference. Defaults on, and only ever governs the CHECK. */
  enabled: boolean;
}

export function autoCheckAllowed(c: AutoCheckContext): boolean {
  if (!c.enabled) return false;
  return c.mode === "app";
}

export type RestartRefusal = "ok" | "not-user-initiated" | "jobs-in-flight";

export interface RestartContext {
  /**
   * True only when this came from a click on the install button. Every other
   * caller in the app passes false, and there is no other caller: this field
   * exists so that adding one later fails the test instead of failing a user.
   */
  userInitiated: boolean;
  /** Scheduled jobs running right now, from scheduler.rs `in_flight`. */
  jobsInFlight: number;
}

/**
 * The single rule that keeps an unattended Galactus from killing its own work.
 *
 * Restarting replaces the process, and the process is where the agent loop
 * that runs scheduled jobs lives. A run that is halfway through a task has
 * already written files and already spent tokens, and there is no resume: it
 * is simply gone. So a restart needs a human AND an idle scheduler, and when
 * the scheduler is busy the answer is no even to a human, who is told why and
 * can wait or stop the run.
 */
export function restartVerdict(c: RestartContext): RestartRefusal {
  if (!c.userInitiated) return "not-user-initiated";
  if (c.jobsInFlight > 0) return "jobs-in-flight";
  return "ok";
}

// ---------------------------------------------------------------- progress

export interface DownloadProgress {
  downloaded: number;
  /** Total from the Started event. Zero when the server sent no length. */
  total: number;
}

export function emptyProgress(): DownloadProgress {
  return { downloaded: 0, total: 0 };
}

/**
 * Fold one plugin event into the running total.
 *
 * The plugin reports CHUNK sizes, not a cumulative figure, and it reports the
 * total once, at the start. Treating a chunk as a cumulative byte count draws
 * a progress bar that flickers near zero for the whole download.
 */
export function applyChunk(p: DownloadProgress, chunkLength: number, contentLength?: number): DownloadProgress {
  const total = contentLength && contentLength > 0 ? contentLength : p.total;
  const add = Number.isFinite(chunkLength) && chunkLength > 0 ? chunkLength : 0;
  const downloaded = p.downloaded + add;
  return { downloaded: total > 0 ? Math.min(downloaded, total) : downloaded, total };
}

/** 0 to 100, or null when the server never said how big the archive is. */
export function progressPercent(p: DownloadProgress): number | null {
  if (p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.downloaded / p.total) * 100)));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  if (n < 1e6) return `${Math.round(n / 1e3)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

/**
 * The line under the bar. Falls back to a plain byte count when the total is
 * unknown, because a percentage invented from nothing is worse than none.
 */
export function downloadLabel(p: DownloadProgress): string {
  const pct = progressPercent(p);
  if (pct === null) return formatBytes(p.downloaded);
  return `${formatBytes(p.downloaded)} of ${formatBytes(p.total)} (${pct}%)`;
}

// ---------------------------------------------------------------- notes

/**
 * Turn a release body into something that fits in a settings row.
 *
 * The bodies are full markdown documents with a title, a paragraph of
 * positioning and then the actual changes. Everything up to and including the
 * first heading is dropped, headings are kept as their own line, and the
 * result is capped. Deliberately not a markdown renderer: this is a summary,
 * and the full text is one click away on the release page.
 */
export function summariseNotes(notes: string, maxChars = 900): string {
  if (typeof notes !== "string") return "";
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      // Keep the section name, drop the hashes.
      const text = line.replace(/^#{1,6}\s+/, "").trim();
      if (out.length === 0 && /^galactus/i.test(text)) continue;
      out.push(text);
      continue;
    }
    if (line.trim() === "") {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }
  while (out.length && out[0] === "") out.shift();
  let text = out.join("\n").trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).replace(/\s+\S*$/, "")}...`;
  }
  return text;
}
