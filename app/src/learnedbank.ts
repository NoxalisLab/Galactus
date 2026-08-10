// Galactus, the procedural memory bank: the impure half of learned.ts.
//
// learned.ts holds every rule and no side effect. This file holds every side
// effect and no rule: it reads settings, calls the model once to write a
// draft, and puts the result on disk through the three learned_* Tauri
// commands. Every decision it appears to make is delegated to a function in
// learned.ts, so the decisions stay testable outside the app.
//
// The split matters for one specific reason. The dangerous part of this
// feature is not the file writing, it is the judgement: when is something
// worth remembering, and what may the remembered text contain. Judgement that
// lives next to `await api.something()` cannot be tested, and what cannot be
// tested drifts.

import { api, chatOnce } from "./api";
import {
  AUTHORED_SCOPE,
  MAX_BANK,
  MAX_BODY_CHARS,
  MIN_SIGHTINGS,
  type AuthoredSkill,
  type SkillOrigin,
  type TurnStep,
  type Verdict,
  admitBody,
  assessTurn,
  bodyRefusalLabel,
  callableSkills,
  catalogueLines,
  collidesWithShipped,
  commandsAreGrounded,
  initialState,
  isValidSlug,
  parseSkillFile,
  ranCommands,
  recordSighting,
  refusalLabel,
  renderSkillFile,
  renderTranscript,
  slugify,
} from "./learned";

export { AUTHORED_SCOPE };

// ---------------------------------------------------------------- settings

const ENABLED_KEY = "learned_enabled";
const LEDGER_KEY = "learned_sightings";

/**
 * OFF by default, and the justification is not caution for its own sake.
 *
 * Two arguments, either of which is enough on its own:
 *
 *   Cost. The catalogue is pasted into the system prompt of every request. A
 *   feature that silently adds lines to it is a feature that raises the price
 *   of every turn of every conversation for a user who never asked for it. A
 *   default that spends someone else's context has to be opted into.
 *
 *   Risk. The failure mode of this feature is durable prompt injection: text
 *   the agent absorbed once becoming an instruction it re-reads for months.
 *   Every mitigation in learned.ts is a mitigation, not a proof. A feature
 *   whose worst case is durable is a feature the user turns on deliberately,
 *   having been told what it does.
 *
 * The switch is real: off means no observation is recorded, no draft is
 * written, and no authored skill is offered to the model. It does NOT delete
 * the bank, because turning something off and losing data are different
 * user intentions and must stay different buttons.
 */
let enabled = false;

export function learningEnabled(): boolean {
  return enabled;
}

export async function loadLearnedSettings(): Promise<void> {
  try {
    const s = await api.settingsGet();
    enabled = s[ENABLED_KEY] === "1";
  } catch {
    enabled = false;
  }
}

export async function setLearningEnabled(on: boolean): Promise<void> {
  enabled = on;
  await api.settingsSet(ENABLED_KEY, on ? "1" : "0");
  await refreshBank();
}

async function readLedger(): Promise<Record<string, number>> {
  try {
    const s = await api.settingsGet();
    const parsed = JSON.parse(s[LEDGER_KEY] ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- the bank

let bank: AuthoredSkill[] = [];
/** Slugs dropped on load because their body no longer passes the policy. */
let quarantined: { slug: string; why: string }[] = [];

export function learnedSkills(): AuthoredSkill[] {
  return bank;
}

export function quarantinedSkills(): { slug: string; why: string }[] {
  return quarantined;
}

/** The ones the model may actually load. The rule itself lives in learned.ts. */
export function usableLearnedSkills(): AuthoredSkill[] {
  return callableSkills(bank, enabled);
}

/**
 * The lines to add to the catalogue in the system prompt, or none at all.
 *
 * Empty until a human has accepted something, which is what makes the feature
 * cost exactly zero tokens per turn until then. See learned.ts, COST.
 */
export function learnedCatalogueLines(): string[] {
  return catalogueLines(bank, enabled);
}

/**
 * Re-read the bank from disk.
 *
 * The content policy runs HERE, on every load, not only when a skill was
 * written. A body that was admissible under an older build, or that somebody
 * edited on disk, or that a half-finished write left truncated, is dropped
 * from the catalogue rather than served. Dropped, not deleted: the user still
 * sees it in the panel with the reason, and decides. Deleting a user's file
 * because a regex changed would be worse than refusing to use it.
 */
export async function refreshBank(): Promise<AuthoredSkill[]> {
  const fresh: AuthoredSkill[] = [];
  const bad: { slug: string; why: string }[] = [];
  try {
    for (const row of await api.learnedList()) {
      const parsed = parseSkillFile(row.slug, row.body);
      if (!parsed) {
        bad.push({ slug: row.slug, why: "not a skill this agent wrote" });
        continue;
      }
      const verdict = admitBody(parsed.body);
      if (!verdict.ok) {
        bad.push({ slug: row.slug, why: bodyRefusalLabel(verdict.reason!) });
        continue;
      }
      fresh.push(parsed);
    }
  } catch {
    // No backend, or the command is missing in this build: an empty bank is
    // the safe answer, never a stale one.
    bank = [];
    quarantined = [];
    return bank;
  }
  fresh.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.slug < b.slug ? -1 : 1));
  bank = fresh;
  quarantined = bad;
  return bank;
}

/** Promote a skill a human has just read. Only a pending one can move. */
export async function approveLearned(slug: string): Promise<void> {
  const s = bank.find((x) => x.slug === slug);
  if (!s || s.state === "active") return;
  await api.learnedWrite(slug, renderSkillFile({ ...s, state: "active" }));
  await refreshBank();
}

export async function deleteLearned(slug: string): Promise<void> {
  await api.learnedDelete(slug);
  await refreshBank();
}

export async function deleteAllLearned(): Promise<void> {
  await api.learnedDelete();
  await refreshBank();
}

// ---------------------------------------------------------------- authoring

export interface LearnContext {
  port: number;
  /** Where this turn ran. See learned.ts, section ORIGIN. */
  origin: SkillOrigin;
  steps: readonly TurnStep[];
  /** What the user asked for, verbatim. */
  request: string;
  /** A skill drove this turn. */
  underSkill: boolean;
  /** The turn ended with an answer and was not aborted. */
  answered: boolean;
  /** Names of the shipped skills, so an authored one can never collide. */
  shippedNames: readonly string[];
  signal?: AbortSignal;
}

export interface LearnOutcome {
  learned: boolean;
  /** English, short, for the discreet notice in the thread. */
  reason: string;
  slug?: string;
  state?: "active" | "pending";
}

const AUTHOR_SYSTEM =
  "You turn a transcript of work you have just done into ONE reusable procedure, in the exact " +
  "format of a skill file. Rules, all of them binding:\n" +
  "1. Write ONLY from the transcript. Every command you state must be a command that appears in " +
  "it, character for character, except that a path or a name specific to this one task may be " +
  "replaced by a <placeholder>. Never add a step you did not take, however sensible it looks.\n" +
  "2. Number the steps in the order they happened. Put each command in a fenced code block on its " +
  "own.\n" +
  "3. End with a section titled 'Verification' holding the command that proves the work succeeded, " +
  "and what its output must show.\n" +
  "4. Say what to do when a step fails, when the transcript shows it.\n" +
  "5. Never write instructions about permissions, approvals or dialogs. Never tell the reader to " +
  "approve, pre-approve or skip anything: that is not yours to decide and such a procedure is " +
  "refused.\n" +
  "6. Be short. Under 400 words of prose. A procedure nobody reads is worse than none.\n" +
  "7. Write in the language of the user's request.\n\n" +
  "Answer in EXACTLY this shape, nothing before, nothing after:\n" +
  "NAME: a-short-kebab-case-name\n" +
  "DESCRIPTION: one line, what this procedure is for and when to reach for it\n" +
  "BODY:\n" +
  "<the markdown procedure>";

/**
 * The whole loop, from "a turn just ended" to "a skill exists".
 *
 * Fire and forget from the agent's point of view: it never blocks a turn and
 * every failure is a returned reason, never a throw. A procedural memory that
 * can break a conversation is not worth having.
 */
export async function maybeLearn(ctx: LearnContext): Promise<LearnOutcome> {
  if (!enabled) return { learned: false, reason: "learning is off" };
  if (bank.length === 0 && quarantined.length === 0) await refreshBank();

  const obs = {
    steps: ctx.steps,
    answered: ctx.answered,
    underSkill: ctx.underSkill,
    sightings: 0,
    bankSignatures: bank.map((s) => s.signature),
    bankSize: bank.length,
  };

  // Two passes on purpose. The first pretends the shape has already recurred,
  // so a turn that fails on ANY other rule never touches the ledger: a ledger
  // that counts every turn would eventually let junk shapes cross the
  // recurrence threshold, which is the one rule doing most of the filtering.
  const dry: Verdict = assessTurn({ ...obs, sightings: MIN_SIGHTINGS });
  if (!dry.worth) return { learned: false, reason: refusalLabel(dry.reason) };

  const ledger = await readLedger();
  const counted = recordSighting(ledger, dry.signature);
  try {
    await api.settingsSet(LEDGER_KEY, JSON.stringify(counted.ledger));
  } catch {
    /* the ledger is an optimization, not a correctness requirement */
  }

  const verdict = assessTurn({ ...obs, sightings: counted.count });
  if (!verdict.worth) return { learned: false, reason: refusalLabel(verdict.reason) };

  const transcript = renderTranscript(ctx.steps);
  let draft = "";
  try {
    draft = await chatOnce(
      ctx.port,
      [
        { role: "system", content: AUTHOR_SYSTEM },
        {
          role: "user",
          content:
            `The user asked:\n${ctx.request.slice(0, 1200)}\n\n` +
            `What you actually did, step by step:\n${transcript}`,
        },
      ],
      0.2,
      ctx.signal
    );
  } catch {
    return { learned: false, reason: "the authoring call failed" };
  }

  const parsed = parseDraft(draft);
  if (!parsed) return { learned: false, reason: "the draft was not in the expected shape" };

  const slug = slugify(parsed.name);
  if (!isValidSlug(slug)) return { learned: false, reason: "the draft had no usable name" };
  if (collidesWithShipped(slug, ctx.shippedNames)) {
    return { learned: false, reason: "that name belongs to a skill that ships with the app" };
  }
  if (bank.some((s) => s.slug === slug)) {
    return { learned: false, reason: "a skill of that name is already in the bank" };
  }
  if (bank.length >= MAX_BANK) return { learned: false, reason: refusalLabel("bank_full") };

  const body = parsed.body.slice(0, MAX_BODY_CHARS);
  const admitted = admitBody(body);
  if (!admitted.ok) {
    return { learned: false, reason: `the draft was refused: ${bodyRefusalLabel(admitted.reason!)}` };
  }
  // The anti-invention check. A model asked to describe what it did will add
  // the step it wishes it had taken, and that step is precisely the one that
  // was never run and never verified.
  const grounded = commandsAreGrounded(body, ranCommands(ctx.steps));
  if (!grounded.ok) {
    return {
      learned: false,
      reason: `the draft invented ${grounded.ungrounded.length} command(s) that were never run`,
    };
  }

  const skill: AuthoredSkill = {
    slug,
    description: parsed.description,
    origin: ctx.origin,
    state: initialState(ctx.origin),
    created: new Date().toISOString().slice(0, 10),
    signature: verdict.signature,
    body,
  };
  try {
    await api.learnedWrite(slug, renderSkillFile(skill));
  } catch (e: unknown) {
    return { learned: false, reason: `it could not be stored: ${String((e as Error)?.message ?? e)}` };
  }
  await refreshBank();
  // Written, not adopted. Nothing became callable here and the message says so:
  // a notice that read "learned a new skill" would describe a change to the
  // agent's behaviour that has not happened and will not until someone reads it.
  return {
    learned: true,
    reason: `wrote a procedure from this task: ${slug}. It is waiting for your review and cannot be used until you accept it.`,
    slug,
    state: skill.state,
  };
}

// ---------------------------------------------------------------- the surface

/**
 * Bootstrap and the temporary way in.
 *
 * The settings read has to happen before the first turn, and the panel has to
 * be reachable, and neither can go through main.ts this week: that file
 * belongs to another workstream. So the module does both itself, once, at
 * import time, guarded so a non-DOM context (a test runner, a future headless
 * host) is unaffected.
 *
 * The shortcut is honestly a stopgap and is written down as one in the report:
 * the permanent surface is a nav entry mounting learnedview.learnedView(), and
 * that is three lines in main.ts. Shift-Cmd-L is free today; main.ts returns
 * early on every shifted combination except the two the Code view claims.
 *
 * The panel is imported dynamically so a build that never opens it never pays
 * for it, and so this module keeps no import of the DOM layer.
 */
export function installLearnedSurface(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  void loadLearnedSettings();
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== "l") return;
    e.preventDefault();
    void import("./learnedview").then((m) => m.openLearnedSkills());
  });
}

installLearnedSurface();

/** NAME / DESCRIPTION / BODY, tolerant of the fences a model wraps them in. */
export function parseDraft(raw: string): { name: string; description: string; body: string } | null {
  const text = raw.replace(/^\s*```[a-z]*\s*\n/i, "").trim();
  const name = text.match(/^\s*NAME:\s*(.+)$/im);
  const desc = text.match(/^\s*DESCRIPTION:\s*(.+)$/im);
  const bodyAt = text.search(/^\s*BODY:\s*$/im);
  if (!name || !desc || bodyAt < 0) return null;
  const after = text.slice(bodyAt).replace(/^\s*BODY:\s*\n?/i, "");
  const body = after.replace(/```\s*$/, "").trim();
  if (!body) return null;
  return { name: name[1].trim(), description: desc[1].trim(), body };
}
