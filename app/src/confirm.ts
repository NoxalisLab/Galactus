/**
 * The app's modal dialogs: the confirmation, and the one-field prompt.
 *
 * WHY THEY LIVE HERE. Two of these existed already, private to code.ts, so
 * every other view had nothing to reach for. That is how three buttons ended up
 * deleting permanently on the first click with no question asked: everything
 * the app has learned, a run with its transcript, and a scheduled job.
 *
 * WHY NOT window.confirm. It blocks the whole webview, which in this app means
 * the engine's stream stops being read while the dialog is up.
 *
 * ACCESSIBILITY, which the older copies did not do. The dialog announces itself
 * as one, focus moves into it and is trapped while it is open, Escape resolves
 * it as a refusal rather than leaving the promise pending, and focus returns to
 * whatever the user was on. confirmModal in particular answered no key at all:
 * once it was up, a keyboard could not dismiss it.
 */

import { t } from "./i18n.js";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

let seq = 0;

/**
 * The shell every dialog here is built on: markup in, a settled answer out.
 *
 * `render` receives the ids the dialog must label itself with, and `settle` is
 * called once, by whichever of the exits happens first. Escape, the backdrop
 * and the cancel button all mean no, and all of them settle: a dialog removed
 * from the screen without settling leaves its caller waiting forever, with
 * everything after the await silently never happening.
 */
function modalShell<T>(opts: {
  render: (ids: { title: string; desc: string }) => string;
  cancelled: T;
  answer: (button: HTMLElement | null, root: HTMLElement) => T;
  focusFirst?: (root: HTMLElement) => HTMLElement | null | undefined;
}): Promise<T> {
  return new Promise((resolve) => {
    const ids = { title: `mdl-t-${++seq}`, desc: `mdl-d-${seq}` };
    const previous = document.activeElement as HTMLElement | null;
    const back = document.createElement("div");
    back.className = "modal-bd";
    back.innerHTML = opts.render(ids);

    let settled = false;
    const done = (value: T): void => {
      // Guarded because several paths lead here, and a Promise resolved twice
      // keeps its first answer silently, which hides a bug rather than showing
      // one.
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      // Returning focus matters: without it the user lands back at the top of
      // the document and tabs through the whole view again.
      previous?.focus?.();
      resolve(value);
    };

    const focusable = (): HTMLElement[] =>
      [...back.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]")].filter(
        (n) => !n.hasAttribute("disabled") && n.getAttribute("tabindex") !== "-1",
      );

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(opts.cancelled);
        return;
      }
      if (e.key !== "Tab") return;
      // The trap. Without it Tab walks out of the dialog and into the view
      // behind it, which is still there and still reachable to a screen reader.
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const here = document.activeElement;
      if (e.shiftKey && here === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && here === last) {
        e.preventDefault();
        first.focus();
      }
    }

    back.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest("[data-x]") as HTMLElement | null;
      if (btn) {
        done(opts.answer(btn, back));
        return;
      }
      // The backdrop itself, meaning a click outside the dialog. Same as
      // cancelling: an accidental click must never confirm anything.
      if (target === back) done(opts.cancelled);
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    (opts.focusFirst?.(back) ?? focusable()[0])?.focus?.();
  });
}

/**
 * Ask before doing something irreversible. True only on the explicit confirm.
 *
 * `danger` styles the confirm button as destructive and is the default, because
 * everything this currently guards destroys something.
 */
export function confirmDestructive(opts: {
  title: string;
  detail: string;
  confirmLabel: string;
  danger?: boolean;
  bodyHtml?: string;
}): Promise<boolean> {
  return modalShell<boolean>({
    render: (ids) => `<div class="modal${opts.bodyHtml ? " wide" : ""}" role="dialog" aria-modal="true"
        aria-labelledby="${ids.title}" aria-describedby="${ids.desc}">
      <h3 id="${ids.title}">${esc(opts.title)}</h3>
      <div class="ps" id="${ids.desc}">${esc(opts.detail)}</div>
      ${opts.bodyHtml ?? ""}
      <div class="acts">
        <button class="bs" data-x="0">${esc(t("conn.cancel"))}</button>
        <button class="${opts.danger === false ? "bp" : "bp danger"}" data-x="1">${esc(opts.confirmLabel)}</button>
      </div></div>`,
    cancelled: false,
    answer: (btn) => btn?.dataset.x === "1",
    // Cancel takes focus, not confirm: a stray Return must not delete.
    focusFirst: (root) => root.querySelector<HTMLElement>('[data-x="0"]'),
  });
}

/**
 * The same shell with one text field. Resolves null when cancelled, and when
 * the field was left empty, since an empty name is not an answer either.
 *
 * `bodyHtml` is inserted as given: the callers that pass it build it themselves
 * and are responsible for escaping what goes in.
 */
export function promptModal(
  title: string,
  sub: string,
  placeholder: string,
  initial = "",
): Promise<string | null> {
  return modalShell<string | null>({
    render: (ids) => `<div class="modal" role="dialog" aria-modal="true"
        aria-labelledby="${ids.title}" aria-describedby="${ids.desc}">
      <h3 id="${ids.title}">${esc(title)}</h3>
      <div class="ps" id="${ids.desc}">${esc(sub)}</div>
      <div class="cbox"><input id="${ids.title}-v" placeholder="${esc(placeholder)}"
        value="${esc(initial)}" autocomplete="off" spellcheck="false"/></div>
      <div class="acts">
        <button class="bs" data-x="0">${esc(t("conn.cancel"))}</button>
        <button class="bp" data-x="1">${esc(t("code.create"))}</button>
      </div></div>`,
    cancelled: null,
    answer: (btn, root) => {
      if (btn?.dataset.x !== "1") return null;
      return root.querySelector<HTMLInputElement>("input")!.value.trim() || null;
    },
    focusFirst: (root) => {
      const input = root.querySelector<HTMLInputElement>("input")!;
      // Return submits, as it did before this moved out of code.ts. Typing a
      // name and pressing Return is how every one of these is actually used;
      // Escape is handled by the shell, for every dialog rather than only the
      // ones whose field happens to hold the focus.
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        root.querySelector<HTMLElement>('[data-x="1"]')!.click();
      });
      return input;
    },
  });
}

/**
 * A confirmation carrying extra markup, kept for the Code view's dialogs that
 * show a file list. Same contract as confirmDestructive, different argument
 * order because eleven call sites already read this way.
 */
export function confirmModal(
  title: string,
  sub: string,
  bodyHtml: string,
  okLabel: string,
): Promise<boolean> {
  return confirmDestructive({
    title,
    detail: sub,
    confirmLabel: okLabel,
    bodyHtml,
    // These are not all destructive (one of them is "reload the index"), and
    // the caller has no way to say. The neutral primary is the safe default.
    danger: false,
  });
}
