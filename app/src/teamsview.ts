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
  CLOUD_PROVIDERS,
  cloudBlock,
  cloudProviderInfo,
  copyId,
  isCloud,
  priceFor,
  type CloudState,
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

/** The cloud providers block. Keys are write-only: nothing here can read one back. */
export interface CloudDeps {
  /** A fresh status: keys from the Keychain, spend from the backend's ledger. */
  status(): Promise<{ state: CloudState; redact: boolean; cap: string; usage: CloudUsage | null }>;
  /** The last known state, for painting the cards synchronously. */
  state(): CloudState;
  setEnabled(provider: string, on: boolean): Promise<void>;
  saveKey(provider: string, key: string): Promise<void>;
  clearKey(provider: string): Promise<void>;
  /** USD per million tokens, written to the user's own price table. */
  setPrice(provider: string, model: string, input: number, output: number): Promise<void>;
  setCap(usd: string): Promise<void>;
  setRedact(on: boolean): Promise<void>;
  /** Asks the provider for its catalogue: a network call, so only on click. */
  listModels(provider: string): Promise<string[]>;
}

/**
 * Model suggestions per provider: none written here beyond each provider's
 * single `suggested` default. A hard-coded list of slugs is out of date within
 * months and would put a retired model in front of the user. "Lister les
 * modèles" fetches the live catalogue on click, and any model can be typed.
 */
const CLOUD_OPTION = "__cloud__:";

const gb = (b: number): string => (b / 1e9).toFixed(b >= 10e9 ? 0 : 1);

export function teamsSection(d: TeamsViewDeps): HTMLElement {
  const box = document.createElement("div");
  box.className = "teams";
  const esc = d.esc;
  /** Per provider, whatever "list models" brought back this session. */
  const slugs: Record<string, string[]> = {};
  const datalist = (provider: string): string => {
    const list = slugs[provider] ?? [cloudProviderInfo(provider).suggested].filter(Boolean);
    return `<datalist id="cloudslugs-${esc(provider)}">${list.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>`;
  };

  const paint = (): void => {
    const presets = d.presets();
    const active = d.activeId();
    const models = d.models();
    const budget = d.budget();
    const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
    const cloud = d.cloud.state();

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
        // A provider that does not report cost needs a price before its role
        // may run: the daily cap is computed from it. Such a preset cannot be
        // activated until every price is set, rather than activated and then
        // silently falling back at every spawn.
        const unpriced = Object.values(p.roles)
          .filter(isCloud)
          .filter((r) => r.model && cloudProviderInfo(r.provider).needsPrice && !priceFor(cloud.prices ?? {}, r.provider, r.model))
          .map((r) => `${r.provider}/${r.model}`);
        const roles = Object.entries(p.roles)
          .map(([role, target]) => {
            const del = `<button class="bs bglyph" data-delrole="${esc(role)}" title="${esc(t("teams.removeRole"))}"${Object.keys(p.roles).length <= 1 ? " disabled" : ""}>×</button>`;
            const cloudOpts = (selected: string | null) =>
              CLOUD_PROVIDERS.map(
                (cp) =>
                  `<option value="${CLOUD_OPTION}${esc(cp.id)}"${cp.id === selected ? " selected" : ""}>${esc(t("cloud.option").replace("%p", cp.name))}</option>`
              ).join("");
            if (isCloud(target)) {
              const info = cloudProviderInfo(target.provider);
              const locals = models
                .filter((m) => m.runnable)
                .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
                .join("");
              const price = target.model ? priceFor(cloud.prices ?? {}, target.provider, target.model) : null;
              const priceRow = info.needsPrice && target.model
                ? `<div class="team-price${price ? "" : " missing"}">
                    <span>${esc(t(price ? "cloud.price" : "cloud.priceNeeded"))}</span>
                    <label class="samp"><small>${esc(t("cloud.priceIn"))}</small><input type="number" min="0" step="0.1" data-pin="${esc(role)}" value="${price ? price[0] : ""}"/></label>
                    <label class="samp"><small>${esc(t("cloud.priceOut"))}</small><input type="number" min="0" step="0.1" data-pout="${esc(role)}" value="${price ? price[1] : ""}"/></label>
                  </div>`
                : "";
              const block = cloudBlock(target, cloud);
              return `<div class="team-role cloud">
              <span class="mono">${esc(role)}</span>
              <select data-role="${esc(role)}">${cloudOpts(target.provider)}${locals}</select>
              <input class="team-slug mono" data-slug="${esc(role)}" list="cloudslugs-${esc(target.provider)}" value="${esc(target.model)}" placeholder="${esc(info.suggested || t("cloud.slugPlaceholder"))}"/>
              ${del}
            </div>
            ${priceRow}
            ${block && block !== "cloud-no-price" ? `<div class="team-note warn">${esc(t(`cloud.block.${block}`).replace("%p", info.name))}</div>` : ""}`;
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
              <select data-role="${esc(role)}">${opts.join("")}${cloudOpts(null)}</select>
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
          ${unpriced.length ? `<div class="team-note warn">${esc(t("cloud.unpriced").replace("%s", unpriced.join(", ")))}</div>` : ""}
          <div class="set-actions">
            ${p.id === active ? "" : `<button class="bs" data-activate${unpriced.length ? ` disabled title="${esc(t("cloud.unpriced").replace("%s", unpriced.join(", ")))}"` : ""}>${esc(t("teams.activate"))}</button>`}
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
      ${CLOUD_PROVIDERS.map((cp) => datalist(cp.id)).join("")}
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
      st = { state: { enabled: {}, keyed: {} }, redact: true, cap: "5", usage: null };
    }
    const spend = st.usage
      ? t("cloud.spend")
          .replace("%t", st.usage.total_usd.toFixed(2))
          .replace("%c", st.usage.cap_usd.toFixed(2))
          .replace("%n", String(st.usage.calls))
      : t("cloud.spendUnknown");
    // One block per provider: each is enabled on its own, with its own key,
    // because trusting one company with the work is not trusting all three.
    const providers = CLOUD_PROVIDERS.map((cp) => {
      const on = !!st.state.enabled[cp.id];
      const keyed = !!st.state.keyed[cp.id];
      const pid = esc(cp.id);
      return `<div class="set-row cloud-prov" data-provider="${pid}"><div class="grow"><b>${esc(cp.name)}</b><span>${esc(t("cloud.leaves").replace("%p", cp.name))}</span><span>${esc(keyed ? t("cloud.keySaved") : t("cloud.keyHint"))}</span></div>
        <div class="set-actions">
          <input class="cloud-in" data-key="${pid}" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(keyed ? t("cloud.keyReplace") : t("cloud.keyPlaceholder"))}"/>
          <button class="bs" data-act="savekey">${esc(t("cloud.keySave"))}</button>
          ${keyed ? `<button class="bs" data-act="clearkey">${esc(t("cloud.keyClear"))}</button>` : ""}
          <button class="bs" data-act="list"${on && keyed ? "" : " disabled"} title="${esc(t("cloud.modelsHint"))}">${esc(t("cloud.list"))}</button>
          <button class="tgl ${on ? "on" : ""}" data-act="toggle" role="switch" aria-checked="${on}" aria-label="${esc(cp.name)}"><span class="k"></span></button>
        </div>
      </div>`;
    }).join("");
    host.innerHTML = `
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.title"))}</b><span>${esc(t("cloud.intro"))}</span></div></div>
      ${providers}
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.cap"))}</b><span>${esc(spend)}</span></div>
        <label class="samp"><small>USD / ${esc(t("cloud.day"))}</small><input id="cloudcap" type="number" min="0" step="0.5" value="${esc(st.cap)}"/></label>
      </div>
      <div class="set-row"><div class="grow"><b>${esc(t("cloud.redact"))}</b><span>${esc(t("cloud.redactHint"))}</span></div>
        <button class="tgl ${st.redact ? "on" : ""}" id="cloudredact" role="switch" aria-checked="${st.redact}"><span class="k"></span></button>
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
          // The provider's suggested model, when it has one, is only a
          // starting point: nothing is sent until the provider is enabled,
          // a key stored and, where needed, a price set.
          [role]: value.startsWith(CLOUD_OPTION)
            ? { kind: "cloud", provider: value.slice(CLOUD_OPTION.length), model: cloudProviderInfo(value.slice(CLOUD_OPTION.length)).suggested }
            : value,
        },
      }));
    } else if (target.dataset.pin || target.dataset.pout) {
      const role = (target.dataset.pin || target.dataset.pout)!;
      const p = d.presets().find((x) => x.id === id);
      const cur = p?.roles[role];
      const row = target.closest<HTMLElement>(".team-price");
      const pin = Number(row?.querySelector<HTMLInputElement>("[data-pin]")?.value);
      const pout = Number(row?.querySelector<HTMLInputElement>("[data-pout]")?.value);
      // Saved once both halves are there: a price with one side is not a price.
      const filled = (x: string | undefined) => x !== undefined && x.trim() !== "";
      if (
        isCloud(cur) && cur.model &&
        filled(row?.querySelector<HTMLInputElement>("[data-pin]")?.value) &&
        filled(row?.querySelector<HTMLInputElement>("[data-pout]")?.value) &&
        Number.isFinite(pin) && Number.isFinite(pout) && pin >= 0 && pout >= 0
      ) {
        void d.cloud.setPrice(cur.provider, cur.model, pin, pout).then(paint, (e: any) => d.toast(String(e?.message ?? e)));
      }
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
    const provider = b.closest<HTMLElement>("[data-provider]")?.dataset.provider ?? "";
    const act = b.dataset.act ?? "";
    try {
      if (b.id === "cloudredact") {
        await d.cloud.setRedact(!b.classList.contains("on"));
      } else if (act === "toggle") {
        await d.cloud.setEnabled(provider, !b.classList.contains("on"));
      } else if (act === "savekey") {
        const input = box.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(provider)}"]`);
        const key = input?.value.trim() ?? "";
        if (!key) return;
        // Cleared from the field before anything else: it is written once,
        // to the Keychain, and must not linger in the DOM.
        if (input) input.value = "";
        await d.cloud.saveKey(provider, key);
        d.toast(t("cloud.keySaved"), "ok");
      } else if (act === "clearkey") {
        await d.cloud.clearKey(provider);
      } else if (act === "list") {
        b.setAttribute("disabled", "");
        const got = await d.cloud.listModels(provider);
        if (got.length) {
          slugs[provider] = got;
          const dl = box.querySelector<HTMLElement>(`#cloudslugs-${CSS.escape(provider)}`);
          if (dl) dl.innerHTML = got.map((x) => `<option value="${esc(x)}"></option>`).join("");
          d.toast(t("cloud.listed").replace("%n", String(got.length)), "ok");
        }
      }
    } catch (e: any) {
      d.toast(String(e?.message ?? e));
    }
    // The cards' fallback state depends on the provider switches and keys,
    // so everything but the catalogue refresh repaints the whole section.
    if (act === "list") await paintCloud();
    else paint();
  };

  paint();
  return box;
}
