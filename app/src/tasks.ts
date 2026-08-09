// tasks.ts, bascule de modele par tache (task-based model switching).
//
// Lit `task_personas` + `task_models` du registre (scripts/models-registry.json)
// et fournit a l'agent la persona (system prompt + temperature) et la liste
// ordonnee des modeles preferes pour chaque tache. La regle d'or : un
// rechargement de modele coute cher (pagination du pack depuis le SSD), donc
// on ne bascule QUE si le modele en cours n'est pas deja un des preferes.
//
// ---------------------------------------------------------------------------
// POUR L'INTEGRATEUR, classes CSS attendues (a definir dans styles.css avec
// les variables existantes --bg / --card / --acc / --grad) :
//   .task-bar          conteneur horizontal des puces de tache (dans le chat)
//   .task-chip         puce cliquable d'une tache (fond --card, bord arrondi)
//   .task-chip.active  puce de la tache courante (accent --acc ou --grad)
//   .task-chip .dot    pastille d'etat du modele (vert = deja charge,
//                      orange = bascule necessaire, gris = rien d'installe)
//   .task-switch-hint  bandeau discret "bascule vers <modele>…" pendant swap
//
// Cles i18n a ajouter dans i18n.ts (FR + EN) :
//   "task.title"       en: "Task"                    fr: "Tâche"
//   "task.switchTo"    en: "Switching model…"        fr: "Bascule du modèle…"
//   "task.keepModel"   en: "model already loaded"    fr: "modèle déjà chargé"
//   "task.noModel"     en: "no preferred model installed"
//                      fr: "aucun modèle préféré installé"
// (Les labels des taches elles-memes viennent du registre, label_fr/label_en,
//  ou des replis ci-dessous, PAS du dictionnaire i18n.)
// ---------------------------------------------------------------------------

import { getLang } from "./i18n";

export type TaskId = "general" | "code" | "scripting" | "writing" | "reasoning";

export interface TaskDef {
  id: TaskId;
  /** Label deja resolu dans la langue courante (getLang()). */
  label: string;
  /** System prompt de la persona, injecte tel quel par l'agent. */
  system: string;
  temp: number;
  /** Ids de modeles preferes, ordonnes du meilleur au moins bon. */
  models: string[];
}

const TASK_IDS: readonly TaskId[] = ["general", "code", "scripting", "writing", "reasoning"];

// ---------------------------------------------------------------- defaults
// Replis raisonnables si le registre est absent, incomplet ou malforme.
// Les deux langues sont conservees ici ; le label final est choisi au moment
// de loadTasks() selon la langue courante.

interface DefaultPersona {
  label_en: string;
  label_fr: string;
  temp: number;
  system: string;
}

const DEFAULTS: Record<TaskId, DefaultPersona> = {
  general: {
    label_en: "General",
    label_fr: "Général",
    temp: 0.7,
    system:
      "You are Galactus, a helpful assistant running fully locally on the user's Mac. Be concise, accurate and direct.",
  },
  code: {
    label_en: "Code",
    label_fr: "Code",
    temp: 0.2,
    system:
      "You are Galactus, an expert software engineer running fully locally. Write correct, idiomatic, well-structured code. Prefer minimal diffs and explain only what is non-obvious.",
  },
  scripting: {
    label_en: "Scripting",
    label_fr: "Scripts",
    temp: 0.3,
    system:
      "You are Galactus, a shell and automation expert running fully locally on macOS. Produce safe, portable scripts, state assumptions, and never run destructive commands without warning.",
  },
  writing: {
    label_en: "Writing",
    label_fr: "Rédaction",
    temp: 0.9,
    system:
      "You are Galactus, a skilled writer and editor running fully locally. Match the user's language and tone, favor clarity and rhythm, and avoid filler.",
  },
  reasoning: {
    label_en: "Reasoning",
    label_fr: "Raisonnement",
    temp: 0.5,
    system:
      "You are Galactus, a careful analytical assistant running fully locally. Think step by step, examine alternatives, quantify uncertainty, and state your conclusion plainly.",
  },
};

// ---------------------------------------------------------------- parsing

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asTemp(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2 ? v : null;
}

function asModelList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.length > 0 && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Construit les 5 TaskDef a partir du registre brut (objet deja parse ou
 * chaine JSON). Chaque champ manquant ou invalide retombe sur le repli,
 * le resultat contient TOUJOURS les 5 taches, dans un ordre stable.
 */
export function loadTasks(registryRaw: unknown): TaskDef[] {
  let root: unknown = registryRaw;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      root = null;
    }
  }
  const reg = isRecord(root) ? root : {};
  const personas = isRecord(reg["task_personas"]) ? (reg["task_personas"] as Record<string, unknown>) : {};
  const taskModels = isRecord(reg["task_models"]) ? (reg["task_models"] as Record<string, unknown>) : {};
  const lang = getLang();

  return TASK_IDS.map((id) => {
    const d = DEFAULTS[id];
    const p = isRecord(personas[id]) ? (personas[id] as Record<string, unknown>) : {};
    const labelEn = asString(p["label_en"]) ?? d.label_en;
    const labelFr = asString(p["label_fr"]) ?? d.label_fr;
    return {
      id,
      label: lang === "fr" ? labelFr : labelEn,
      system: asString(p["system"]) ?? d.system,
      temp: asTemp(p["temp"]) ?? d.temp,
      models: asModelList(taskModels[id]),
    };
  });
}

// ---------------------------------------------------------------- model pick

/**
 * Choisit le modele a utiliser pour une tache.
 *
 * - Si le modele deja en cours figure dans les preferes de la tache, on le
 *   garde (needsSwitch=false) : un basculement a froid (rechargement du pack
 *   depuis le SSD) coute cher, on ne recharge que si necessaire.
 * - Sinon, on rend le PREMIER modele prefere qui soit installe, avec
 *   needsSwitch=true (ou false s'il n'y a rien a charger car deja en cours).
 * - Si aucun prefere n'est installe : { modelId: null, needsSwitch: false },
 *   l'appelant garde le modele courant et n'applique que la persona.
 */
export function pickModelFor(
  task: TaskDef,
  installedIds: string[],
  runningId: string | null
): { modelId: string | null; needsSwitch: boolean } {
  // Le modele en cours est deja un des preferes : on ne touche a rien.
  if (runningId !== null && task.models.includes(runningId)) {
    return { modelId: runningId, needsSwitch: false };
  }
  const best = task.models.find((id) => installedIds.includes(id)) ?? null;
  if (best === null) return { modelId: null, needsSwitch: false };
  return { modelId: best, needsSwitch: best !== runningId };
}

// ---------------------------------------------------------------- persistence

const STORAGE_KEY = "galactus.task";

function isTaskId(v: unknown): v is TaskId {
  return typeof v === "string" && (TASK_IDS as readonly string[]).includes(v);
}

export function currentTask(): TaskId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTaskId(stored)) return stored;
  } catch {
    /* localStorage indisponible : repli silencieux */
  }
  return "general";
}

export function setCurrentTask(id: TaskId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* localStorage indisponible : la tache reste en memoire de session */
  }
}
