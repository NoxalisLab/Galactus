// chatx.ts — extras chat "pro" : export markdown, recherche de conversations,
// pieces jointes, zone de depot (drag & drop) et statistiques de generation.
//
// Tout est pur / sans etat sauf wireDropZone (qui rend une fonction de
// desabonnement). Aucune capture de noeud DOM dans un callback longue duree :
// wireDropZone ne retient `el` que tant que l'appelant garde l'abonnement
// ouvert, et le desabonnement libere tout.
//
// ---------------------------------------------------------------------------
// POUR L'INTEGRATEUR — cle CSS attendue (variables existantes --acc / --card) :
//   .dropzone-active   appliquee sur l'element hote pendant un survol de drop
//                      (ex. bord 1px dashed var(--acc), fond var(--card))
//
// Cles i18n a ajouter dans i18n.ts (FR + EN) :
//   "chatx.exportAssistant"  en: "Galactus"      fr: "Galactus"
//   "chatx.exportTool"       en: "Tool"          fr: "Outil"
//   "chatx.exportError"      en: "Error"         fr: "Erreur"
//   "chatx.tokens"           en: "tokens"        fr: "tokens"
//   "chatx.tokPerSec"        en: "tok/s"         fr: "tok/s"
//   "chatx.context"          en: "context"       fr: "contexte"
// Cles existantes reutilisees : "chat.you", "chat.plan", "chat.running",
// "conv.untitled", "tool.read", "tool.write", "tool.list", "tool.run",
// "tool.remember", "tool.skill", "tool.doc", "tool.osearch", "tool.oread",
// "tool.owrite".
// ---------------------------------------------------------------------------

import { t, getLang } from "./i18n";
import type { Conversation, ConvMeta, ChatItem } from "./store";

// ================================================================ markdown export

/** Libelle localise d'un outil (meme table que le chat), repli sur le nom brut. */
function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: t("tool.read"),
    write_file: t("tool.write"),
    list_directory: t("tool.list"),
    run_command: t("tool.run"),
    remember: t("tool.remember"),
    use_skill: t("tool.skill"),
    read_document: t("tool.doc"),
    obsidian_search: t("tool.osearch"),
    obsidian_read: t("tool.oread"),
    obsidian_append: t("tool.owrite"),
    search_workspace: t("tool.searchWorkspace"),
    find_files: t("tool.findFiles"),
  };
  return map[name] ?? name;
}

/** Prefixe chaque ligne pour un bloc cite markdown, en tronquant les resultats longs. */
function quoted(text: string, maxChars = 600): string {
  let body = text.replace(/\r\n/g, "\n").trim();
  if (body.length > maxChars) body = body.slice(0, maxChars).trimEnd() + " …";
  if (body === "") return "";
  return body
    .split("\n")
    .map((line) => ("> " + line).trimEnd())
    .join("\n");
}

function localeOf(): string {
  return getLang() === "fr" ? "fr-FR" : "en-US";
}

function renderItem(it: ChatItem): string {
  switch (it.kind) {
    case "user":
      return `**${t("chat.you")}**\n\n${it.text.trim()}`;
    case "assistant":
      return `**${t("chatx.exportAssistant")}**\n\n${it.text.trim()}`;
    case "tool": {
      const head = `> **${t("chatx.exportTool")} — ${toolLabel(it.name)}**` + (it.arg ? ` \`${it.arg}\`` : "");
      const body = it.done ? quoted(it.result) : "> " + t("chat.running");
      return body ? head + "\n>\n" + body : head;
    }
    case "error":
      return `> **${t("chatx.exportError")}** — ${it.text.trim()}`;
    case "notice":
      return `*${it.text.trim()}*`;
    case "agent": {
      // A teammate's block: who, what it was asked, what it answered. The
      // teammate's own thread is exported in full further down the file.
      const head = `> **${t("chatx.exportAgent")} · ${it.name}**` + (it.role ? ` (${it.role})` : "");
      const ask = quoted(it.ask, 400);
      const ans = it.answer ? quoted(it.answer, 2000) : "> " + t("chat.running");
      return [head, ask, ans].filter((x) => x !== "").join("\n>\n");
    }
  }
}

/**
 * Rend une conversation complete en markdown : titre, date, tours
 * utilisateur/assistant, appels d'outils resumes en blocs cites, plan si
 * present. Sortie stable, prete a etre ecrite dans un .md.
 */
export function exportConversationMarkdown(conv: Conversation): string {
  const title = conv.title.trim() !== "" ? conv.title.trim() : t("conv.untitled");
  const date = new Date(conv.created > 0 ? conv.created : Date.now()).toLocaleString(localeOf(), {
    dateStyle: "long",
    timeStyle: "short",
  });

  const parts: string[] = [`# ${title}`, `*${date}*`];

  if (conv.plan.length > 0) {
    const steps = conv.plan
      .map((s) => `- [${s.status === "done" ? "x" : " "}] ${s.title}${s.status === "doing" ? " …" : ""}`)
      .join("\n");
    parts.push(`## ${t("chat.plan")}\n\n${steps}`);
  }

  parts.push("---");
  for (const it of conv.items) parts.push(renderItem(it));

  // The team's threads, in full. Exporting only the parent would drop exactly
  // the part the sub-agents did, which is what the user recruited them for.
  for (const sub of conv.team) {
    parts.push("---", `## ${t("chatx.exportAgent")} · ${sub.name}${sub.role ? ` (${sub.role})` : ""}`);
    if (sub.brief.trim() !== "") parts.push(`> ${sub.brief.trim().split("\n").join("\n> ")}`);
    if (sub.items.length === 0) parts.push(`*${t("chatx.exportEmptyAgent")}*`);
    for (const it of sub.items) parts.push(renderItem(it));
  }

  return parts.join("\n\n") + "\n";
}

// ================================================================ search

/** Minuscules + suppression des accents (NFD) pour comparaison tolerante. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Filtre les metadonnees par titre : insensible a la casse et aux accents,
 * mots de la requete acceptes dans n'importe quel ordre ("recette ete"
 * trouve "Idées d'été — recettes"). Requete vide = tout.
 */
export function searchConversations(metas: ConvMeta[], query: string): ConvMeta[] {
  const words = fold(query).split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return metas.slice();
  return metas.filter((m) => {
    const hay = fold(m.title);
    return words.every((w) => hay.includes(w));
  });
}

// ================================================================ attachments

export interface Attachment {
  name: string;
  path: string;
  kind: "image" | "document" | "text";
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "heic", "tiff", "gif", "webp"]);
const DOC_EXT = new Set(["pdf", "docx", "pptx", "xlsx", "rtf", "odt", "doc"]);

/** Deduit le type d'une piece jointe depuis l'extension, avec un nom lisible. */
export function attachmentFromPath(path: string): Attachment {
  const base = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const kind: Attachment["kind"] = IMAGE_EXT.has(ext) ? "image" : DOC_EXT.has(ext) ? "document" : "text";
  return { name: base, path, kind };
}

// ================================================================ drop zone

/** Extrait des chemins de fichiers d'un drop DOM (repli hors Tauri). */
function pathsFromDomDrop(ev: DragEvent): string[] {
  const out: string[] = [];
  const dt = ev.dataTransfer;
  if (!dt) return out;
  // Navigateur de dev : une liste file:// dans text/uri-list.
  try {
    const uris = dt.getData("text/uri-list");
    for (const line of uris.split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith("file://")) {
        try {
          out.push(decodeURIComponent(s.slice("file://".length)));
        } catch {
          out.push(s.slice("file://".length));
        }
      }
    }
  } catch {
    /* dataTransfer indisponible */
  }
  if (out.length > 0) return out;
  // Dernier recours : certains webviews exposent .path sur File.
  for (const f of Array.from(dt.files)) {
    const p = (f as File & { path?: string }).path;
    if (typeof p === "string" && p !== "") out.push(p);
  }
  return out;
}

/**
 * Installe le glisser-deposer de fichiers sur `el`.
 *
 * Utilise le drag & drop natif de Tauri quand il est disponible (import
 * dynamique de "@tauri-apps/api/webview" → getCurrentWebview().onDragDropEvent)
 * — le seul canal qui fournit de vrais chemins disque — avec repli sur les
 * evenements DOM dragover/drop. Ne casse rien si l'API n'existe pas.
 *
 * Rend une fonction de desabonnement ; l'appelant DOIT l'invoquer quand la
 * vue qui contient `el` est detruite (regle anti-noeud-DOM-perime).
 */
export function wireDropZone(el: HTMLElement, onFiles: (paths: string[]) => void): () => void {
  let disposed = false;
  let unlistenNative: (() => void) | null = null;

  const setActive = (on: boolean) => {
    if (!disposed) el.classList.toggle("dropzone-active", on);
  };

  // ---- repli DOM (toujours cable : inoffensif, et couvre le mode dev vite)
  const onDragOver = (ev: DragEvent) => {
    ev.preventDefault();
    setActive(true);
  };
  // dragleave bubbles from every child hovered: only deactivate when the
  // pointer really left the drop zone, or the highlight flickers constantly.
  const onDragLeave = (ev: DragEvent) => {
    const to = ev.relatedTarget as Node | null;
    if (to && el.contains(to)) return;
    setActive(false);
  };
  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setActive(false);
    if (disposed) return;
    const paths = pathsFromDomDrop(ev);
    if (paths.length > 0) onFiles(paths);
  };
  el.addEventListener("dragover", onDragOver);
  el.addEventListener("dragleave", onDragLeave);
  el.addEventListener("drop", onDrop);

  // ---- natif Tauri (asynchrone, best-effort)
  void (async () => {
    try {
      const mod = await import("@tauri-apps/api/webview");
      const unlisten = await mod.getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setActive(true);
        else if (p.type === "leave") setActive(false);
        else if (p.type === "drop") {
          setActive(false);
          if (p.paths.length > 0) onFiles(p.paths);
        }
      });
      if (disposed) unlisten();
      else unlistenNative = unlisten;
    } catch {
      /* API Tauri absente (navigateur pur) : le repli DOM suffit */
    }
  })();

  return () => {
    if (disposed) return;
    disposed = true;
    el.removeEventListener("dragover", onDragOver);
    el.removeEventListener("dragleave", onDragLeave);
    el.removeEventListener("drop", onDrop);
    el.classList.remove("dropzone-active");
    if (unlistenNative) {
      unlistenNative();
      unlistenNative = null;
    }
  };
}

// ================================================================ stats

/** Nombre a une decimale max, separateur decimal selon la langue. */
function fmt1(n: number): string {
  const s = (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return getLang() === "fr" ? s.replace(".", ",") : s;
}

/** 3200 → "3,2k" (fr) / "3.2k" (en) ; 8000 → "8k" ; 512 → "512". */
function kFmt(n: number): string {
  if (n >= 1000) return fmt1(n / 1000) + "k";
  return String(Math.round(n));
}

/**
 * Ligne de statistiques de generation :
 *   "142 tokens · 12,4 tok/s · contexte 3,2k/8k"   (fr)
 *   "142 tokens · 12.4 tok/s · context 3.2k/8k"    (en)
 * La vitesse est omise si la duree est nulle, le contexte s'il est inconnu.
 */
export function formatStats(s: { tokens: number; ms: number; contextUsed?: number; contextMax?: number }): string {
  const parts: string[] = [`${Math.max(0, Math.round(s.tokens))} ${t("chatx.tokens")}`];
  if (s.ms > 0 && s.tokens > 0) {
    parts.push(`${fmt1((s.tokens / s.ms) * 1000)} ${t("chatx.tokPerSec")}`);
  }
  if (typeof s.contextUsed === "number" && typeof s.contextMax === "number" && s.contextMax > 0) {
    parts.push(`${t("chatx.context")} ${kFmt(s.contextUsed)}/${kFmt(s.contextMax)}`);
  }
  return parts.join(" · ");
}
