// Galactus, automatic task detection and model hot-swap policy.
//
// Two honest truths shape this module:
//  1. Swapping the PERSONA (system prompt + temperature) is free and instant.
//  2. Swapping the MODEL is not: the arena must be rebuilt, which costs tens of
//     seconds. So we only ever propose/perform a model swap when the running
//     model genuinely does not cover the detected task, and we tell the user
//     what it will cost.
//
// Detection is local heuristics, no round trip, no latency. It errs towards
// "keep the current task" when the signal is weak, because a wrong swap is far
// more annoying than a missed one.

export type TaskId = "general" | "code" | "scripting" | "writing" | "reasoning";

export interface Detection {
  task: TaskId;
  confidence: number; // 0..1
  reason: string;     // short, shown in the UI when a swap is proposed
}

interface Signal {
  task: TaskId;
  weight: number;
  reason: string;
  re: RegExp;
}

// Accent- and case-insensitive matching: we normalise before testing.
function normalise(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const SIGNALS: Signal[] = [
  // ---- code ----
  { task: "code", weight: 3, reason: "bloc de code", re: /```[\s\S]*?```|```\w+/ },
  {
    task: "code",
    weight: 2.5,
    reason: "vocabulaire de programmation",
    // NB: c++ sits OUTSIDE the trailing \b, after "++" a word boundary only
    // exists if a word char follows, so "du c++." would never match inside.
    re: /\bc\+\+|\b(refactor(?:e|ise|ing)?|debug(?:ge|guer)?|compil(?:e|er|ation)|stack ?trace|traceback|exception|segfault|typescript|javascript|python|rust|golang|swift|kotlin|java\b|react|vue\b|angular|django|flask|fastapi|npm|cargo|webpack|vite|eslint|pytest|jest\b|unit test|tests? unitaires?)\b/,
  },
  {
    task: "code",
    // Strong: an explicit code artefact is asked for. Beats the generic
    // "write me ..." writing cue, which alone says nothing about the medium.
    weight: 3.5,
    reason: "artefact de code demande",
    re: /\b(?:ecris?|cree[rz]?|fais|genere[rz]?|write|create|generate|make|build)(?:[- ](?:moi|me))?\s+(?:une?|a|an|the|le|la|un)?\s*(?:fonction|function|classe|class|methode|method|composant|component|module|script python|programme|programm?e|requete sql|query|schema|interface|type)\b/,
  },
  {
    task: "code",
    weight: 2,
    reason: "demande d'implementation",
    re: /\b(implement(?:e|er|ation)?|code[rz]?\b|fix (?:the |this )?bug|corrige (?:le |ce )?bug|api\b|endpoint|regex|algorithme?|boucle|variable|parse[rz]?\b|parsing)\b/,
  },
  {
    task: "code",
    weight: 1.5,
    reason: "fichier source",
    re: /\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|c|cpp|h|hpp|rb|php|cs|scala|sql|vue|svelte)\b/,
  },

  // ---- scripting ----
  {
    task: "scripting",
    weight: 3,
    reason: "shell / automatisation",
    re: /\b(bash|zsh|shell|script ?shell|cron(?:tab)?|makefile|dockerfile|docker[- ]compose|ansible|terraform|homebrew|brew install|chmod|chown|rsync|ssh\b|awk\b|sed\b|grep\b|xargs)\b/,
  },
  {
    task: "scripting",
    weight: 2,
    reason: "automatisation demandee",
    re: /\b(automatise[rz]?|automate|batch|pipeline ci|ci\/cd|github actions|deploiement|deploy(?:ment)?|installe[rz]? (?:le|la|un|une)?|setup)\b/,
  },
  { task: "scripting", weight: 1.5, reason: "fichier de script", re: /\.(?:sh|bash|zsh|fish|ps1|bat|yml|yaml|toml|env)\b/ },

  // ---- writing ----
  {
    task: "writing",
    // Strong: a prose artefact is named explicitly.
    weight: 3,
    reason: "texte a produire",
    re: /\b(redige[rz]?|redaction|article|billet|blog|newsletter|communique|post (?:linkedin|twitter|x\b)|tweet|storytelling|pitch|argumentaire|lettre|courriel|mail\b|email\b|cv\b|discours|legende|slogan|paragraphe|chapitre)\b/,
  },
  {
    task: "writing",
    // Weak: "write me ..." says nothing about the medium on its own, a code
    // request phrased that way must not land here.
    weight: 1.2,
    reason: "demande de production",
    re: /\b(ecris?[- ]moi|write me|draft)\b/,
  },
  {
    task: "writing",
    weight: 2,
    reason: "travail sur le texte",
    re: /\b(reformule[rz]?|reecris?|rephrase|rewrite|corrige (?:l'?orthographe|le style|les fautes)|traduis?|translate|resume[rz]?(?: ce| le| la)?|summar(?:ise|ize)|synthetise[rz]?|ton\b|style d'?ecriture)\b/,
  },

  // ---- reasoning ----
  {
    task: "reasoning",
    weight: 3,
    reason: "analyse en profondeur",
    re: /\b(analyse[rz]?|compare[rz]?|evalue[rz]?|explique[rz]? pourquoi|raisonne|reflechis|demontre|prouve|justifie|arbitre|pour et contre|avantages? et inconvenients?|trade[- ]?offs?|strateg(?:ie|ique)|decision|hypothese)\b/,
  },
  {
    task: "reasoning",
    weight: 2,
    reason: "probleme a resoudre",
    re: /\b(pourquoi\b|why\b|comment se fait[- ]il|diagnosti(?:c|que[rz]?)|root cause|cause racine|enigme|probleme mathematique|calcule[rz]? (?:la|le)? ?(?:probabilite|complexite))\b/,
  },
];

/**
 * Detect the task from the user's message.
 * `previous` biases the result: a conversation that is already about code
 * stays about code unless another task speaks clearly louder.
 */
export function detectTask(text: string, previous: TaskId = "general"): Detection {
  const t = normalise(text);
  if (t.trim().length < 8) {
    return { task: previous, confidence: 0, reason: "message trop court" };
  }

  const scores: Record<TaskId, number> = {
    general: 0,
    code: 0,
    scripting: 0,
    writing: 0,
    reasoning: 0,
  };
  const reasons: Partial<Record<TaskId, string>> = {};

  for (const s of SIGNALS) {
    if (s.re.test(t)) {
      scores[s.task] += s.weight;
      if (!reasons[s.task]) reasons[s.task] = s.reason;
    }
  }

  // Continuity bonus: switching mid-conversation needs a clear margin.
  if (previous !== "general") scores[previous] += 1.2;

  let best: TaskId = "general";
  let bestScore = 0;
  let second = 0;
  for (const key of Object.keys(scores) as TaskId[]) {
    const v = scores[key];
    if (v > bestScore) {
      second = bestScore;
      bestScore = v;
      best = key;
    } else if (v > second) {
      second = v;
    }
  }

  if (bestScore < 2) {
    return { task: previous, confidence: 0.2, reason: "signal faible" };
  }
  // Confidence grows with the absolute score and the margin over the runner-up.
  const margin = bestScore - second;
  const confidence = Math.max(0, Math.min(1, (bestScore / 6) * 0.6 + (margin / 4) * 0.4));
  return { task: best, confidence, reason: reasons[best] ?? "mots-cles" };
}

export interface SwapPlan {
  /** Task the message was classified as. */
  task: TaskId;
  /** Model that should serve it, null when no change is called for. */
  modelId: string | null;
  /** True when the running model already covers the task, persona swap only. */
  personaOnly: boolean;
  /**
   * none     : the running model is the best installed choice, nothing to do.
   * required : the running model is not fit for this task at all, swap when
   *            confident (a reload the user will understand).
   * upgrade  : the running model works, but a better-ranked one is installed.
   *            Never automatic: a reload is too expensive to impose for a
   *            marginal quality gain. Offered, and only offered.
   */
  kind: "none" | "required" | "upgrade";
  confidence: number;
  reason: string;
}

/**
 * Decide what to do for a detected task.
 * `preferences` maps task -> ordered model ids (from the registry).
 * A model swap is only planned when the running model is NOT among the
 * preferred ones AND a preferred one is actually installed.
 */
export function planSwap(
  detection: Detection,
  preferences: Record<string, string[]>,
  installedIds: string[],
  runningId: string | null
): SwapPlan {
  const prefs = preferences[detection.task] ?? [];
  const base: SwapPlan = {
    task: detection.task,
    modelId: null,
    personaOnly: true,
    kind: "none",
    confidence: detection.confidence,
    reason: detection.reason,
  };
  if (prefs.length === 0) return base;

  const bestInstalled = prefs.find((id) => installedIds.includes(id)) ?? null;
  if (!bestInstalled) return base; // nothing preferred is installed: stay put

  const rank = runningId ? prefs.indexOf(runningId) : -1;

  // The running model is not fit for this task at all.
  if (rank === -1) {
    return bestInstalled === runningId
      ? base
      : { ...base, modelId: bestInstalled, personaOnly: false, kind: "required" };
  }

  // It is fit, is something strictly better installed?
  const betterIndex = prefs.findIndex((id, i) => i < rank && installedIds.includes(id));
  if (betterIndex >= 0) {
    return { ...base, modelId: prefs[betterIndex], personaOnly: false, kind: "upgrade" };
  }
  return base;
}

/**
 * May we swap without asking? Only for a REQUIRED swap, and only when the
 * detection is confident. An "upgrade" is always proposed, never imposed.
 */
export function mayAutoSwap(plan: SwapPlan, threshold = 0.55): boolean {
  return plan.kind === "required" && plan.confidence >= threshold;
}

// ---- persisted preference ----

export type AutoMode = "off" | "ask" | "auto";

export function getAutoMode(): AutoMode {
  try {
    const v = localStorage.getItem("galactus.autoswap");
    return v === "off" || v === "auto" ? v : "ask";
  } catch {
    return "ask";
  }
}

export function setAutoMode(m: AutoMode): void {
  try { localStorage.setItem("galactus.autoswap", m); } catch {}
}
