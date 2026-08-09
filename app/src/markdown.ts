// Galactus, lightweight, safe markdown renderer for chat messages.
//
// Design notes:
//  - Everything is HTML-escaped FIRST, then markup is applied to the escaped
//    text. Markdown syntax characters survive escaping, so the output can
//    never contain injected tags.
//  - Streaming aware: an unterminated fence renders as an open code block
//    instead of leaking raw backticks while the model is still typing.
//  - Placeholders use Unicode private-use characters (no digits), so the
//    number/keyword passes cannot corrupt them.
//  - Zero dependencies.

export interface RenderOptions {
  /** While true, a trailing unclosed fence is rendered as an open block. */
  streaming?: boolean;
}

const PU_START = 0xe000; // private use area, one char per placeholder

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function placeholder(i: number): string {
  return String.fromCharCode(PU_START + i);
}

const PU_RE = new RegExp("[\\uE000-\\uEFFF]", "g");

function restore(s: string, slots: string[]): string {
  if (!slots.length) return s;
  return s.replace(PU_RE, (ch) => {
    const i = ch.charCodeAt(0) - PU_START;
    return i >= 0 && i < slots.length ? slots[i] : ch;
  });
}

// ---------------------------------------------------------------- highlight

interface LangSpec {
  kw: string[];
  comment: RegExp | null;
}

const LANGS: Record<string, LangSpec> = {
  js: {
    kw: "const let var function return if else for while class new extends import export from default async await try catch finally throw typeof instanceof this null undefined true false switch case break continue do delete in of yield static get set".split(" "),
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  },
  ts: {
    kw: "const let var function return if else for while class new extends implements interface type enum import export from default async await try catch finally throw typeof instanceof this null undefined true false switch case break continue readonly public private protected static as satisfies keyof infer never unknown any void".split(" "),
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  },
  python: {
    kw: "def class return if elif else for while import from as try except finally raise with lambda yield pass break continue and or not in is None True False global nonlocal assert async await del self".split(" "),
    comment: /#[^\n]*/g,
  },
  rust: {
    kw: "fn let mut const static struct enum impl trait for while loop if else match return use pub mod crate self super as where type unsafe async await move ref dyn in break continue true false Some None Ok Err".split(" "),
    comment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  },
  bash: {
    kw: "if then else elif fi for while do done case esac function return export local readonly source echo cd exit set unset trap".split(" "),
    comment: /#[^\n]*/g,
  },
  json: { kw: ["true", "false", "null"], comment: null },
  css: { kw: [], comment: /\/\*[\s\S]*?\*\//g },
  html: { kw: [], comment: /&lt;!--[\s\S]*?--&gt;/g },
};

const ALIAS: Record<string, string> = {
  javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
  typescript: "ts", tsx: "ts",
  py: "python", python3: "python",
  rs: "rust",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", console_: "bash",
  yml: "json", yaml: "json", jsonc: "json",
  c: "js", cpp: "js", "c++": "js", h: "js", hpp: "js",
  java: "js", go: "js", swift: "js", kotlin: "js", php: "js", scala: "js",
  xml: "html", svg: "html", vue: "html",
  scss: "css", less: "css",
};

const STRING_RE = /&quot;(?:[^&\\\n]|\\.|&(?!quot;))*?&quot;|&#39;(?:[^&\\\n]|\\.)*?&#39;|'(?:[^'\\\n]|\\.)*?'/g;
const NUMBER_RE = /\b(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?)\b/g;
const CALL_RE = /\b([A-Za-z_]\w*)(?=\s*\()/g;

/** Highlight ALREADY ESCAPED code. Strings/comments are stashed first. */
function highlight(escaped: string, lang: string): string {
  const spec = LANGS[ALIAS[lang] ?? lang];
  if (!spec) return escaped;

  const slots: string[] = [];
  const stash = (html: string): string => {
    slots.push(html);
    return placeholder(slots.length - 1);
  };

  let out = escaped;
  if (spec.comment) {
    out = out.replace(spec.comment, (m) => stash('<span class="c">' + m + "</span>"));
  }
  out = out.replace(STRING_RE, (m) => stash('<span class="s">' + m + "</span>"));
  if (spec.kw.length) {
    const kwRe = new RegExp("\\b(" + spec.kw.join("|") + ")\\b", "g");
    out = out.replace(kwRe, '<span class="k">$1</span>');
  }
  out = out.replace(CALL_RE, '<span class="f">$1</span>');
  out = out.replace(NUMBER_RE, (m) => '<span class="n">' + m + "</span>");
  return restore(out, slots);
}

// ---------------------------------------------------------------- inline

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (u.startsWith("/") || u.startsWith("./") || u.startsWith("#")) return u;
  return null; // blocks javascript:, data:, vbscript:
}

/** Inline markup on an already-escaped line. */
function inline(text: string): string {
  const slots: string[] = [];
  const stash = (html: string): string => {
    slots.push(html);
    return placeholder(slots.length - 1);
  };

  // inline code first, its contents are never interpreted
  let s = text.replace(/`([^`\n]+)`/g, (_m, c: string) => stash("<code>" + c + "</code>"));

  // explicit links
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m: string, label: string, url: string) => {
    const href = safeHref(url);
    return href
      ? stash('<a href="' + href + '" target="_blank" rel="noreferrer">' + label + "</a>")
      : m;
  });
  // bare urls
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) =>
    pre + stash('<a href="' + url + '" target="_blank" rel="noreferrer">' + url + "</a>")
  );

  // emphasis, bold before italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  return restore(s, slots);
}

// ---------------------------------------------------------------- blocks

function codeBlock(lang: string, body: string, open: boolean): string {
  const label = lang || "code";
  const escaped = esc(body);
  const highlighted = highlight(escaped, lang.toLowerCase());
  return (
    '<div class="cb' + (open ? " open-fence" : "") + '">' +
    '<div class="cb-h"><span class="cb-l">' + esc(label) + "</span>" +
    '<button class="cb-c" type="button" data-code="' + escaped + '">copy</button></div>' +
    "<pre><code>" + highlighted + "</code></pre></div>"
  );
}

function tableBlock(rows: string[]): string {
  const cells = (line: string): string[] =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return (
    '<div class="md-tw"><table class="md-t"><thead><tr>' +
    head.map((h) => "<th>" + inline(esc(h)) + "</th>").join("") +
    "</tr></thead><tbody>" +
    body.map((r) => "<tr>" + r.map((c) => "<td>" + inline(esc(c)) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table></div>"
  );
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+#.\-]*)[ \t]*$/;
const CLOSE_BACKTICK = /^[ \t]*`{3,}[ \t]*$/;
const CLOSE_TILDE = /^[ \t]*~{3,}[ \t]*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

/** Render markdown to safe HTML. */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  let listTag: "ul" | "ol" | null = null;
  const closeList = (): void => {
    if (listTag) {
      out.push("</" + listTag + ">");
      listTag = null;
    }
  };
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      out.push("<p>" + inline(esc(para.join("\n"))).replace(/\n/g, "<br>") + "</p>");
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(FENCE_RE);
    if (fence) {
      flushPara();
      closeList();
      const closeRe = fence[1][0] === "`" ? CLOSE_BACKTICK : CLOSE_TILDE;
      const lang = fence[2] || "";
      const buf: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (closeRe.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      out.push(codeBlock(lang, buf.join("\n"), !closed && opts.streaming === true));
      continue;
    }

    // table
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      closeList();
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      out.push(tableBlock(rows));
      continue;
    }

    // heading
    const h = line.match(/^[ \t]*(#{1,6})[ \t]+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push("<h" + lvl + ' class="md-h">' + inline(esc(h[2])) + "</h" + lvl + ">");
      i++;
      continue;
    }

    // horizontal rule
    if (/^[ \t]*(?:-[ \t]*){3,}$|^[ \t]*(?:\*[ \t]*){3,}$|^[ \t]*(?:_[ \t]*){3,}$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // blockquote
    if (/^[ \t]*>[ \t]?/.test(line)) {
      flushPara();
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^[ \t]*>[ \t]?/.test(lines[i])) {
        buf.push(lines[i].replace(/^[ \t]*>[ \t]?/, ""));
        i++;
      }
      out.push('<blockquote class="md-q">' + renderMarkdown(buf.join("\n"), opts) + "</blockquote>");
      continue;
    }

    // lists
    const ul = line.match(/^([ \t]*)[-*+][ \t]+(.*)$/);
    const ol = line.match(/^([ \t]*)(\d+)[.)][ \t]+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listTag !== want) {
        closeList();
        out.push("<" + want + ' class="md-l">');
        listTag = want;
      }
      const content = ul ? ul[2] : (ol as RegExpMatchArray)[3];
      const task = content.match(/^\[([ xX])\][ \t]+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === "x";
        out.push(
          '<li class="md-task"><span class="md-cbx' + (checked ? " on" : "") + '">' +
          (checked ? "✓" : "") + "</span>" + inline(esc(task[2])) + "</li>"
        );
      } else {
        out.push("<li>" + inline(esc(content)) + "</li>");
      }
      i++;
      continue;
    }

    if (/^[ \t]*$/.test(line)) {
      flushPara();
      closeList();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  closeList();
  return out.join("");
}

/**
 * Wire "copy" buttons inside a rendered container. Safe to call repeatedly:
 * one delegated listener per container.
 */
export function wireCodeCopy(container: HTMLElement, label = "copied"): void {
  const marked = container as HTMLElement & { __mdWired?: boolean };
  if (marked.__mdWired) return;
  marked.__mdWired = true;
  container.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(".cb-c") as HTMLElement | null;
    if (!btn) return;
    // dataset.code is ALREADY entity-decoded by the HTML parser, running it
    // through a textarea innerHTML would decode a second time and corrupt
    // code that legitimately contains &lt; &amp; sequences.
    const code = btn.dataset.code ?? "";
    if (btn.classList.contains("ok")) return; // double-click: keep the original label
    try {
      await navigator.clipboard.writeText(code);
      const prev = btn.textContent;
      btn.textContent = label;
      btn.classList.add("ok");
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove("ok");
      }, 1300);
    } catch {
      /* clipboard unavailable */
    }
  });
}
