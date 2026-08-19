/**
 * The Security view: audit your own apps and machines, read only.
 *
 * Two panels over the two backend commands. A web endpoint audit (headers, TLS,
 * cookies) and a TCP-connect port scan. Neither attacks anything: the scan is
 * an ordinary connect, the audit is one discarded GET plus a TLS handshake. The
 * one thing the user asserts by typing a target here is that it is theirs, and
 * the view says so.
 *
 * Same shape and the same two local helpers as imageview and the other views:
 * a module of two functions imported everywhere is a dependency for no gain.
 */

import { api, type PortResult, type SecFinding, type WebAudit } from "./api";
import { t } from "./i18n";

function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SecurityDeps {
  toast: (msg: string, kind?: "err" | "ok") => void;
}

let deps: SecurityDeps | null = null;

export function setSecurityDeps(d: SecurityDeps): void {
  deps = d;
}

/** The everyday ports, so a first scan needs no thinking. */
const COMMON_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 587, 3000, 3306, 3389, 5432, 5900,
  6379, 8080, 8443, 9000, 11211, 27017,
];

function range1to1024(): number[] {
  return Array.from({ length: 1024 }, (_, i) => i + 1);
}

let webBusy = false;
let scanBusy = false;
let webResult: WebAudit | null = null;
let scanResult: { host: string; ports: PortResult[] } | null = null;

export function securityView(): HTMLElement {
  const wrap = el(`<div class="main">
    <div class="topbar" data-tauri-drag-region><span class="ttl">${esc(t("nav.security"))}</span><span class="sub">${esc(t("sec.subtitle"))}</span></div>
    <div class="scroll" id="secbody">${body()}</div>
  </div>`);
  wire(wrap);
  return wrap;
}

function body(): string {
  return `
  <div class="sect"><b>${esc(t("sec.webSect"))}</b><span>${esc(t("sec.webHint"))}</span></div>
  <div class="set-row secctl">
    <input id="securl" class="grow" placeholder="${esc(t("sec.webPlaceholder"))}" autocomplete="off" spellcheck="false"/>
    <button class="bp" id="secweb"${webBusy ? " disabled" : ""}>${esc(webBusy ? t("sec.auditing") : t("sec.audit"))}</button>
  </div>
  <div id="secwebout">${webResult ? findingsHtml(webResult) : ""}</div>

  <div class="sect sectgap"><b>${esc(t("sec.portSect"))}</b><span>${esc(t("sec.portHint"))}</span></div>
  <div class="set-row secctl">
    <input id="sechost" class="grow" placeholder="${esc(t("sec.hostPlaceholder"))}" autocomplete="off" spellcheck="false"/>
    <div class="seg" id="secrange">
      <button data-range="common" class="on">${esc(t("sec.rangeCommon"))}</button>
      <button data-range="all">${esc(t("sec.rangeAll"))}</button>
    </div>
    <button class="bp" id="secscan"${scanBusy ? " disabled" : ""}>${esc(scanBusy ? t("sec.scanning") : t("sec.scan"))}</button>
  </div>
  <div id="secscanout">${scanResult ? portsHtml(scanResult.ports) : ""}</div>

  <div class="secfoot">${esc(t("sec.own"))}</div>`;
}

let range: "common" | "all" = "common";

function findingsHtml(a: WebAudit): string {
  if (a.findings.length === 0) {
    return `<div class="cempty">${esc(t("sec.noFindings"))}</div>`;
  }
  // Worst first, so the eye lands on what matters.
  const order: Record<string, number> = { risk: 0, warn: 1, ok: 2 };
  const rows = [...a.findings]
    .sort((x, y) => (order[x.level] ?? 3) - (order[y.level] ?? 3))
    .map(findingRow)
    .join("");
  const code = a.status !== null ? ` <span class="secstatus">HTTP ${a.status}</span>` : "";
  return `<div class="securlline">${esc(a.url)}${code}</div><div class="secfindings">${rows}</div>`;
}

function findingRow(f: SecFinding): string {
  return `<div class="secfind ${esc(f.level)}">
    <span class="secdot"></span>
    <div class="secbody"><b>${esc(f.title)}</b><span>${esc(f.detail)}</span></div>
  </div>`;
}

function portsHtml(ports: PortResult[]): string {
  if (ports.length === 0) {
    return `<div class="cempty">${esc(t("sec.noOpen"))}</div>`;
  }
  const rows = ports
    .map((p) => {
      const svc = p.service ? `<span class="secsvc">${esc(p.service)}</span>` : "";
      const banner = p.banner ? `<span class="secbanner">${esc(p.banner)}</span>` : "";
      return `<div class="secport"><b>${p.port}</b>${svc}${banner}</div>`;
    })
    .join("");
  return `<div class="secports">${rows}</div>`;
}

function wire(wrap: HTMLElement): void {
  const box = wrap.querySelector<HTMLElement>("#secbody");
  if (!box) return;

  box.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const rangeBtn = target.closest("[data-range]") as HTMLElement | null;
    if (rangeBtn) {
      range = rangeBtn.dataset.range as "common" | "all";
      box.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("on", b === rangeBtn));
      return;
    }
    if (target.closest("#secweb")) {
      void runWebAudit(wrap);
      return;
    }
    if (target.closest("#secscan")) {
      void runScan(wrap);
      return;
    }
  });

  // Return in a field runs its own audit, the obvious gesture.
  box.querySelector<HTMLInputElement>("#securl")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runWebAudit(wrap);
  });
  box.querySelector<HTMLInputElement>("#sechost")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runScan(wrap);
  });
}

function repaint(wrap: HTMLElement): void {
  const box = wrap.querySelector<HTMLElement>("#secbody");
  if (!box) return;
  // Keep what the user typed across a repaint: the inputs are not in the state.
  const url = box.querySelector<HTMLInputElement>("#securl")?.value ?? "";
  const host = box.querySelector<HTMLInputElement>("#sechost")?.value ?? "";
  box.innerHTML = body();
  wire(wrap);
  const u = box.querySelector<HTMLInputElement>("#securl");
  const h = box.querySelector<HTMLInputElement>("#sechost");
  if (u) u.value = url;
  if (h) h.value = host;
}

async function runWebAudit(wrap: HTMLElement): Promise<void> {
  if (webBusy) return;
  const url = wrap.querySelector<HTMLInputElement>("#securl")?.value.trim() ?? "";
  if (!/^https?:\/\//.test(url)) {
    deps?.toast(t("sec.needUrl"));
    return;
  }
  webBusy = true;
  repaint(wrap);
  try {
    webResult = await api.secAuditWeb(url);
  } catch (e: unknown) {
    deps?.toast(String((e as { message?: string })?.message ?? e));
  } finally {
    webBusy = false;
    repaint(wrap);
  }
}

async function runScan(wrap: HTMLElement): Promise<void> {
  if (scanBusy) return;
  const host = wrap.querySelector<HTMLInputElement>("#sechost")?.value.trim() ?? "";
  if (host === "") {
    deps?.toast(t("sec.needHost"));
    return;
  }
  scanBusy = true;
  repaint(wrap);
  try {
    const ports = range === "all" ? range1to1024() : COMMON_PORTS;
    scanResult = { host, ports: await api.secScanPorts(host, ports) };
  } catch (e: unknown) {
    deps?.toast(String((e as { message?: string })?.message ?? e));
  } finally {
    scanBusy = false;
    repaint(wrap);
  }
}
