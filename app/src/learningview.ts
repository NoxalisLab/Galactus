// learningview.ts, the settings section "Apprentissage".
//
// Galactus can learn its own task detection from what happens on this Mac.
// Everything here is off until the user turns it on, and the panel says what
// each switch does before it does it:
//
//   collect  writes one redacted row per message to a local file (learning.ts
//            redacts, the backend caps at 10 000 rows or 90 days);
//   toolkit  a private Python environment and the base checkpoint, downloaded
//            only on click, with its size shown first;
//   train    labels the traces with the running model, trains, and measures
//            the result against the heuristic on held-out real traces. The
//            backend activates it only when the gate passes;
//   use      lets the accepted student decide, with the heuristic as fallback.
//
// The numbers of the last training are shown as they came back, including a
// rejected one: a panel that only reports successes is not a measurement.
//
// Rules about what may be clicked live in learning.ts (panelState), tested
// without a DOM. This file paints and forwards clicks.

import { t } from "./i18n";
import {
  gateChecks,
  GATE,
  labelOrigin,
  learningSettings,
  panelState,
  parseLearningEvent,
  parseStatus,
  pct1,
  sizeLabel,
  type LearningSettings,
  type LearningStatus,
  type TrainResult,
} from "./learning";

export interface LearningViewDeps {
  esc(s: string): string;
  toast(msg: string, kind?: "err" | "ok"): void;
  settings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;
  /** decisions_status, raw: learning.ts checks the shape. */
  status(): Promise<unknown>;
  install(): Promise<void>;
  cancelInstall(): Promise<void>;
  train(): Promise<void>;
  cancelTrain(): Promise<void>;
  rollback(): Promise<unknown>;
  /** Ask for a folder and export into it. Null when the user cancelled; else what to tell them. */
  exportTraces(): Promise<string | null>;
  /** Delete traces.jsonl only. Checkpoints trained on it stay. */
  clearTraces(): Promise<void>;
  /** Delete every learned checkpoint (active, previous, rejected). */
  forgetAll(): Promise<void>;
  confirm(opts: { title: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /** Subscribe to galactus://learning. Resolves to the unsubscribe. */
  listen(cb: (payload: unknown) => void): Promise<() => void>;
  /** A primary model is loaded and ready: the labelling teacher. */
  primaryReady(): boolean;
  /** The learning settings changed: main.ts re-reads them for the agent loop. */
  changed(s: LearningSettings): void;
}

/** Install steps; every other progress phase belongs to a training run. */
const INSTALL_PHASES = new Set(["install", "venv", "requirements", "download", "checkpoint", "verify"]);

export function learningSection(d: LearningViewDeps): HTMLElement {
  const box = document.createElement("div");
  box.className = "learn";
  const esc = d.esc;

  let status: LearningStatus = parseStatus(null);
  let settings: LearningSettings = learningSettings({});
  let busy: "install" | "train" | null = null;
  let progress: { phase: string; pct: number | null; message: string } | null = null;
  let loaded = false;
  /** The backend's own words for the last failure (English), shown under a French sentence. */
  let lastError: { title: string; detail: string } | null = null;
  let unlisten: (() => void) | null = null;

  const phaseLabel = (phase: string): string => {
    const key = `learn.phase.${phase}`;
    const v = t(key);
    return v === key ? phase : v;
  };

  const tgl = (id: string, on: boolean, enabled: boolean, title = ""): string =>
    `<button class="tgl ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${on}"${enabled ? "" : ' aria-disabled="true"'}${title ? ` title="${esc(title)}"` : ""}><span class="k"></span></button>`;

  const bar = (): string => {
    if (!progress) return "";
    const pct = progress.pct;
    return `<div class="upd-prog learn-prog">
      <div class="bar"><div style="width:${pct === null ? 8 : Math.round(pct)}%"></div></div>
      <span class="n">${esc(phaseLabel(progress.phase))}${pct === null ? "" : ` · ${Math.round(pct)} %`}${progress.message ? ` · ${esc(progress.message)}` : ""}</span>
    </div>`;
  };

  const resultTable = (r: TrainResult): string => {
    const g = gateChecks(r);
    const mark = (ok: boolean) => `<span class="${ok ? "good" : "bad"}">${ok ? "✓" : "✗"}</span>`;
    const delta = (r.student.acc - r.heuristic.acc) * 100;
    const origin = labelOrigin(r);
    return `<table class="learn-table">
        <thead><tr><th></th><th>${esc(t("learn.col.acc"))}</th><th>${esc(t("learn.col.n"))}</th><th>${esc(t("learn.col.ece"))}</th></tr></thead>
        <tbody>
          <tr><td>${esc(t("learn.row.student"))}</td><td class="mono">${pct1(r.student.acc)} %</td><td class="mono">${r.student.n}</td><td class="mono">${r.student.ece.toFixed(3)}</td></tr>
          <tr><td>${esc(t("learn.row.heuristic"))}</td><td class="mono">${pct1(r.heuristic.acc)} %</td><td class="mono">${r.heuristic.n}</td><td class="mono">-</td></tr>
        </tbody>
      </table>
      <div class="learn-gate">
        ${mark(g.n)} ${esc(t("learn.gate.n").replace("%n", String(GATE.minTest)))}
        · ${mark(g.gain)} ${esc(t("learn.gate.gain").replace("%p", String(GATE.minGainPoints)).replace("%d", `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`))}
        · ${mark(g.ece)} ${esc(t("learn.gate.ece").replace("%e", GATE.maxEce.toFixed(2)))}
      </div>
      <div class="team-note">${esc(t(`learn.origin.${origin}`))} · ${esc(
        t("learn.labels")
          .replace("%t", String(r.labels.teacher))
          .replace("%o", String(r.labels.outcome))
          .replace("%h", String(r.labels.hand)),
      )}</div>
      ${r.reason ? `<div class="team-note warn">${esc(r.reason)}</div>` : ""}`;
  };

  const paint = (): void => {
    const ps = panelState({ status, settings, primaryReady: d.primaryReady(), busy });
    const size = status.downloadBytes ? sizeLabel(status.downloadBytes) : null;
    const toolkit = status.installed
      ? `<span class="badge-auto">${esc(t("common.ready"))}</span>`
      : ps.canCancelInstall
        ? `<button class="bs" id="lrncancel">${esc(t("learn.cancel"))}</button>`
        : `<button class="bs" id="lrninstall"${ps.canInstall ? "" : " disabled"}>${esc(size ? t("learn.installSize").replace("%s", size) : t("learn.install"))}</button>`;
    const last = status.last;
    box.innerHTML = `
      <div class="team-note">${esc(t("learn.intro"))}</div>
      <div class="set-row"><div class="grow"><b>${esc(t("learn.collect"))}</b><span>${esc(t("learn.collectHint"))}</span>
          <span class="mono learn-count">${esc(t("learn.count").replace("%n", String(status.traces)))}</span></div>
        ${tgl("lrncollect", settings.collect, loaded)}
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("learn.toolkit"))}</b><span>${esc(t("learn.toolkitHint"))}</span>
          ${busy === "install" ? bar() : ""}</div>
        ${toolkit}
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("learn.train"))}</b><span>${esc(t("learn.trainHint"))}</span>
          ${ps.trainBlocked && busy !== "train" ? `<span class="d">${esc(t(ps.trainBlocked))}</span>` : ""}
          ${busy === "train" ? bar() : ""}</div>
        ${ps.canCancelTrain
          ? `<button class="bs" id="lrntraincancel">${esc(t("learn.cancel"))}</button>`
          : `<button class="bs" id="lrntrain"${ps.canTrain ? "" : " disabled"}>${esc(t("learn.trainNow"))}</button>`}
      </div>
      ${lastError
        ? `<div class="learn-error"><div class="team-note warn">${esc(lastError.title)}</div>${lastError.detail ? `<pre class="learn-detail mono">${esc(lastError.detail)}</pre>` : ""}</div>`
        : ""}
      <div class="set-row"><div class="grow"><b>${esc(t("learn.last"))}</b>
          ${last
            ? `<span>${esc(t(last.accepted ? "learn.accepted" : "learn.rejected"))}${last.date ? ` · ${esc(new Date(last.date).toLocaleString())}` : ""}</span>${resultTable(last)}`
            : `<span>${esc(t("learn.never"))}</span>`}
          ${status.active ? `<span class="mono d">${esc(t("learn.activeCkpt").replace("%s", status.active))}</span>` : ""}
        </div>
        <button class="bs" id="lrnrollback"${ps.canRollback ? "" : " disabled"} title="${esc(t("learn.rollbackHint"))}">${esc(t("learn.rollback"))}</button>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("learn.use"))}</b><span>${esc(t("learn.useHint"))}</span>
          ${ps.activateBlocked ? `<span class="d">${esc(t(ps.activateBlocked))}</span>` : ""}</div>
        <div class="set-actions">
          <label class="samp"><small>${esc(t("learn.threshold"))}</small><input id="lrnthr" type="number" step="0.05" min="0.5" max="0.99" value="${settings.threshold}"/></label>
          ${tgl("lrnactive", settings.active, loaded && ps.canActivate, ps.activateBlocked ? t(ps.activateBlocked) : "")}
        </div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("learn.traces"))}</b><span>${esc(t("learn.tracesHint"))}</span></div>
        <div class="set-actions">
          <button class="bs" id="lrnexport"${ps.canExport ? "" : " disabled"}>${esc(t("learn.export"))}</button>
          <button class="bs" id="lrnclear"${ps.canClear ? "" : " disabled"} title="${esc(t("learn.clearHint"))}">${esc(t("learn.clear"))}</button>
          <button class="bs danger" id="lrnforget"${ps.canForget ? "" : " disabled"} title="${esc(t("learn.forgetHint"))}">${esc(t("learn.forget"))}</button>
        </div>
      </div>`;
  };

  const refresh = async (): Promise<void> => {
    try {
      const [raw, st] = await Promise.all([d.status(), d.settings()]);
      status = parseStatus(raw);
      settings = learningSettings(st);
      loaded = true;
      if (status.installing) busy = "install";
      else if (status.training) busy = "train";
      else if (busy && !progress) busy = null;
    } catch (e) {
      d.toast(t("learn.statusFailed").replace("%s", String(e)), "err");
    }
    paint();
  };

  /** A French sentence, and the backend's own words under it. */
  const report = (titleKey: string, e: unknown): void => {
    lastError = { title: t(titleKey), detail: String((e as { message?: string })?.message ?? e) };
    d.toast(lastError.title, "err");
    paint();
  };

  const fail = (e: unknown): void => {
    busy = null;
    progress = null;
    const detail = String((e as { message?: string })?.message ?? e);
    lastError = { title: t("learn.jobFailed"), detail };
    d.toast(t("learn.jobFailed"), "err");
    paint();
  };

  const onEvent = (payload: unknown): void => {
    if (!box.isConnected && loaded) {
      // The settings page was left: this panel is gone, stop listening.
      unlisten?.();
      unlisten = null;
      return;
    }
    const ev = parseLearningEvent(payload);
    if (!ev) return;
    if (ev.kind === "result") {
      busy = null;
      progress = null;
      lastError = null;
      d.toast(t(ev.result.accepted ? "learn.toastAccepted" : "learn.toastRejected"), ev.result.accepted ? "ok" : undefined);
      void refresh();
      return;
    }
    if (ev.kind === "end") {
      const was = busy;
      busy = null;
      progress = null;
      if (ev.outcome === "error") {
        lastError = { title: t(was === "install" ? "learn.installFailed" : "learn.jobFailed"), detail: ev.message };
        d.toast(lastError.title, "err");
      } else if (ev.outcome === "cancelled") {
        d.toast(t("learn.cancelled"));
      } else {
        lastError = null;
      }
      void refresh();
      return;
    }
    if (!busy) busy = INSTALL_PHASES.has(ev.phase) ? "install" : "train";
    progress = { phase: ev.phase, pct: ev.pct, message: ev.message };
    paint();
  };

  const setBool = async (key: "learning_collect" | "learning_active", on: boolean): Promise<void> => {
    try {
      await d.setSetting(key, on ? "1" : "");
      if (key === "learning_collect") settings = { ...settings, collect: on };
      else settings = { ...settings, active: on };
      d.changed(settings);
    } catch (e) {
      report("learn.settingFailed", e);
      return;
    }
    paint();
  };

  box.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!target || target.disabled || target.getAttribute("aria-disabled") === "true") return;
    switch (target.id) {
      case "lrncollect":
        void setBool("learning_collect", !settings.collect);
        break;
      case "lrnactive":
        void setBool("learning_active", !settings.active);
        break;
      case "lrninstall":
        lastError = null;
        busy = "install";
        progress = { phase: "install", pct: null, message: "" };
        paint();
        d.install().then(() => refresh().then(() => {
          if (status.installed) { busy = null; progress = null; paint(); }
        }), fail);
        break;
      case "lrncancel":
        d.cancelInstall().then(() => { busy = null; progress = null; return refresh(); }, fail);
        break;
      case "lrntraincancel":
        d.cancelTrain().catch(fail);
        break;
      case "lrntrain":
        lastError = null;
        busy = "train";
        progress = { phase: "label", pct: null, message: "" };
        paint();
        d.train().catch(fail);
        break;
      case "lrnrollback":
        void (async () => {
          const ok = await d.confirm({
            title: t("learn.rollbackTitle"),
            detail: t("learn.rollbackDetail").replace("%s", status.previous ?? ""),
            confirmLabel: t("learn.rollback"),
          });
          if (!ok) return;
          try {
            await d.rollback();
            d.toast(t("learn.rolledBack"), "ok");
          } catch (err) {
            report("learn.rollbackFailed", err);
          }
          await refresh();
        })();
        break;
      case "lrnexport":
        d.exportTraces().then((msg) => { if (msg) d.toast(msg, "ok"); }, (err) => report("learn.exportFailed", err));
        break;
      case "lrnforget":
        void (async () => {
          const ok = await d.confirm({
            title: t("learn.forgetTitle"),
            detail: t("learn.forgetDetail").replace("%n", String(status.traces)),
            confirmLabel: t("learn.forget"),
          });
          if (!ok) return;
          try {
            await d.clearTraces();
            await d.forgetAll();
            // No checkpoint is left to answer: the student is switched off with it.
            await d.setSetting("learning_active", "");
            settings = { ...settings, active: false };
            d.changed(settings);
            d.toast(t("learn.forgotten"), "ok");
          } catch (err) {
            report("learn.forgetFailed", err);
          }
          await refresh();
        })();
        break;
      case "lrnclear":
        void (async () => {
          const ok = await d.confirm({
            title: t("learn.clearTitle"),
            detail: t("learn.clearDetail").replace("%n", String(status.traces)),
            confirmLabel: t("learn.clear"),
          });
          if (!ok) return;
          try {
            await d.clearTraces();
            d.toast(t("learn.cleared"), "ok");
          } catch (err) {
            report("learn.clearFailed", err);
          }
          await refresh();
        })();
        break;
    }
  });

  box.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id !== "lrnthr") return;
    const v = learningSettings({ learning_threshold: input.value }).threshold;
    input.value = String(v);
    d.setSetting("learning_threshold", String(v)).then(
      () => { settings = { ...settings, threshold: v }; d.changed(settings); },
      (err) => report("learn.settingFailed", err),
    );
  });

  paint();
  d.listen(onEvent).then((u) => { unlisten = u; }, () => { /* no events: the refresh still shows the state */ });
  void refresh();
  return box;
}
