/**
 * The one confirmation dialog for things that cannot be undone.
 *
 * WHY IT EXISTS. Three buttons deleted permanently with no question asked:
 * "delete everything learned", deleting a run with its transcript, and deleting
 * a scheduled job. Each is one click, none of them is reversible, and the
 * learned store in particular is months of accumulated preferences. The Code
 * view already had a confirmation modal, private to that file, so the other
 * views had nothing to reach for. This is that modal, shared.
 *
 * WHY NOT window.confirm. It blocks the whole webview, which in this app means
 * the engine's stream stops being read while the dialog is up.
 *
 * ACCESSIBILITY, which the app's older modals do not do. The dialog announces
 * itself as one, focus moves into it and is trapped while it is open, Escape
 * resolves it as a refusal rather than leaving the promise pending forever, and
 * focus returns to whatever the user was on when it closes. A dialog you cannot
 * dismiss with the keyboard is a dialog that traps somebody.
 */

import { t } from "./i18n.js";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Ask before doing something irreversible. Resolves true only on the explicit
 * confirm: Escape, the cancel button, and a click on the backdrop are all no.
 *
 * `danger` styles the confirm button as destructive and is the default here,
 * because everything this dialog currently guards destroys something.
 */
export function confirmDestructive(opts: {
  title: string;
  detail: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const back = document.createElement("div");
    back.className = "modal-bd";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="cfm-t" aria-describedby="cfm-d">
      <h3 id="cfm-t">${esc(opts.title)}</h3>
      <div class="ps" id="cfm-d">${esc(opts.detail)}</div>
      <div class="acts">
        <button class="bs" data-x="0">${esc(t("conn.cancel"))}</button>
        <button class="${opts.danger === false ? "bp" : "bp danger"}" data-x="1">${esc(opts.confirmLabel)}</button>
      </div></div>`;

    let settled = false;
    const done = (ok: boolean): void => {
      // Guarded because three paths lead here and a Promise resolved twice
      // keeps its first answer silently, which hides a bug rather than showing
      // one.
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      // Returning focus matters: without it the user lands back at the top of
      // the document and has to tab through the whole view again.
      previous?.focus?.();
      resolve(ok);
    };

    const focusable = (): HTMLElement[] =>
      [...back.querySelectorAll<HTMLElement>("button")].filter((b) => !b.hasAttribute("disabled"));

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(false);
        return;
      }
      if (e.key !== "Tab") return;
      // The trap. Without it, Tab walks out of the dialog and into the view
      // behind it, which is still there and still clickable to a screen reader.
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
        done(btn.dataset.x === "1");
        return;
      }
      // The backdrop itself, meaning a click outside the dialog. Same as
      // cancelling: an accidental click must never confirm a deletion.
      if (target === back) done(false);
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    // Cancel takes focus, not confirm. A stray Return must not delete.
    focusable()[0]?.focus();
  });
}
