// teamsview.ts, the settings section for model teams.
//
// Choose the active preset, and edit presets: a model per role among the
// models this Mac can actually run, add or remove a role, duplicate, reset a
// shipped preset to what the registry says, delete one the user made. Each
// preset shows its summed footprint estimate and whether it fits here, BEFORE
// anything is started: loading two 20 GB models to find out they do not fit
// together costs a minute and a swap storm.
//
// Nothing here starts an engine. The engines start when a teammate is
// recruited for a role (main.ts), and the backend plans the real memory then.

import { t } from "./i18n";
import type { CloudUsage } from "./api";
import {
  copyId,
  isCloud,
  presetFootprint,
  roleKey,
  type SizedModel,
  type StoredPreset,
  type TeamPreset,
} from "./teams";

export interface TeamsModel extends SizedModel {
  name: string;
  /** Installed and allowed to execute on this Mac (model-policy.ts). */
  runnable: boolean;
}

export interface TeamsViewDeps {
  esc(s: string): string;
  toast(msg: string, kind?: "err" | "ok"): void;
  models(): TeamsModel[];
  /** What the engines may hold together, bytes. Null when the hardware is unknown. */
  budget(): number | null;
  shipped(): StoredPreset[];
  presets(): TeamPreset[];
  activeId(): string;
  /** Persist both settings and re-apply them to the live agents. */
  save(activeId: string, presets: TeamPreset[]): Promise<void>;
  cloud: CloudDeps;
}

/** The OpenRouter block. The key is write-only: nothing here can read it back. */
export interface CloudDeps {
  status(): Promise<{ enabled: boolean; keyed: boolean; redact: boolean; cap: string; usage: CloudUsage | null }>;
  setEnabled(on: boolean): Promise<void>;
  saveKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  setCap(usd: string): Promise<void>;
  setRedact(on: boolean): Promise<void>;
  /** Asks the provider for its catalogue: a network call, so only on click. */
  listModels(): Promise<string[]>;
}

/** The only provider wired today. Roles carry theirs, so a second one is data. */
const PROVIDER = "openrouter";
/**
 * Offered before the user lists the catalogue: none. A hard-coded list of
 * provider slugs is out of date within months and would put a retired model
 * in front of the user as a suggestion. "Lister les modèles" fetches the live
 * catalogue on click, and any slug can be typed.
 */
const SLUG_HINTS: string[] = [];
const CLOUD_OPTION = "__cloud__";

const gb = (b: number): string => (b / 1e9).toFixed(b >= 10e9 ? 0 : 1);

export function teamsSection(d: TeamsViewDeps): HTMLElement {
  const box = document.createElement("div");
  box.className = "teams";
  const esc = d.esc;
  /** Slugs for the datalist: the hints, then whatever "list models" brought back. */
  let slugs: string[] = SLUG_HINTS;

  const paint = (): void => {
    const presets = d.presets();
    const active = d.activeId();
    const models = d.models();
    const budget = d.budget();
    const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;

    const options = [`<option value=""${active ? "" : " selected"}>${esc(t("teams.off"))}</option>`]
      .concat(presets.map((p) => `<option value="${esc(p.id)}"${p.id === active ? " selected" : ""}>${esc(p.name)}</option>`))
      .join("");

    const cards = presets
      .map((p) => {
        const fp = presetFootprint(p, models, budget);
        const verdict =
          fp.fits === null
            ? fp.missing.length
              ? t("teams.fitUnknownModel").replace("%s", fp.missing.join(", "))
              : t("teams.fitUnknown")
            : (fp.fits ? t("teams.fits") : t("teams.noFit")).replace("%b", budget ? gb(budget) : "?");
        const streamed = fp.roles.filter((r) => r.streamed && r.bytes > 0).map((r) => nameOf(r.modelId));
        const cloudRoles = fp.roles.filter((r) => r.cloud).map((r) => r.role);
        const roles = Object.entries(p.roles)
          .map(([role, target]) => {
            const del = `<button class="bs bglyph" data-delrole="${esc(role)}" title="${esc(t("teams.removeRole"))}"${Object.keys(p.roles).length <= 1 ? " disabled" : ""}>×</button>`;
            const cloudOpt = (on: boolean) =>
              `<option value="${CLOUD_OPTION}"${on ? " selected" : ""}>${esc(t("cloud.option"))}</option>`;
            if (isCloud(target)) {
              const locals = models
                .filter((m) => m.runnable)
                .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
                .join("");
              return `<div class="team-role cloud">
              <span class="mono">${esc(role)}</span>
              <select data-role="${esc(role)}">${cloudOpt(true)}${locals}</select>
              <input class="team-slug mono" data-slug="${esc(role)}" list="cloudslugs" value="${esc(target.model)}" placeholder="${esc(t("cloud.slugPlaceholder"))}"/>
              ${del}
            </div>`;
            }
            const id = target;
            const cur = models.find((m) => m.id === id);
            // The current choice stays listed even when it cannot run, marked,
            // so opening the panel never silently rewrites a preset.
            const opts = models
              .filter((m) => m.runnable || m.id === id)
              .map(
                (m) =>
                  `<option value="${esc(m.id)}"${m.id === id ? " selected" : ""}>${esc(m.name)}${m.runnable ? "" : ` (${esc(t("teams.unavailable"))})`}</option>`
              );
            if (!cur) opts.unshift(`<option value="${esc(id)}" selected>${esc(id)} (${esc(t("teams.unknownModel"))})</option>`);
            return `<div class="team-role">
              <span class="mono">${esc(role)}</span>
              <select data-role="${esc(role)}">${opts.join("")}${cloudOpt(false)}</select>
              ${del}
            </div>`;
          })
          .join("");
        const reset =
          p.source === "override"
            ? `<button class="bs" data-reset>${esc(t("teams.reset"))}</button>`
            : p.source === "user"
              ? `<button class="bs" data-del>${esc(t("teams.delete"))}</button>`
              : "";
        return `<div class="team-card${p.id === active ? " on" : ""}" data-id="${esc(p.id)}">
          <div class="team-head">
            <input class="team-name" value="${esc(p.name)}" aria-label="${esc(t("teams.name"))}"/>
            ${p.id === active ? `<span class="badge-auto">${esc(t("teams.active"))}</span>` : ""}
          </div>
          ${p.note ? `<div class="team-note">${esc(p.note)}</div>` : ""}
          <div class="team-roles">${roles}</div>
          <div class="team-add"><input class="team-newrole mono" placeholder="${esc(t("teams.rolePlaceholder"))}"/><button class="bs" data-addrole>${esc(t("teams.addRole"))}</button></div>
          <div class="team-fp ${fp.fits === false ? "bad" : fp.fits ? "good" : ""}">≈ ${gb(fp.bytes)} ${esc(t("teams.gbEstimated"))} · ${esc(verdict)}${streamed.length ? ` · ${esc(t("teams.streamed").replace("%s", streamed.join(", ")))}` : ""}${cloudRoles.length ? ` · ${esc(t("cloud.fpRoles").replace("%s", cloudRoles.join(", ")))}` : ""}</div>
          <div class="set-actions">
            ${p.id === active ? "" : `<button class="bs" data-activate>${esc(t("teams.activate"))}</button>`}
            <button class="bs" data-dup>${esc(t("teams.duplicate"))}</button>
            ${reset}
          </div>
        </div>`;
      })
      .join("");

    box.innerHTML = `
      <div class="set-row"><div class="grow"><b>${esc(t("teams.activeTitle"))}</b><span>${esc(t("teams.activeHint"))}</span></div>
        <select id="teamsel" class="teamsel">${options}</select>
      </div>
      <div class="team-cards">${presets.length ? cards : `<div class="team-note">${esc(t("teams.none"))}</div>`}</div>
      <datalist id="cloudslugs">${slugs.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>
      <div class="cloudbox"></div>`;
    void paintCloud();
  };

  /**
   * The provider block, painted from a fresh status each time: the key state
   * lives in the Keychain and the spend in the backend's ledger, not here.
   */
  const paintCloud = async (): Promise<void> => {
    const host = box.querySelector<HTMLElement>(".cloudbox");
    if (!host) return;
    let st: Awaited<ReturnType<CloudDeps["status"]>>;
    try {
      st = await d.cloud.status();
    } catch {
      st = { enabled: false, keyed: false, redact: true, cap: "5", usage: null };
    }
    const spend = st.usage
      ? t("cloud.spend")
          .replace("%t", st.usage.total_usd.toFixed(2))
          .replace("%c", st.usage.cap_usd.toFixed(2))
          .replace("%n", String(st.usage.calls))
      : t("cloud.spendUnknown");
    host.innerHTML = `
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.title"))}</b><span>${esc(t("cloud.leaves"))}</span></div>
        <button class="tgl ${st.enabled ? "on" : ""}" id="cloudtgl" role="switch" aria-checked="${st.enabled}"><span class="k"></span></button>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.key"))}</b><span>${esc(st.keyed ? t("cloud.keySaved") : t("cloud.keyHint"))}</span></div>
        <div class="set-actions">
          <input id="cloudkey" class="cloud-in" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(st.keyed ? t("cloud.keyReplace") : "sk-or-…")}"/>
          <button class="bs" id="cloudkeysave">${esc(t("cloud.keySave"))}</button>
          ${st.keyed ? `<button class="bs" id="cloudkeyclear">${esc(t("cloud.keyClear"))}</button>` : ""}
        </div>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.cap"))}</b><span>${esc(spend)}</span></div>
        <label class="samp"><small>USD / ${esc(t("cloud.day"))}</small><input id="cloudcap" type="number" min="0" step="0.5" value="${esc(st.cap)}"/></label>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.redact"))}</b><span>${esc(t("cloud.redactHint"))}</span></div>
        <button class="tgl ${st.redact ? "on" : ""}" id="cloudredact" role="switch" aria-checked="${st.redact}"><span class="k"></span></button>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.models"))}</b><span>${esc(t("cloud.modelsHint"))}</span></div>
        <button class="bs" id="cloudlist"${st.enabled ? "" : " disabled"}>${esc(t("cloud.list"))}</button>
      </div>`;
  };

  /** Replace one preset and save. An edited shipped preset becomes an override. */
  const commit = async (next: TeamPreset[], active = d.activeId()): Promise<void> => {
    try {
      await d.save(active, next);
    } catch (e: any) {
      d.toast(String(e?.message ?? e));
    }
    paint();
  };
  const edit = (id: string, change: (p: TeamPreset) => TeamPreset | null): Promise<void> => {
    const list = d.presets();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return Promise.resolve();
    const changed = change({ ...list[i], roles: { ...list[i].roles } });
    const next = [...list];
    if (changed) next[i] = { ...changed, source: changed.source === "shipped" ? "override" : changed.source };
    else next.splice(i, 1);
    return commit(next);
  };

  box.addEventListener("change", (e) => {
    const target = e.target as HTMLElement;
    if (target.id === "teamsel") {
      void commit(d.presets(), (target as HTMLSelectElement).value);
      return;
    }
    if (target.id === "cloudcap") {
      const v = Number((target as HTMLInputElement).value);
      if (Number.isFinite(v) && v >= 0) void d.cloud.setCap(String(v)).then(paintCloud);
      return;
    }
    const card = target.closest<HTMLElement>(".team-card");
    if (!card) return;
    const id = card.dataset.id!;
    if (target instanceof HTMLSelectElement && target.dataset.role) {
      const role = target.dataset.role;
      const value = target.value;
      void edit(id, (p) => ({
        ...p,
        roles: {
          ...p.roles,
          // Turning a role cloud starts with no model: nothing leaves until a
          // slug is chosen, the provider enabled and a key stored.
          [role]: value === CLOUD_OPTION ? { kind: "cloud", provider: PROVIDER, model: "" } : value,
        },
      }));
    } else if (target.dataset.slug) {
      const role = target.dataset.slug;
      const model = (target as HTMLInputElement).value.trim();
      void edit(id, (p) => {
        const cur = p.roles[role];
        return isCloud(cur) ? { ...p, roles: { ...p.roles, [role]: { ...cur, model } } } : p;
      });
    } else if (target.classList.contains("team-name")) {
      const name = (target as HTMLInputElement).value.trim();
      if (name) void edit(id, (p) => ({ ...p, name }));
      else paint();
    }
  });

  box.addEventListener("click", (e) => {
    const cb = (e.target as HTMLElement).closest<HTMLElement>(".cloudbox button");
    if (cb) {
      void onCloudClick(cb);
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    const card = b?.closest<HTMLElement>(".team-card");
    if (!b || !card || b.hasAttribute("disabled")) return;
    const id = card.dataset.id!;
    if (b.hasAttribute("data-activate")) {
      void commit(d.presets(), id);
    } else if (b.hasAttribute("data-dup")) {
      const list = d.presets();
      const src = list.find((p) => p.id === id);
      if (!src) return;
      const copy: TeamPreset = {
        id: copyId(list, id),
        name: `${src.name} ${t("teams.copySuffix")}`,
        roles: { ...src.roles },
        ...(src.note ? { note: src.note } : {}),
        source: "user",
      };
      void commit([...list, copy]);
    } else if (b.hasAttribute("data-reset")) {
      const orig = d.shipped().find((s) => s.id === id);
      if (orig) void commit(d.presets().map((p) => (p.id === id ? { ...orig, source: "shipped" as const } : p)));
    } else if (b.hasAttribute("data-del")) {
      // Deleting the active preset turns teams off rather than pointing the
      // setting at nothing.
      void commit(d.presets().filter((p) => p.id !== id), d.activeId() === id ? "" : d.activeId());
    } else if (b.dataset.delrole) {
      const role = b.dataset.delrole;
      void edit(id, (p) => {
        const roles = { ...p.roles };
        delete roles[role];
        return Object.keys(roles).length ? { ...p, roles } : p;
      });
    } else if (b.hasAttribute("data-addrole")) {
      const input = card.querySelector<HTMLInputElement>(".team-newrole");
      const role = roleKey(input?.value ?? "").replace(/\s+/g, "-");
      if (!role) return;
      const p = d.presets().find((x) => x.id === id);
      if (!p || p.roles[role]) {
        d.toast(t("teams.roleExists").replace("%s", role));
        return;
      }
      // A new role starts on the first model this Mac can run, the same
      // default a user picking from the list would see first.
      const first = d.models().find((m) => m.runnable);
      if (!first) {
        d.toast(t("teams.noRunnable"));
        return;
      }
      void edit(id, (q) => ({ ...q, roles: { ...q.roles, [role]: first.id } }));
    }
  });

  const onCloudClick = async (b: HTMLElement): Promise<void> => {
    if (b.hasAttribute("disabled")) return;
    try {
      if (b.id === "cloudtgl") {
        await d.cloud.setEnabled(!b.classList.contains("on"));
      } else if (b.id === "cloudredact") {
        await d.cloud.setRedact(!b.classList.contains("on"));
      } else if (b.id === "cloudkeysave") {
        const input = box.querySelector<HTMLInputElement>("#cloudkey");
        const key = input?.value.trim() ?? "";
        if (!key) return;
        // Cleared from the field before anything else: it is written once,
        // to the Keychain, and must not linger in the DOM.
        if (input) input.value = "";
        await d.cloud.saveKey(key);
        d.toast(t("cloud.keySaved"), "ok");
      } else if (b.id === "cloudkeyclear") {
        await d.cloud.clearKey();
      } else if (b.id === "cloudlist") {
        b.setAttribute("disabled", "");
        const got = await d.cloud.listModels();
        if (got.length) {
          slugs = got;
          const dl = box.querySelector<HTMLElement>("#cloudslugs");
          if (dl) dl.innerHTML = got.map((x) => `<option value="${esc(x)}"></option>`).join("");
          d.toast(t("cloud.listed").replace("%n", String(got.length)), "ok");
        }
      }
    } catch (e: any) {
      d.toast(String(e?.message ?? e));
    }
    // The cards' fallback state depends on the provider switch and the key,
    // so everything but the catalogue refresh repaints the whole section.
    if (b.id === "cloudlist") await paintCloud();
    else paint();
  };

  paint();
  return box;
}
