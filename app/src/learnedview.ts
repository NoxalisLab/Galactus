// Galactus, the panel for what the agent taught itself.
//
// Four things a user must be able to do with a memory that writes itself, and
// this screen is where all four live: see what is in it, read one in full,
// delete one or all of them, and turn the whole mechanism off.
//
// Two decisions are visible in the layout rather than only in the code.
//
// The origin of every entry is on the card, not buried in the file. A skill
// distilled from an app-mode conversation was produced under someone's eyes:
// that person answered the gate at each step as it happened. A skill distilled
// from an unattended run was watched by nobody. Those are different objects
// and the list says so, with the unattended one marked and, until it is
// approved, explicitly not in use.
//
// The folder is printed at the bottom. The thirty skills that ship with the
// app are somewhere else and stay somewhere else, and the fastest way to make
// that credible is to show the user the two paths are not the same.
//
// This module owns no rule. Everything it enforces it asks learned.ts for.

import { api } from "./api";
import { t } from "./i18n";
import { AUTHORED_MARKER, MAX_BANK, type AuthoredSkill } from "./learned";
import {
  approveLearned,
  deleteAllLearned,
  deleteLearned,
  learnedSkills,
  learningEnabled,
  quarantinedSkills,
  refreshBank,
  setLearningEnabled,
} from "./learnedbank";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

/** Body without the marker line, which the card already states in its own words. */
function bodyForDisplay(s: AuthoredSkill): string {
  return s.body.startsWith(AUTHORED_MARKER)
    ? s.body.slice(AUTHORED_MARKER.length).trim()
    : s.body;
}

function card(s: AuthoredSkill, repaint: () => void): HTMLElement {
  const pending = s.state !== "active";
  const c = el(`<div class="card learned ${pending ? "pending" : ""}">
    <div class="hd"><div class="grow">
      <b>${esc(s.slug)}</b>
      <span class="d">${esc(s.description || t("learned.noDescription"))}</span>
    </div></div>
    <div class="learned-tags">
      <span class="tag self">${esc(t("learned.tagSelf"))}</span>
      <span class="tag ${s.origin === "run" ? "warn" : ""}">${esc(
        s.origin === "run" ? t("learned.tagUnattended") : t("learned.tagAttended")
      )}</span>
      ${pending ? `<span class="tag warn">${esc(t("learned.tagPending"))}</span>` : ""}
      <span class="tag dim">${esc(s.created)}</span>
    </div>
    ${pending ? `<div class="learned-note">${esc(t("learned.pendingHint"))}</div>` : ""}
    <div class="set-actions">
      <button class="bs" data-read>${esc(t("learned.read"))}</button>
      ${pending ? `<button class="bs" data-approve>${esc(t("learned.approve"))}</button>` : ""}
      <button class="bs danger" data-del>${esc(pending ? t("learned.reject") : t("learned.delete"))}</button>
    </div>
    <pre class="learned-body" hidden></pre>
  </div>`);

  const pre = c.querySelector<HTMLElement>(".learned-body")!;
  // A pending entry opens READ. Accepting or rejecting is a decision about a
  // text, so the text is the thing that has to be in front of the person, not
  // one click behind a button they might not press.
  if (pending) {
    pre.textContent = bodyForDisplay(s);
    pre.hidden = false;
  }
  c.querySelector("[data-read]")!.addEventListener("click", () => {
    pre.hidden = !pre.hidden;
    if (!pre.hidden) pre.textContent = bodyForDisplay(s);
  });
  c.querySelector("[data-approve]")?.addEventListener("click", async () => {
    await approveLearned(s.slug);
    repaint();
  });
  c.querySelector("[data-del]")!.addEventListener("click", async () => {
    await deleteLearned(s.slug);
    repaint();
  });
  return c;
}

/**
 * The panel body, without any chrome, so it can be mounted either as a full
 * view (main.ts, once it adds a nav entry) or inside the overlay below.
 */
export function learnedPanel(): HTMLElement {
  const wrap = el(`<div class="hold">
    <div class="card">
      <div class="hd"><div class="grow">
        <b>${esc(t("learned.switchTitle"))}</b>
        <span class="d">${esc(t("learned.switchDesc"))}</span>
      </div><div class="tgl sm" id="lswitch"><div class="k"></div></div></div>
      <div class="learned-note">${esc(t("learned.switchHint"))}</div>
    </div>
    <div id="lbody"></div>
    <div class="card">
      <div class="hd"><div class="grow">
        <b>${esc(t("learned.folderTitle"))}</b>
        <span class="d">${esc(t("learned.folderDesc"))}</span>
      </div></div>
      <div class="mono learned-path" id="lpath">…</div>
      <div class="set-actions"><button class="bs danger" id="lwipe">${esc(t("learned.deleteAll"))}</button></div>
    </div>
  </div>`);

  const sw = wrap.querySelector<HTMLElement>("#lswitch")!;
  const body = wrap.querySelector<HTMLElement>("#lbody")!;

  const paint = (): void => {
    sw.classList.toggle("on", learningEnabled());
    body.innerHTML = "";
    const rows = learnedSkills();
    const bad = quarantinedSkills();
    if (!rows.length && !bad.length) {
      body.appendChild(
        el(`<div class="card"><div class="empty-block small"><span>${esc(t("learned.empty"))}</span></div>
        <div class="learned-note">${esc(t("learned.emptyHint"))}</div></div>`)
      );
    }
    for (const s of rows) body.appendChild(card(s, repaint));
    for (const q of bad) {
      const c = el(`<div class="card learned pending">
        <div class="hd"><div class="grow"><b>${esc(q.slug)}</b>
        <span class="d">${esc(t("learned.quarantined").replace("%s", q.why))}</span></div></div>
        <div class="set-actions"><button class="bs" data-del>${esc(t("learned.delete"))}</button></div>
      </div>`);
      c.querySelector("[data-del]")!.addEventListener("click", async () => {
        await deleteLearned(q.slug);
        repaint();
      });
      body.appendChild(c);
    }
    const count = wrap.querySelector<HTMLElement>("#lcount");
    if (count) count.textContent = `${rows.length} / ${MAX_BANK}`;
  };

  const repaint = (): void => {
    void refreshBank().then(paint, paint);
  };

  sw.addEventListener("click", async () => {
    await setLearningEnabled(!learningEnabled());
    repaint();
  });
  wrap.querySelector("#lwipe")!.addEventListener("click", async () => {
    await deleteAllLearned();
    repaint();
  });
  api.learnedFolder().then(
    (p) => {
      wrap.querySelector<HTMLElement>("#lpath")!.textContent = p;
    },
    () => {}
  );
  repaint();
  return wrap;
}

/** Full-view form, for main.ts to mount next to the other views. */
export function learnedView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region>
      <span class="ttl">${esc(t("learned.title"))}</span>
      <span class="sub">${esc(t("learned.subtitle"))}</span>
    </div>
    <div class="page" id="lpage"></div>
  </div>`);
  wrap.querySelector<HTMLElement>("#lpage")!.appendChild(learnedPanel());
  return wrap;
}

/**
 * The same panel as a modal.
 *
 * It exists because main.ts belongs to another workstream this week and cannot
 * take a nav entry yet, and a feature that writes durable instructions with no
 * way to look at them would be worse than no feature. Opened with the shortcut
 * installed below. When main.ts gains the nav entry, `learnedView` is the
 * thing to mount and this can go.
 */
export function openLearnedSkills(): void {
  if (document.querySelector(".modal-bd.learned-modal")) return;
  const m = el(`<div class="modal-bd learned-modal"><div class="modal wide learned-sheet">
    <h3>${esc(t("learned.title"))}</h3>
    <div class="ps">${esc(t("learned.subtitle"))}</div>
    <div id="lhost"></div>
    <div class="acts"><button class="bs" data-close>${esc(t("common.close"))}</button></div>
  </div></div>`);
  m.querySelector<HTMLElement>("#lhost")!.appendChild(learnedPanel());
  const close = (): void => {
    m.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);
  m.querySelector("[data-close]")!.addEventListener("click", close);
  m.addEventListener("click", (e) => {
    if (e.target === m) close();
  });
  document.body.appendChild(m);
}
