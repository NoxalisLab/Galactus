// teams.ts, several models working as one team.
//
// A team preset maps ROLES to model ids: the orchestrator hands planning to the
// "planner", implementation to the "coder", and each teammate recruited for a
// role talks to the engine of its own model. Presets ship in the registry
// (scripts/models-registry.json, key `team_presets`) and the user can override
// or add some in the settings (`team_presets_user`, a JSON array of the same
// shape). `team_preset` names the active one; empty means teams are off and
// everything runs on the primary engine exactly as before.
//
// Roles are an open map. No role name is written in this file: planner and
// coder exist because the shipped data says so, and a "reviewer" added by the
// user works the same way without a line of code.
//
// A role may also name a CLOUD model ({"kind": "cloud", "provider", "model"}).
// Galactus promises local inference and network only when asked, so a cloud
// role is off until the user enables the provider and stores a key, runs
// through a local proxy the backend owns (the key never reaches this side),
// and every call is shown with its cost. An empty cloud model is "not chosen
// yet" and falls back to the primary like any unusable role.
//
// Pure on purpose, no Tauri import: the merge, the resolution and the routing
// are what decide which engine a request lands on, and they have their own
// suite in tools/teams.

import { redact } from "./redact.js";

/** A role played by a model behind a provider's API instead of on this Mac. */
export interface CloudTarget {
  kind: "cloud";
  provider: string;
  /** The provider's model slug ("anthropic/claude-…"). Empty: not chosen yet. */
  model: string;
}

/** What a role maps to: a local model id, or a cloud model. */
export type RoleTarget = string | CloudTarget;

export function isCloud(t: RoleTarget | undefined | null): t is CloudTarget {
  return typeof t === "object" && t !== null && t.kind === "cloud";
}

/** The engine id the backend knows a cloud model by: "cloud:openrouter/<slug>". */
export function cloudModelId(t: CloudTarget): string {
  return `cloud:${t.provider}/${t.model}`;
}

/** Whether an engine/model id names a cloud model. */
export function isCloudId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("cloud:");
}

/** The slug of a cloud id, "" for a local id. */
export function cloudSlug(id: string | null | undefined): string {
  if (!isCloudId(id)) return "";
  const rest = id!.slice("cloud:".length);
  const i = rest.indexOf("/");
  return i < 0 ? "" : rest.slice(i + 1);
}

/** The provider of a cloud id, "" for a local id. */
export function cloudProvider(id: string | null | undefined): string {
  if (!isCloudId(id)) return "";
  const rest = id!.slice("cloud:".length);
  const i = rest.indexOf("/");
  return i < 0 ? rest : rest.slice(0, i);
}

/** One team: which model plays which role. */
export interface TeamPreset {
  id: string;
  name: string;
  /** role -> local model id or cloud model. Keys are lowercase and trimmed. */
  roles: Record<string, RoleTarget>;
  note?: string;
  /** Where it came from, so the settings can offer "reset" only when it means something. */
  source: "shipped" | "user" | "override";
}

/** What the settings key holds. The source is derived, never stored. */
export type StoredPreset = Omit<TeamPreset, "source">;

/**
 * One running engine, as `engines_status` reports it.
 *
 * Normalised through `normalizeEngine`: the wire may be snake_case like
 * ServerStatus or camelCase, and a routing decision must not depend on which.
 */
export interface EngineInfo {
  /** A local model id, or "cloud:<provider>/<slug>" for a cloud proxy. */
  modelId: string;
  kind: "local" | "cloud";
  role: string;
  port: number;
  phase: string;
  primary: boolean;
  slots: number;
  ctxPerSlot: number;
  toolsOk: boolean | null;
  footprintBytes: number;
}

/** What resolution needs to know of one model. */
export interface TeamModel {
  id: string;
  name?: string;
  /** Installed, and model-policy.ts lets it execute on this Mac. */
  runnable: boolean;
}

/** What the footprint estimate needs to know of one model. */
export interface SizedModel {
  id: string;
  gguf_bytes?: number;
  non_expert_bytes?: number;
  expert_bytes_total?: number;
  dense?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A role key as it is compared everywhere: "Coder " and "coder" are one role. */
export function roleKey(role: string): string {
  return role.trim().toLowerCase();
}

/**
 * Presets from any JSON-ish source: an array, or a string holding one.
 *
 * An invalid entry is dropped, never repaired into something the user did not
 * write. An entry with no usable role is invalid: a team of nobody would be
 * offered as active and route nothing.
 */
export function parsePresets(raw: unknown): StoredPreset[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: StoredPreset[] = [];
  for (const e of v) {
    if (!isRecord(e)) continue;
    const id = str(e["id"]);
    if (!id || !isRecord(e["roles"])) continue;
    const roles: Record<string, RoleTarget> = {};
    for (const [k, m] of Object.entries(e["roles"] as Record<string, unknown>)) {
      if (!roleKey(k)) continue;
      const model = str(m);
      if (model) {
        roles[roleKey(k)] = model;
      } else if (isRecord(m) && m["kind"] === "cloud" && str(m["provider"])) {
        // The slug may be empty: a shipped cloud role waits for the user to
        // choose it, and dropping it would hide the role from the settings.
        roles[roleKey(k)] = {
          kind: "cloud",
          provider: str(m["provider"])!.toLowerCase(),
          model: typeof m["model"] === "string" ? (m["model"] as string).trim() : "",
        };
      }
    }
    if (Object.keys(roles).length === 0) continue;
    const note = str(e["note"]);
    out.push({ id, name: str(e["name"]) ?? id, roles, ...(note ? { note } : {}) });
  }
  return out;
}

/** The shipped presets, from the raw registry file (object or JSON text). */
export function presetsFromRegistry(registryRaw: unknown): StoredPreset[] {
  let v: unknown = registryRaw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return isRecord(v) ? parsePresets(v["team_presets"]) : [];
}

/**
 * Shipped presets overlaid by the user's.
 *
 * Same id: the user's version replaces the shipped one IN PLACE, so the list
 * keeps its order and "reset" can bring the original back. New ids follow, in
 * the order the user created them. Within the user's own list the last entry
 * of an id wins, which is what saving an edit appends.
 */
export function mergePresets(shipped: StoredPreset[], userRaw: unknown): TeamPreset[] {
  const user = new Map<string, StoredPreset>();
  for (const p of parsePresets(userRaw)) {
    user.delete(p.id);
    user.set(p.id, p);
  }
  const out: TeamPreset[] = [];
  const seen = new Set<string>();
  for (const s of shipped) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const o = user.get(s.id);
    out.push(o ? { ...o, source: "override" } : { ...s, source: "shipped" });
  }
  for (const [id, p] of user) if (!seen.has(id)) out.push({ ...p, source: "user" });
  return out;
}

/** What goes back into `team_presets_user`: the user's entries only, no source. */
export function serializeUserPresets(list: TeamPreset[]): string {
  const mine = list
    .filter((p) => p.source !== "shipped")
    .map(({ id, name, roles, note }) => ({ id, name, roles, ...(note ? { note } : {}) }));
  return JSON.stringify(mine);
}

/** The active preset, or null when teams are off or the id no longer exists. */
export function activePreset(presets: TeamPreset[], id: string | null | undefined): TeamPreset | null {
  const want = (id ?? "").trim();
  if (!want) return null;
  return presets.find((p) => p.id === want) ?? null;
}

/** A fresh id for a copy, never colliding with an existing one. */
export function copyId(presets: TeamPreset[], base: string): string {
  const stem = base.replace(/-copie(-\d+)?$/, "") + "-copie";
  if (!presets.some((p) => p.id === stem)) return stem;
  for (let i = 2; ; i++) if (!presets.some((p) => p.id === `${stem}-${i}`)) return `${stem}-${i}`;
}

/** A provider a cloud role can name. */
export interface CloudProvider {
  id: string;
  name: string;
  /**
   * The provider does not return what a call cost, so the daily cap needs a
   * price per model (USD per million tokens) to be enforced. OpenRouter
   * returns the cost of each call and needs none.
   */
  needsPrice: boolean;
  /**
   * The model offered when a role is switched to this provider. A suggestion
   * only: the catalogue is fetched from the provider on click, because any
   * list written here goes stale.
   */
  suggested: string;
}

export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  { id: "openrouter", name: "OpenRouter", needsPrice: false, suggested: "" },
  { id: "anthropic", name: "Anthropic", needsPrice: true, suggested: "claude-opus-5" },
  { id: "openai", name: "OpenAI", needsPrice: true, suggested: "" },
];

export function cloudProviderInfo(id: string): CloudProvider {
  return CLOUD_PROVIDERS.find((p) => p.id === id) ?? { id, name: id, needsPrice: true, suggested: "" };
}

/** USD per million tokens, [input, output], keyed "<provider>/<model>". */
export type PriceTable = Record<string, [number, number]>;

/** A price table from any JSON-ish source. Entries that are not two non-negative numbers are dropped. */
export function parsePrices(raw: unknown): PriceTable {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  const out: PriceTable = {};
  if (!isRecord(v)) return out;
  for (const [k, p] of Object.entries(v)) {
    if (!k.includes("/") || !Array.isArray(p) || p.length !== 2) continue;
    const [i, o] = p.map(Number);
    if (Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0) out[k] = [i, o];
  }
  return out;
}

/** Shipped prices (registry `cloud_prices`) under the user's (`cloud_prices_user`). */
export function mergePrices(registryRaw: unknown, userRaw: unknown): PriceTable {
  let reg: unknown = registryRaw;
  if (typeof reg === "string") {
    try {
      reg = JSON.parse(reg);
    } catch {
      reg = null;
    }
  }
  return { ...parsePrices(isRecord(reg) ? reg["cloud_prices"] : null), ...parsePrices(userRaw) };
}

/** The price of one cloud model, or null when none is known. */
export function priceFor(prices: PriceTable, provider: string, model: string): [number, number] | null {
  return prices[`${provider}/${model}`] ?? null;
}

/** What the user allowed for each cloud provider. The key itself never comes here. */
export interface CloudState {
  /** provider -> enabled in the settings. */
  enabled: Record<string, boolean>;
  /** provider -> a key is stored in the Keychain. */
  keyed: Record<string, boolean>;
  /** Shipped and user prices merged; required for a provider with needsPrice. */
  prices?: PriceTable;
}

export const NO_CLOUD: CloudState = { enabled: {}, keyed: {} };

/**
 * Why a cloud role cannot run right now, or null when it can.
 * One order everywhere: the resolution, the tool text and the settings agree.
 */
export function cloudBlock(
  t: CloudTarget,
  cloud: CloudState
): "cloud-unconfigured" | "cloud-disabled" | "cloud-no-key" | "cloud-no-price" | null {
  if (!t.model) return "cloud-unconfigured";
  if (!cloud.enabled[t.provider]) return "cloud-disabled";
  if (!cloud.keyed[t.provider]) return "cloud-no-key";
  if (cloudProviderInfo(t.provider).needsPrice && !priceFor(cloud.prices ?? {}, t.provider, t.model)) return "cloud-no-price";
  return null;
}

export type RoleResolution =
  /**
   * Run on `modelId`. `primary` when that is the model already serving the
   * app. `engine` says whether it runs here or leaves the Mac.
   */
  | { kind: "model"; modelId: string; primary: boolean; engine: "local" | "cloud" }
  /** Run on the primary model, and say why in one sentence. */
  | {
      kind: "primary";
      reason:
        | "no-role"
        | "disabled"
        | "unknown-role"
        | "unknown-model"
        | "not-runnable"
        | "cloud-unconfigured"
        | "cloud-disabled"
        | "cloud-no-key"
        | "cloud-no-price";
      sentence: string;
    };

/**
 * Which model a teammate recruited for `role` runs on.
 *
 * Never an error: every way this can fail lands on the primary model with a
 * sentence the tool result carries, because a spawn that fails over a model
 * choice is a team the orchestrator then has to rebuild by hand.
 */
export function resolveRole(
  preset: TeamPreset | null,
  role: string | null | undefined,
  models: TeamModel[],
  primaryModelId: string | null,
  cloud: CloudState = NO_CLOUD
): RoleResolution {
  const r = roleKey(role ?? "");
  if (!r) return { kind: "primary", reason: "no-role", sentence: "" };
  if (!preset) {
    return {
      kind: "primary",
      reason: "disabled",
      sentence: `No team preset is active, so this teammate runs on the current model.`,
    };
  }
  const target = preset.roles[r];
  if (isCloud(target)) {
    const where = `role "${r}"`;
    if (!target.model) {
      return {
        kind: "primary",
        reason: "cloud-unconfigured",
        sentence: `No ${target.provider} model is chosen for ${where}, so this teammate runs on the current model.`,
      };
    }
    if (!cloud.enabled[target.provider]) {
      return {
        kind: "primary",
        reason: "cloud-disabled",
        sentence: `${target.provider} is not enabled in the settings, so ${where} stays on this Mac and this teammate runs on the current model.`,
      };
    }
    if (!cloud.keyed[target.provider]) {
      return {
        kind: "primary",
        reason: "cloud-no-key",
        sentence: `No ${target.provider} API key is stored, so this teammate runs on the current model.`,
      };
    }
    if (cloudBlock(target, cloud) === "cloud-no-price") {
      // The backend refuses the same start with the same reason: without a
      // price the daily cap cannot be enforced for a provider that does not
      // report what a call cost.
      return {
        kind: "primary",
        reason: "cloud-no-price",
        sentence: `No price is set for ${target.provider}/${target.model} (Settings > Cloud), and the daily cap cannot be enforced without it, so this teammate runs on the current model.`,
      };
    }
    return { kind: "model", modelId: cloudModelId(target), primary: false, engine: "cloud" };
  }
  const modelId = target;
  if (!modelId) {
    const known = Object.keys(preset.roles).join(", ");
    return {
      kind: "primary",
      reason: "unknown-role",
      sentence: `The preset "${preset.name}" has no role "${r}" (roles: ${known}), so this teammate runs on the current model.`,
    };
  }
  if (primaryModelId && modelId === primaryModelId) return { kind: "model", modelId, primary: true, engine: "local" };
  const m = models.find((x) => x.id === modelId);
  if (!m) {
    return {
      kind: "primary",
      reason: "unknown-model",
      sentence: `The model "${modelId}" given for role "${r}" is not in the catalogue, so this teammate runs on the current model.`,
    };
  }
  if (!m.runnable) {
    return {
      kind: "primary",
      reason: "not-runnable",
      sentence: `${m.name ?? m.id}, given for role "${r}", is not installed or cannot run on this Mac, so this teammate runs on the current model.`,
    };
  }
  return { kind: "model", modelId, primary: false, engine: "local" };
}

/** One engine from the wire, whichever casing it arrived in. Null when unusable. */
export function normalizeEngine(raw: unknown): EngineInfo | null {
  if (!isRecord(raw)) return null;
  const pick = (snake: string, camel: string): unknown => (raw[camel] !== undefined ? raw[camel] : raw[snake]);
  const modelId = str(pick("model_id", "modelId"));
  const port = Number(raw["port"]);
  if (!modelId || !Number.isFinite(port) || port <= 0) return null;
  const tools = pick("tools_ok", "toolsOk");
  return {
    modelId,
    kind: raw["kind"] === "cloud" || isCloudId(modelId) ? "cloud" : "local",
    role: str(raw["role"]) ?? "",
    port,
    phase: str(raw["phase"]) ?? "starting",
    primary: raw["primary"] === true,
    slots: Math.max(1, Math.floor(Number(raw["slots"]) || 1)),
    ctxPerSlot: Math.max(0, Math.floor(Number(pick("ctx_per_slot", "ctxPerSlot")) || 0)),
    toolsOk: typeof tools === "boolean" ? tools : null,
    footprintBytes: Math.max(0, Number(pick("footprint_bytes", "footprintBytes")) || 0),
  };
}

/** The engine serving `modelId`, preferring one that is ready. */
export function engineFor(modelId: string | null | undefined, engines: EngineInfo[]): EngineInfo | null {
  if (!modelId) return null;
  const all = engines.filter((e) => e.modelId === modelId);
  return all.find((e) => e.phase === "ready") ?? all[0] ?? null;
}

/**
 * The port a request addressed to `modelId` goes to.
 *
 * Falls back to the primary port: a request with no model, or for a model no
 * engine serves, is a request for the model the app is running. That is also
 * what every call site did before teams existed, so it is the one answer that
 * can never route a conversation somewhere it has never been.
 */
export function portFor(modelId: string | null | undefined, engines: EngineInfo[], primaryPort: number): number {
  return engineFor(modelId, engines)?.port ?? primaryPort;
}

/** The engine ids a preset's roles run on: local model ids and cloud proxy ids. */
export function presetEngineIds(preset: TeamPreset | null): Set<string> {
  const out = new Set<string>();
  if (!preset) return out;
  for (const t of Object.values(preset.roles)) {
    if (isCloud(t)) {
      if (t.model) out.add(cloudModelId(t));
    } else {
      out.add(t);
    }
  }
  return out;
}

/**
 * The additional engines nothing should be holding any more.
 *
 * An extra engine is a whole model resident in memory (or a proxy that can
 * spend money), so it stays only while BOTH hold: the active preset still
 * names its model (`presetIds` null means teams are off), and a live thread
 * still runs on it. The primary is never stopped here: server_stop owns it.
 * `pending` protects an engine started for a spawn whose thread does not
 * exist yet.
 */
export function enginesToStop(
  engines: EngineInfo[],
  presetIds: Set<string> | null,
  inUse: Set<string>,
  pending: Set<string> = new Set()
): string[] {
  return engines
    .filter((e) => !e.primary && !pending.has(e.modelId))
    .filter((e) => !presetIds || !presetIds.has(e.modelId) || !inUse.has(e.modelId))
    .map((e) => e.modelId);
}

/**
 * Per-engine memory beyond the weights: KV cache and compute arena.
 *
 * An estimate, and labelled so everywhere it is shown. The backend plans the
 * real thing at start and refuses what does not fit; this only has to be close
 * enough to say "this team will not fit here" before anything is loaded.
 */
export const ENGINE_OVERHEAD_BYTES = 3_000_000_000;

export interface RoleFootprint {
  role: string;
  modelId: string;
  bytes: number;
  /** The experts stay on the SSD; only the rest is counted. */
  streamed: boolean;
  missing: boolean;
  /** Runs at a provider: zero bytes here, money there. */
  cloud?: boolean;
}

export interface PresetFootprint {
  bytes: number;
  budgetBytes: number | null;
  fits: boolean | null;
  roles: RoleFootprint[];
  /** Model ids the catalogue does not know. The estimate cannot include them. */
  missing: string[];
}

/**
 * Summed memory of a whole team, from registry sizes.
 *
 * A model used by two roles runs one engine and is counted once. Dense models
 * must hold all their weights. Expert models are placed resident smallest
 * first while the budget allows, and the rest are counted streamed (their
 * non-expert weights only): that is the order in which the backend can keep
 * the most models resident.
 */
export function presetFootprint(
  preset: TeamPreset,
  models: SizedModel[],
  budgetBytes: number | null
): PresetFootprint {
  // A cloud role holds nothing on this Mac: it is listed, at zero bytes.
  const byModel = new Map<string, string[]>();
  const cloudRoles: RoleFootprint[] = [];
  for (const [role, target] of Object.entries(preset.roles)) {
    if (isCloud(target)) {
      cloudRoles.push({ role, modelId: cloudModelId(target), bytes: 0, streamed: false, missing: false, cloud: true });
      continue;
    }
    byModel.set(target, [...(byModel.get(target) ?? []), role]);
  }
  const missing: string[] = [];
  const dense: { id: string; m: SizedModel }[] = [];
  const moe: { id: string; m: SizedModel }[] = [];
  for (const id of byModel.keys()) {
    const m = models.find((x) => x.id === id);
    if (!m) missing.push(id);
    else if (m.dense || !m.expert_bytes_total) dense.push({ id, m });
    else moe.push({ id, m });
  }
  moe.sort((a, b) => (a.m.gguf_bytes ?? 0) - (b.m.gguf_bytes ?? 0));
  const placed = new Map<string, { bytes: number; streamed: boolean }>();
  let total = 0;
  for (const { id, m } of dense) {
    const b = (m.gguf_bytes ?? m.non_expert_bytes ?? 0) + ENGINE_OVERHEAD_BYTES;
    placed.set(id, { bytes: b, streamed: false });
    total += b;
  }
  for (const { id, m } of moe) {
    const full = (m.gguf_bytes ?? 0) + ENGINE_OVERHEAD_BYTES;
    if (budgetBytes === null || total + full <= budgetBytes) {
      placed.set(id, { bytes: full, streamed: false });
      total += full;
    } else {
      const b = (m.non_expert_bytes ?? 0) + ENGINE_OVERHEAD_BYTES;
      placed.set(id, { bytes: b, streamed: true });
      total += b;
    }
  }
  const roles: RoleFootprint[] = [];
  for (const [id, rs] of byModel) {
    const p = placed.get(id);
    rs.forEach((role, i) =>
      roles.push({
        role,
        modelId: id,
        // Shared engine: the bytes belong to its first role only.
        bytes: p && i === 0 ? p.bytes : 0,
        streamed: p?.streamed ?? false,
        missing: !p,
      })
    );
  }
  roles.push(...cloudRoles);
  return {
    bytes: total,
    budgetBytes,
    fits: budgetBytes === null || missing.length ? null : total <= budgetBytes,
    roles,
    missing,
  };
}

/**
 * What the engines may hold together on this Mac.
 *
 * The smaller of the engine budget and Metal's working set: the backend never
 * oversubscribes the latter, so a team that only fits the former does not fit.
 */
export function teamBudget(hw: { engine_budget_bytes?: number; gpu_working_set_bytes?: number | null } | null): number | null {
  if (!hw || !hw.engine_budget_bytes) return null;
  const ws = hw.gpu_working_set_bytes;
  return ws && ws > 0 ? Math.min(hw.engine_budget_bytes, ws) : hw.engine_budget_bytes;
}

/**
 * The paragraph the spawn tool carries while a preset is active.
 *
 * In the tool the model reads, so the orchestrator knows whom to give which
 * work. The advice on what each role is for is generic: roles are data.
 */
export function teamToolText(
  preset: TeamPreset | null,
  nameOf: (id: string) => string,
  primaryModelId: string | null,
  cloud: CloudState = NO_CLOUD
): string {
  const usable = (t: CloudTarget) => cloudBlock(t, cloud) === null;
  if (!preset) return "";
  const rows: string[] = [];
  const cloudRoles: string[] = [];
  for (const [role, target] of Object.entries(preset.roles)) {
    if (isCloud(target)) {
      // Listed only when it can actually run: offering a role that falls back
      // teaches the model that the expert exists when it does not.
      if (!usable(target)) continue;
      rows.push(`${role} = ${target.model} (CLOUD, ${cloudProviderInfo(target.provider).name}, paid per call)`);
      cloudRoles.push(role);
    } else {
      rows.push(`${role} = ${nameOf(target)}${target === primaryModelId ? " (the model you run on)" : ""}`);
    }
  }
  const cloudAdvice = cloudRoles.length
    ? ` The ${cloudRoles.join(", ")} role runs in the cloud: the work you give it leaves this Mac and costs money. ` +
      "Give it only what the local team cannot do well (hard reasoning, an architecture decision, a task a local teammate already failed); " +
      "prefer the local roles for everything else."
    : "";
  return (
    ` A TEAM OF MODELS is active (${preset.name}): ${rows.join("; ")}. Pass team_role to put a teammate on that role's model. ` +
    "Give planning, design and review to the role meant for planning, and implementation to the role meant for writing code; " +
    "a teammate without team_role runs on your own model." +
    cloudAdvice
  );
}

/**
 * Mask secrets in what is about to be sent to a cloud model.
 *
 * The same redaction as a conversation export (redact.ts): a secret the agent
 * read on this Mac must not leave it just because a teammate is remote. Copies,
 * never mutates: the local history keeps what the user's files really say.
 */
export function redactMessages<M extends { content: unknown; tool_calls?: unknown }>(
  messages: M[]
): { messages: M[]; removed: number } {
  let removed = 0;
  const text = (v: string): string => {
    const r = redact(v);
    removed += r.removed;
    return r.removed ? r.text : v;
  };
  const out = messages.map((m) => {
    const before = removed;
    let next: M = m;
    // Plain text, or multipart content whose text parts are masked one by one
    // (an image part carries no text to mask and goes through untouched).
    if (typeof m.content === "string" && m.content) {
      next = { ...next, content: text(m.content) };
    } else if (Array.isArray(m.content)) {
      next = {
        ...next,
        content: m.content.map((part: unknown) =>
          isRecord(part) && part["type"] === "text" && typeof part["text"] === "string"
            ? { ...part, text: text(part["text"] as string) }
            : part
        ),
      };
    }
    // What the model itself wrote into a tool call is history too: a
    // write_file whose content holds a key would carry it to the provider on
    // every later turn.
    if (Array.isArray(m.tool_calls)) {
      next = {
        ...next,
        tool_calls: m.tool_calls.map((c: unknown) => {
          if (!isRecord(c) || !isRecord(c["function"])) return c;
          const fn = c["function"] as Record<string, unknown>;
          if (typeof fn["arguments"] !== "string") return c;
          return { ...c, function: { ...fn, arguments: redactArguments(fn["arguments"] as string, text) } };
        }),
      };
    }
    // Untouched messages keep their identity: nothing to copy, nothing to say.
    return removed === before ? m : next;
  });
  return { messages: out, removed };
}

/**
 * Mask a tool call's JSON arguments value by value, so the result is still
 * the JSON the provider expects. Arguments that do not parse are masked as
 * plain text, which is what they are.
 */
function redactArguments(args: string, text: (v: string) => string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return text(args);
  }
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = text(v);
      if (r !== v) changed = true;
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        // A key named like a secret ({"api_key": "…"}) is only recognised by
        // redact() with its name beside it, so the pair is checked as text.
        if (typeof x === "string") {
          const pair = text(`${k}=${x}`);
          if (pair !== `${k}=${x}`) {
            changed = true;
            o[k] = pair.startsWith(`${k}=`) ? pair.slice(k.length + 1) : pair;
            continue;
          }
        }
        o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  const out = walk(parsed);
  return changed ? JSON.stringify(out) : args;
}
