// Ce que ce Mac peut demarrer, et comment.
//
// Sorti de lib.rs par NOM et non par banniere: la coupe "decode slots" jusqu'a
// "reading the engine's own words" emportait folder_chooser_tests et
// preview_serving_tests, qui ne planifient rien. Une banniere dit ou une
// section commence, pas ce qui lui appartient.
//
// Ce module ne demarre rien et ne tient aucun etat. Il repond a une question et
// une seule: etant donne cette machine, ce modele et ce que l'utilisateur a
// demande, quelle arene, combien de slots, quelle fenetre, quel micro-batch, et
// est-ce que ca tient. Le cycle de vie du moteur, ses statiques et son compteur
// de generation restent dans lib.rs.
//
// C'est la partie la plus couverte du fichier: huit modules de tests la
// suivent, dont celui qui reproduit le rapport d'un utilisateur sur 24 Go.

use crate::*;

/// The window per slot the user asked for, bounded by what the model can hold.
///
/// Bounded, not obeyed: a number typed into a settings field is a wish, and the
/// two things able to refuse it are the model's training context and, further
/// down, the memory the machine can spare.
pub(crate) fn ctx_per_slot_for(entry: &Value) -> u32 {
    let asked = settings_load()
        .get("engine_ctx")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(CTX_PER_SLOT);
    let model_max = entry["context_length"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(CTX_CEILING_UNKNOWN);
    ctx_within_model(asked, model_max)
}

/// The decision on its own, without the settings read, so a test can reach it.
///
/// The model's own limit wins, including when it is BELOW the default. The
/// previous form raised the ceiling to the default instead of lowering the
/// floor (`model_max.max(CTX_PER_SLOT)`), so OLMoE, trained on 4096, was served
/// 8192: llama.cpp extends the rope, the answers quietly get worse, and that is
/// the exact failure ctx_per_slot_for's own comment says it exists to prevent.
/// The floor only applies where there is room for it.
pub(crate) fn ctx_within_model(asked: u32, model_max: u32) -> u32 {
    let floor = CTX_PER_SLOT.min(model_max);
    asked.clamp(floor, model_max)
}

/// What one decode slot's KV cache costs at a given window.
///
/// KV grows linearly with the window: twice the context, twice the cache. The
/// measured figure is 0.8 GB per slot at 8192 on Qwen3-30B-A3B, so everything
/// else is that number scaled. It is an approximation across models (a model
/// with more layers or fewer grouped KV heads pays differently), and it is the
/// same approximation the slot count already used, now applied to the axis the
/// user can move.
pub(crate) fn kv_bytes_for(ctx_per_slot: u32, slots: u32) -> u64 {
    let per_slot = KV_BYTES_PER_EXTRA_SLOT * u64::from(ctx_per_slot) / u64::from(CTX_PER_SLOT);
    per_slot * u64::from(slots)
}

/// Decode slots to start the engine with (setting "engine_slots", default 2).
///
/// Two is the honest default: it makes a second conversation possible for
/// 0.8 GB, while four costs 2.4 GB for a fan-out the aggregate throughput
/// does not reward on this engine.
pub(crate) fn engine_slots() -> u32 {
    settings_load()
        .get("engine_slots")
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(2)
        .clamp(1, MAX_SLOTS)
}

/// The slot count a start will really use: what the user chose, or what this
/// model on this Mac can afford.
///
/// The flat default of two was the turnkey promise failing quietly. It is the
/// right answer on most Macs and it is 0.8 GB of KV cache taken out of the
/// arena on the Macs that had nothing to give, which is where the modes were
/// stepping down to pay for a second conversation the user had not opened.
///
/// An explicit setting always wins: this replaces a default, not a choice.
pub(crate) fn resolved_slots(entry: &Value, machine: MachineLimits, ram_mode: &str, cpu_moe: bool) -> u32 {
    match settings_load().get("engine_slots").and_then(|s| s.trim().parse::<u32>().ok()) {
        Some(chosen) => chosen.clamp(1, MAX_SLOTS),
        None => recommended_slots(entry, machine, ram_mode, cpu_moe, ctx_per_slot_for(entry)),
    }
}

#[cfg(test)]
mod context_window_tests {
    use super::{kv_bytes_for, CTX_PER_SLOT, KV_BYTES_PER_EXTRA_SLOT};

    #[test]
    fn the_default_window_costs_exactly_what_it_always_did() {
        // Every memory figure in this file was measured at 8192 with the KV of
        // extra slots charged at a flat 0.8 GB. Generalising the axis must not
        // move the number at the point it was measured, or every ceiling in the
        // catalogue shifts under models nobody re-measured.
        for slots in 1..=4u32 {
            assert_eq!(
                kv_bytes_for(CTX_PER_SLOT, slots),
                KV_BYTES_PER_EXTRA_SLOT * u64::from(slots)
            );
        }
    }

    #[test]
    fn kv_grows_with_the_window() {
        // The whole reason the window could not simply be raised: twice the
        // context is twice the cache, and a ceiling that ignored it would admit
        // a configuration the engine then dies inside.
        let one = kv_bytes_for(CTX_PER_SLOT, 1);
        assert_eq!(kv_bytes_for(CTX_PER_SLOT * 16, 1), one * 16);
        assert_eq!(kv_bytes_for(CTX_PER_SLOT * 4, 2), one * 8);
    }

    #[test]
    fn the_planner_actually_charges_for_the_window() {
        use super::{plan_cache, MachineLimits};
        use serde_json::json;
        // THE TEST THAT WAS MISSING. The three above exercise kv_bytes_for on
        // its own, and they all passed while the planner never called it: the
        // helper was written, the call site was lost, and a window setting
        // shipped for a release with a ceiling that ignored it. A unit test of
        // a function proves the function, never that anything uses it.
        let machine = MachineLimits { ram_gb: 64, available: None, gpu_working_set: None };
        let entry = json!({
            "id": "m", "context_length": 262144,
            "non_expert_bytes": 2_000_000_000u64, "expert_bytes_total": 8_000_000_000u64,
            "layers_moe": 24, "record_bytes": 1_000_000u64, "experts_used": 8, "experts": 64,
        });
        let small = plan_cache(&entry, machine, None, "balanced", false, 1, 8192).unwrap();
        let large =
            plan_cache(&entry, machine, None, "balanced", false, 1, 131_072).unwrap();
        assert!(
            large.decision.resident_bytes > small.decision.resident_bytes,
            "a sixteen times larger window must cost more memory, not the same",
        );
    }

    #[test]
    fn a_very_long_window_is_expensive_enough_to_be_refused() {
        // 128k across two slots is 25.6 GB of cache by this estimate. The point
        // of the test is not the figure, it is that the figure is large enough
        // to reach the ceiling instead of slipping under it unnoticed.
        assert!(kv_bytes_for(131_072, 2) > 20_000_000_000);
    }
}

#[cfg(test)]
mod dense_model_tests {
    use super::CTX_PER_SLOT;
    use super::is_dense;
    use serde_json::json;

    #[test]
    fn an_entry_without_the_flag_keeps_the_streaming_path() {
        // Eleven entries predate the flag. Absence must mean MoE, or every one
        // of them would silently lose the engine at the next launch.
        assert!(!is_dense(&json!({"id": "gpt-oss-120b", "experts": 128})));
        assert!(!is_dense(&json!({"dense": false})));
    }

    #[test]
    fn a_declared_dense_entry_skips_the_expert_machinery() {
        assert!(is_dense(&json!({"id": "qwen38-27b", "dense": true})));
    }

    #[test]
    fn a_dense_model_is_installed_as_soon_as_its_weights_are_there() {
        use super::is_installed;
        // There is no pack and there never will be. Requiring one made the
        // model permanently uninstallable: the file was on disk and the card
        // still said no, with no button able to change that.
        assert!(is_installed(true, true, false));
        assert!(!is_installed(true, false, false), "no weights, nothing to run");
    }

    #[test]
    fn an_moe_model_still_needs_its_pack() {
        use super::is_installed;
        // The engine reads experts out of the pack, so weights alone are a job
        // half done and the card must keep offering to finish it.
        assert!(!is_installed(false, true, false));
        assert!(is_installed(false, true, true));
    }

    #[test]
    fn the_backend_gate_lets_a_dense_model_through() {
        use super::require_certified_model;
        use serde_json::json;
        // The gate exists to stop a MODIFIED execution path whose fidelity is
        // unproven. A dense model has no modified path: no experts to
        // substitute, so plain llama.cpp. It was refused here while the webview
        // allowed it, which is the worst shape a policy can take: two gates
        // disagreeing, one of them silently.
        assert!(require_certified_model(&json!({"id": "qwen38-27b", "status": "stock_unmodified"})).is_ok());
    }

    #[test]
    fn the_backend_gate_still_refuses_what_it_always_refused() {
        use super::require_certified_model;
        use serde_json::json;
        assert!(require_certified_model(&json!({"id": "x", "status": "pending_certification"})).is_err());
        assert!(require_certified_model(&json!({"id": "x", "status": "whatever"})).is_err());
        assert!(require_certified_model(&json!({"id": "x"})).is_err());
    }

    #[test]
    fn a_dense_model_is_planned_without_a_measured_geometry() {
        use super::{plan_cache, MachineLimits};
        use serde_json::json;
        // The geometry check is right for an MoE model and was applied to every
        // model. It refused to start a dense one with a message telling the user
        // to install it, which they had: a remedy that cannot work sends someone
        // round a loop instead of naming the problem.
        let machine = MachineLimits { ram_gb: 64, available: None, gpu_working_set: None };
        let entry = json!({"id": "qwen38-27b", "dense": true, "gguf_bytes": 17_100_000_000u64});
        let plan = plan_cache(&entry, machine, None, "balanced", false, 1, CTX_PER_SLOT)
            .expect("a dense model needs no expert geometry");
        assert_eq!(plan.cache_bytes, 0, "there are no experts to cache");
        assert!(!plan.decision.impossible, "17 GB of weights fit in 64 GB");
        // The weights PLUS what the engine costs. This asserted the file size
        // alone, which is the arithmetic that let a 17 GB model onto an 18 GB
        // budget and killed it mid-load.
        assert!(plan.decision.resident_bytes > 17_100_000_000);
    }

    #[test]
    fn a_dense_model_too_big_for_the_machine_is_refused_rather_than_shrunk() {
        use super::{plan_cache, MachineLimits};
        use serde_json::json;
        // An MoE model that does not fit gets a smaller cache. A dense one has
        // nothing to trade away, so this has to be an Err.
        //
        // The first version of this test asserted the `impossible` FLAG and
        // passed while nothing acted on it: server_start, the CLI and the
        // recommendation all branch on Err alone, so the model was started
        // anyway and died mid-graph. A flag nobody reads is not a refusal, and
        // a test that asserts the flag is not a test of the refusal.
        let machine = MachineLimits { ram_gb: 16, available: None, gpu_working_set: None };
        let entry = json!({"id": "big", "dense": true, "gguf_bytes": 400_000_000_000u64});
        let err = plan_cache(&entry, machine, None, "balanced", false, 1, CTX_PER_SLOT)
            .expect_err("a model this size cannot run on 16 GB");
        assert!(err.contains("short by"), "and the missing figure is named: {err}");
    }

    #[test]
    fn a_dense_footprint_counts_more_than_the_file_size() {
        use super::{plan_cache, MachineLimits, DENSE_RUNTIME_OVERHEAD};
        use serde_json::json;
        // The weights are not the footprint. Comparing the file size alone
        // against the budget let a 17 GB model onto an 18 GB budget, where the
        // graph and the KV cache then finished it off mid-load.
        let machine = MachineLimits { ram_gb: 64, available: None, gpu_working_set: None };
        let entry = json!({"id": "m", "dense": true, "gguf_bytes": 17_000_000_000u64,
                           "context_length": 262144});
        let plan = plan_cache(&entry, machine, None, "balanced", false, 1, 8192).unwrap();
        assert!(
            plan.decision.resident_bytes >= 17_000_000_000 + DENSE_RUNTIME_OVERHEAD,
            "the engine costs something even with no experts",
        );
        // And the window is priced here too, not only on the MoE side.
        let wide = plan_cache(&entry, machine, None, "balanced", false, 1, 131_072).unwrap();
        assert!(
            wide.decision.resident_bytes > plan.decision.resident_bytes,
            "a sixteen times larger window costs more on a dense model as well",
        );
    }

    #[test]
    fn a_malformed_flag_falls_back_to_the_safe_answer() {
        // A string where a bool belongs must not read as dense: that would start
        // an MoE model with no streaming layer and no pack, which fails deep
        // inside the graph instead of at the door.
        assert!(!is_dense(&json!({"dense": "true"})));
        assert!(!is_dense(&json!({"dense": 1})));
    }
}

/// Cache sizing: RAM minus non-expert weights minus a system margin, capped at
/// 70% of RAM and at full expert residency. The SLRU protected fraction is
/// then chosen as the largest of 0.75/0.50/0.25 whose probation segment can
/// hold one token's distinct experts (micro-batch 1).
/// Routed-expert geometry: (non_expert, expert_total, moe_layers, record, used,
/// experts). Prefers the profile measured from the real GGUF at install time
/// (models/<id>/profile.json), falls back to the registry, refuses to guess.
///
/// The record size used is the LARGEST class: the layer with the biggest
/// records is the binding constraint on the per-layer slot quota, so planning
/// on it is fail-closed.
pub(crate) fn measured_geometry(entry: &Value) -> Option<(u64, u64, u64, u64, u64, u64)> {
    let id = entry["id"].as_str().unwrap_or_default();
    let profile: Option<Value> = galactus_root()
        .ok()
        .map(|r| r.join("models").join(id).join("profile.json"))
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok());

    if let Some(p) = profile {
        let record = p["layers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|l| l["record_bytes_padded"].as_u64())
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let non_expert = p["totals"]["non_routed_bytes"].as_u64().unwrap_or(0);
        let expert_total = p["totals"]["routed_bytes_padded_pack"].as_u64().unwrap_or(0);
        let layers = p["moe_layer_count"].as_u64().unwrap_or(0);
        let used = p["expert_used_count"].as_u64().unwrap_or(0);
        let experts = p["expert_count"].as_u64().unwrap_or(0);
        if record > 0 && expert_total > 0 && layers > 0 && used > 0 && experts > 0 {
            return Some((non_expert, expert_total, layers, record, used, experts));
        }
    }

    let record = entry["record_bytes"].as_u64()?;
    let expert_total = entry["expert_bytes_total"].as_u64()?;
    let layers = entry["layers_moe"].as_u64()?;
    let used = entry["experts_used"].as_u64()?;
    let experts = entry["experts"].as_u64()?;
    let non_expert = entry["non_expert_bytes"].as_u64()?;
    if record == 0 || expert_total == 0 || layers == 0 || used == 0 || experts == 0 {
        return None;
    }
    Some((non_expert, expert_total, layers, record, used, experts))
}

/// RAM that Galactus never assigns to weights or the expert cache.
///
/// Two decimal GB is enough on 16/24/32 GB machines where every cache byte
/// matters. Above that, Macs also tend to run a larger working set (IDE,
/// browser, build tools), so the reserve scales to 6.25% of unified memory:
/// 4 GB on a 64 GB Mac and 8 GB on a 128 GB Mac.
///
/// A guess about a machine nobody has measured, and it is only half the
/// answer: see engine_budget_bytes, where the reserve is one of two bounds and
/// the other one reads what the Mac can actually give right now.
pub(crate) fn system_reserve_bytes(ram: u64) -> u64 {
    2_000_000_000u64.max(ram / 16)
}

#[cfg(test)]
mod system_reserve_tests {
    use super::system_reserve_bytes;

    #[test]
    fn reserve_keeps_small_macs_viable_and_scales_on_large_macs() {
        assert_eq!(system_reserve_bytes(16_000_000_000), 2_000_000_000);
        assert_eq!(system_reserve_bytes(32_000_000_000), 2_000_000_000);
        assert_eq!(system_reserve_bytes(64_000_000_000), 4_000_000_000);
        assert_eq!(system_reserve_bytes(128_000_000_000), 8_000_000_000);
    }
}

pub(crate) fn engine_budget_bytes(installed: u64, limits: MachineLimits) -> u64 {
    // Properties of the hardware, so they stay on installed RAM: never more
    // than 70 percent of the Mac, and never so much that the system reserve is
    // eaten. Both bound the TOTAL, which is the fix in defect 1.
    let mut bound =
        (installed * 7 / 10).min(installed.saturating_sub(system_reserve_bytes(installed)));
    // THE BOUND THE ALLOCATOR ACTUALLY ANSWERS TO, and the one nothing here
    // ever read.
    //
    // The expert arena is host memory (posix_memalign, h4-expert-store.cpp),
    // and llama.cpp hands it to Metal with newBufferWithBytesNoCopy under
    // MTLResourceStorageModeShared, then puts every buffer in an
    // MTLResidencySet and calls requestResidency (ggml-metal-device.m:1621 and
    // :1470, residency sets on by default from macOS 15, :827). The residency
    // is what wires the pages, measured: a 4 GiB shared buffer fully written
    // by the CPU moves vm_stat's wired count by 30 MiB, and requestResidency
    // on the same buffer moves it by the whole 4 GiB. What bounds that is
    // recommendedMaxWorkingSetSize, which llama.cpp treats as the total GPU
    // memory itself: it answers `free = recommended - currentAllocated`
    // (:1043).
    //
    // A BUDGET, NOT A GATE, so it is used as one. Apple calls it "an
    // approximation of how much memory this GPU device can allocate without
    // affecting its runtime performance" and asks callers to keep the total
    // footprint below it. Nothing refuses past it: llama.cpp only LOGS
    // (:1427), inside `#ifndef GGML_METAL_NDEBUG`, so a release build prints
    // nothing; the allocation then either succeeds and the machine pays in
    // swap, or newBufferWithBytesNoCopy returns nil and the backend buffer
    // fails (:1626). Apple documents no macOS OOM kill, fault or panic at all,
    // and the outcome reported in practice is the swap spiral rather than a
    // clean failure. Neither reaches the user as a sentence about memory. That
    // is what "it crashed twice" looked like from outside.
    //
    // NOT scaled by a fraction. 70 percent, the system reserve and the four
    // fifths of the live reading are already three separate cushions, and
    // recommendedMaxWorkingSetSize is itself macOS leaving headroom (107.5 of
    // 128 GiB on the machine this was written on, 84 percent). A fourth
    // invented fraction on top would be the same guessed constant this whole
    // change exists to remove.
    //
    // COMPUTED NOWHERE. The formula the internet quotes for this limit comes
    // from a 2023 decompilation of AGXAccelerator on a Ventura beta: reserve a
    // third below 32 GiB of unified memory, a quarter above. It already
    // disagrees with the hardware. On this machine it predicts 96.00 GiB and
    // the device answers 107.52. The API is read; no formula is kept.
    //
    // `None` falls through untouched: a machine with no Metal device is no
    // worse off than before, and a probe that failed must never make the app
    // refuse to start.
    if let Some(working_set) = limits.gpu_working_set {
        bound = bound.min(working_set);
    }
    match limits.available {
        None => bound,
        Some(free) => {
            bound.min(free.saturating_mul(AVAILABLE_CLAIM_NUM) / AVAILABLE_CLAIM_DEN)
        }
    }
}

#[cfg(test)]
mod engine_budget_tests {
    use super::{engine_budget_bytes, MachineLimits};

    const GB: u64 = 1_000_000_000;

    /// A machine with no Metal reading: what every test asserted before the
    /// GPU working set became a bound.
    fn ram_only(available: Option<u64>) -> MachineLimits {
        MachineLimits { ram_gb: 0, available, gpu_working_set: None }
    }

    #[test]
    fn without_a_reading_the_budget_is_the_hardware_bound() {
        // 70 percent of the Mac, and it bounds the TOTAL resident footprint.
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(None)), 16_800_000_000);
        assert_eq!(engine_budget_bytes(128 * GB, ram_only(None)), 89_600_000_000);
    }

    #[test]
    fn a_busy_mac_gets_a_budget_from_what_is_free_not_from_what_it_was_sold_with() {
        // The colleague's 24 GB Mac with a browser open: 9 GB actually free.
        // The old planner offered 16.8 GB anyway; four fifths of 9 is 7.2.
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(Some(9 * GB))), 7_200_000_000);
    }

    #[test]
    fn an_idle_mac_is_still_bounded_by_its_hardware() {
        // 22 GB free of 24 installed. Four fifths would be 17.6, more than the
        // 70 percent bound: the hardware bound must still win, or the engine
        // would fill a freshly booted Mac to the brim.
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(Some(22 * GB))), 16_800_000_000);
    }

    #[test]
    fn a_machine_with_nothing_free_offers_nothing() {
        assert_eq!(engine_budget_bytes(24 * GB, ram_only(Some(0))), 0);
    }

    #[test]
    fn the_gpu_working_set_bounds_the_budget_when_it_is_the_tightest_of_the_three() {
        // The 24 GB Mac that crashed. Idle, so the live reading gives the
        // planner 16.8 GB, and Metal will let the process keep 15 GB resident.
        // Planning 16.8 GB of Metal buffers on a device that recommends 15 is
        // the over-commit nothing reports: either swap, or a nil buffer and a
        // backend failure the user reads as a crash.
        let m = MachineLimits {
            ram_gb: 24,
            available: Some(22 * GB),
            gpu_working_set: Some(15 * GB),
        };
        assert_eq!(engine_budget_bytes(24 * GB, m), 15 * GB);
    }

    #[test]
    fn a_generous_gpu_limit_never_widens_the_budget() {
        // The M5 Max this was written on: 128 GiB installed, Metal recommends
        // 107.5 GB. The 70 percent bound is 89.6 and must still win, or the
        // engine would fill the machine because the GPU said it could.
        let m = MachineLimits {
            ram_gb: 128,
            available: None,
            gpu_working_set: Some(115_448_725_504),
        };
        assert_eq!(engine_budget_bytes(128 * GB, m), 89_600_000_000);
    }

    #[test]
    fn a_mac_with_no_metal_device_is_no_worse_off_than_before() {
        // Headless CI, or a VM. A failed probe must never refuse a start.
        let with = MachineLimits { ram_gb: 24, available: Some(9 * GB), gpu_working_set: None };
        assert_eq!(engine_budget_bytes(24 * GB, with), 7_200_000_000);
    }
}

/// Choose the footprint mode to START in.
///
/// Pure: (budget in bytes, model geometry, requested mode) in, decision out.
/// No clock, no filesystem, no machine, so every shape that matters can be
/// tested instead of only the shape the developer's Mac happens to have.
///
/// A DECISION, not a retry. The engine cannot be asked politely whether a
/// graph will fit: llama_decode either runs it or returns below -1 and the
/// user reads "Compute error." with nothing pointing at memory. So the
/// comparison happens before anything is spawned.
///
/// The ladder is walked DOWNWARDS from what the user asked for, never upwards.
/// A user who chose eco gets eco on every machine: the automatic part of this
/// is a safety net, not an opinion about what the user wanted.
pub(crate) fn choose_start_mode(budget: u64, footprints: ModeFootprints, requested: &str) -> ModeDecision {
    // An unrecognised mode is treated as balanced, which is what the settings
    // reader already defaults to.
    let start = MODE_LADDER.iter().position(|m| *m == requested).unwrap_or(1);
    let requested = MODE_LADDER[start];
    for mode in &MODE_LADDER[start..] {
        let resident = footprints.resident(mode);
        if resident <= budget {
            return ModeDecision {
                mode: (*mode).to_string(),
                requested: requested.to_string(),
                impossible: false,
                resident_bytes: resident,
                budget_bytes: budget,
            };
        }
    }
    ModeDecision {
        mode: "eco".to_string(),
        requested: requested.to_string(),
        impossible: true,
        resident_bytes: footprints.eco,
        budget_bytes: budget,
    }
}

#[cfg(test)]
mod choose_start_mode_tests {
    use super::{choose_start_mode, ModeFootprints};

    const GB: u64 = 1_000_000_000;

    /// Roughly GLM-4.5-Air on a 24 GB Mac: 6 GB of non-expert weights plus
    /// overhead, then an arena that grows with the mode.
    fn footprints() -> ModeFootprints {
        ModeFootprints { eco: 8 * GB, balanced: 13 * GB, perf: 17 * GB }
    }

    #[test]
    fn an_idle_mac_starts_in_the_mode_the_user_asked_for() {
        let d = choose_start_mode(17 * GB, footprints(), "perf");
        assert_eq!(d.mode, "perf");
        assert_eq!(d.requested, "perf");
        assert!(!d.impossible);
        assert_eq!(d.resident_bytes, 17 * GB);
    }

    #[test]
    fn a_busy_mac_steps_down_to_the_mode_that_fits_and_says_which() {
        // 12 GB to give: perf does not fit, balanced does not fit, eco does.
        let d = choose_start_mode(12 * GB, footprints(), "perf");
        assert_eq!(d.mode, "eco");
        assert_eq!(d.requested, "perf");
        assert!(!d.impossible);
        assert_eq!(d.resident_bytes, 8 * GB);
        assert_eq!(d.budget_bytes, 12 * GB);
    }

    #[test]
    fn the_step_is_one_rung_when_one_rung_is_enough() {
        // The whole point of a ladder rather than a straight fall to eco: a
        // machine that can afford balanced is not punished with eco.
        let d = choose_start_mode(13 * GB, footprints(), "perf");
        assert_eq!(d.mode, "balanced");
    }

    #[test]
    fn the_ladder_never_climbs() {
        // A user who chose eco keeps eco on a machine that could hold perf.
        let d = choose_start_mode(64 * GB, footprints(), "eco");
        assert_eq!(d.mode, "eco");
        assert_eq!(d.resident_bytes, 8 * GB);
    }

    #[test]
    fn nothing_fitting_is_reported_as_impossible_rather_than_started_anyway() {
        // This is the case that used to become "Compute error." after the
        // user had already typed a message and waited.
        let d = choose_start_mode(5 * GB, footprints(), "balanced");
        assert!(d.impossible);
        assert_eq!(d.mode, "eco");
        assert_eq!(d.resident_bytes, 8 * GB);
        assert_eq!(d.budget_bytes, 5 * GB);
    }

    #[test]
    fn an_unknown_mode_is_read_as_balanced() {
        let d = choose_start_mode(64 * GB, footprints(), "turbo");
        assert_eq!(d.mode, "balanced");
        assert_eq!(d.requested, "balanced");
    }
}

/// Plan the cache, with the context window passed in.
///
/// The window is a PARAMETER and not a settings read, and that is deliberate.
/// The first version read `engine_ctx` in here, which made every memory figure
/// this function produces depend on the settings file of whoever ran it: the
/// test suite started failing on a machine whose owner had picked 32k in the
/// UI, having passed on every other machine. A planner is arithmetic; it must
/// answer the same question the same way everywhere.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_cache(
    entry: &Value,
    machine: MachineLimits,
    override_gb: Option<u64>,
    ram_mode: &str,
    cpu_moe_regime: bool,
    slots: u32,
    ctx_per_slot: u32,
) -> Result<CachePlan, String> {
    let ram_gb = machine.ram_gb;
    // Hard gate, mirrored by the UI card: below the registry minimum the
    // engine cannot hold the non-expert weights plus a viable cache, so the
    // model is refused everywhere (app start, CLI serve), not just greyed out.
    if let Some(min) = entry["min_ram_gb"].as_u64() {
        if ram_gb < min {
            return Err(format!(
                "this model needs at least {min} GB of RAM, this Mac has {ram_gb} GB"
            ));
        }
    }
    // Physical geometry. The install pipeline measures it from the actual GGUF
    // (moe-profile.py writes models/<id>/profile.json), so that file is the
    // truth and the registry only a pre-install estimate. Missing everywhere is
    // a hard error: the old defaults (record 1 byte, experts 256) made the
    // probation guard below fictional and the engine aborted at the first
    // micro-batch with "free list a sec".
    // A dense model has no geometry to measure and no cache to plan. There are
    // no experts, so nothing is streamed and nothing is cached: the weights are
    // resident from the first token, exactly as any other runtime would load
    // them. Everything below this point sizes an expert cache and would have
    // nothing to size.
    //
    // The check underneath is right for a Mixture-of-Experts model and was
    // applied to every model: it refused to start a dense one and told the user
    // to install it, which they had, and installing it again would have changed
    // nothing. A message that names a remedy that cannot work is worse than an
    // error, because it sends someone round a loop.
    if is_dense(entry) {
        let weights = entry["gguf_bytes"].as_u64().unwrap_or(0);
        let budget = engine_budget_bytes(ram_gb * 1_000_000_000, machine);
        // The weights are not the footprint. A dense model pays the same graph,
        // the same compute buffers and the same KV cache as any other, and the
        // first version of this branch compared the file size alone against the
        // budget: a 17 GB model on an 18 GB budget was declared to fit and then
        // died mid-graph, which is exactly the failure the MoE side of this
        // planner was rewritten to end.
        let kv = kv_bytes_for(ctx_per_slot, slots);
        let resident = weights + DENSE_RUNTIME_OVERHEAD + kv;
        if resident > budget {
            // Refused HERE, not reported in a flag. The MoE branch below returns
            // Err with the missing figure, and every caller acts on Err and on
            // nothing else: server_start, the CLI and the recommendation all
            // ignored `impossible`, so a dense model too big for the machine was
            // started anyway. A flag nobody reads is not a refusal.
            return Err(format!(
                "not enough free memory to start this model right now: it needs {:.1} GB \
                 (weights, engine and a {} token window), this Mac can spare {:.1} GB, short by \
                 {:.1} GB. Quit an application, or lower the context window in Settings, then \
                 start it again.",
                resident as f64 / 1e9,
                ctx_per_slot,
                budget as f64 / 1e9,
                resident.saturating_sub(budget) as f64 / 1e9,
            ));
        }
        return Ok(CachePlan {
            cache_bytes: 0,
            protected: 0.0,
            // The same 512 a fully resident MoE model gets. The small
            // micro-batch exists to bound how many distinct experts one batch
            // can touch, and this model touches none.
            ubatch: 512,
            decision: ModeDecision {
                mode: ram_mode.to_string(),
                requested: ram_mode.to_string(),
                // Nothing can be traded away: there is no cache to shrink, so
                // either it fits or the model cannot run here, and the branch
                // above has already refused the second case.
                impossible: false,
                resident_bytes: resident,
                budget_bytes: budget,
            },
        });
    }
    let geo = measured_geometry(entry);
    let (non_expert, expert_total, layers, record, used, experts) = match geo {
        Some(g) => g,
        None => {
            return Err(
                "this model has no measured geometry yet (record size, expert bytes): \
                 install it so the engine profile is generated before starting it"
                    .into(),
            )
        }
    };

    let ram = ram_gb * 1_000_000_000;
    // Ceiling: what the machine can afford at most.
    //
    // The engine's resident memory is the arena plus the non-expert weights
    // plus a third term nothing accounted for: KV cache, compute buffers and
    // the graph. A flat 4.5 GB used to stand for it and was wrong in the one
    // direction that hurts, too small. Measured resident footprint minus arena
    // minus weights, at ctx 8192: 3.2 GB for Qwen3-Next-80B, 3.4 for
    // Qwen3-30B, 3.7 for gpt-oss-120b, 4.0 for GLM-4.5-Air, 4.5 for Llama-4
    // Scout, 7.6 for GLM-5.2 744B. It tracks the non-expert weights, which is
    // expected since both grow with layer count and hidden size. The affine
    // fit below rounds UP on every measured point except the two extremes it
    // interpolates exactly, so the ceiling errs toward leaving memory free.
    //
    // On top of that, the machine still has to run macOS and whatever the user
    // is doing. Without that reserve the planner filled the machine to the
    // brim: GLM-4.5-Air on a 24 GB Mac reached 23.5 GB resident and generated
    // at 1.5 tok/s, Llama-4 Scout on the same Mac exceeded it outright.
    //
    // The fit was measured at ctx 8192, which is ONE decode slot, and the
    // engine is started with --ctx-size CTX_PER_SLOT * slots. The extra slots
    // are KV cache and nothing else: 0.8 GB each, measured on Qwen3-30B-A3B
    // (29.6 GB resident at 1 slot, 30.4 at 2, 32.0 at 4). The default is two
    // slots, so the ceiling was quietly 0.8 GB optimistic on every machine,
    // and 2.4 GB on a user who asked for four.
    // The measured fit already contains ONE slot at the DEFAULT window, so only
    // what exceeds that is added here. At 8192 this is exactly the flat figure
    // it always was, 0.8 GB per slot past the first; at a larger window it
    // grows with the window, because the cache does.
    //
    // This wiring was written once and silently lost: the helper stayed, the
    // call site did not, and the unit tests kept passing because they exercise
    // the helper in isolation. A window setting shipped for one release with a
    // ceiling that ignored it, which is how a user picks 128k and the engine
    // dies mid-graph on a cache nobody counted.
    let kv_extra = kv_bytes_for(ctx_per_slot, slots).saturating_sub(KV_BYTES_PER_EXTRA_SLOT);
    let runtime_overhead = 2_500_000_000 + non_expert * 45 / 100 + kv_extra;
    // Everything the engine pays before a single expert byte is cached.
    let fixed = non_expert + runtime_overhead;

    // TWO ceilings, and they answer two different questions.
    //
    // The HARDWARE ceiling is what this Mac could give if nothing else were
    // running, and it is what the three modes are DEFINED against: eco has to
    // mean the same footprint whether or not a browser is open, otherwise the
    // mode names would describe the weather rather than a policy.
    //
    // The 70 percent cap inside it used to bound the ARENA, with the weights
    // and the runtime overhead added on top, so a bound that reads "never take
    // more than 70 percent of this Mac" delivered 90. On a 24 GB Mac five of
    // the seven eligible models planned about 22 GB resident, leaving two for
    // macOS, for this app and its webview, and for everything the user had
    // open. It now bounds what it claims to bound, the TOTAL, and the arena is
    // what is left of the budget once the weights and the overhead are paid.
    // The GPU working set stays in BOTH budgets, unlike the live reading: it
    // is a property of the device, not of the moment, so a mode has to mean
    // the same footprint whether or not a browser is open AND has to be a
    // footprint Metal will actually hold.
    let hardware_budget =
        engine_budget_bytes(ram, MachineLimits { available: None, ..machine });
    let ceiling_cache = hardware_budget.saturating_sub(fixed).min(expert_total);

    // The LIVE budget is what the machine can give right now, and it is the one
    // the decision is taken against. Before this, nothing in the planner ever
    // looked at a number that could change after the Mac left the factory.
    let live_budget = engine_budget_bytes(ram, machine);

    // Memory-footprint policy over the registry's MEASURED curve. The point
    // of Galactus on a machine where the model would fit natively is to run
    // it in a FRACTION of the RAM, not to hoard it:
    // - eco:      smallest measured cache (minimum viable footprint)
    // - balanced: full residency when this machine can afford it, otherwise
    //             the knee, i.e. the smallest measured cache reaching >= 90%
    //             of the best generation throughput reachable here
    // - perf:     the full planning ceiling
    let measured: Vec<(f64, f64)> = entry["measured"]
        .as_array()
        .map(|a| {
            let mut v: Vec<(f64, f64)> = a
                .iter()
                .filter_map(|p| {
                    Some((p["cache_gb"].as_f64()?, p["gen_tps"].as_f64()?))
                })
                .collect();
            v.sort_by(|x, y| x.0.total_cmp(&y.0));
            v
        })
        .unwrap_or_default();
    // `ceiling` is the largest cache the mode may reach. It is the HARDWARE
    // ceiling, not the live one: the three modes have to keep meaning the same
    // thing from one minute to the next, and it is the step-down, not a silent
    // shrinking of every mode, that answers a machine under pressure.
    let policy_cache = |mode: &str, ceiling: u64| -> u64 {
        if measured.is_empty() {
            // No benchmark curve for this entry: eco/balanced would silently
            // become "take the whole ceiling", the exact opposite of the
            // footprint promise. Fall back to the registry's minimum viable
            // cache, and only perf climbs to the ceiling.
            let floor = entry["min_cache_bytes"].as_u64().unwrap_or(0);
            return if mode == "perf" || floor == 0 { ceiling } else { floor.min(ceiling) };
        }
        match mode {
            // Clamped, like the no-curve branch above already was. A measured
            // point is a number from a bigger machine, not a promise this one
            // can keep: a model whose only measurement is a 92 GB cache made eco
            // ask for MORE than perf, so the step-down walked toward a heavier
            // footprint and never reached anything that fitted. The user saw an
            // installable card, downloaded 202 GB, and then could not start it
            // on any Mac.
            "eco" => ((measured[0].0 * 1e9) as u64).min(ceiling),
            "perf" => ceiling,
            _ => {
                // Full residency first, when the ceiling already reaches every
                // routed expert byte. The knee optimizes GENERATION throughput
                // per byte of RAM, and it was the right criterion until
                // residency became a step change in PROMPT throughput: a
                // resident cache never evicts, so the physical micro-batch
                // jumps from a handful of tokens to llama.cpp's standard 512.
                // RAM left unused buys nothing, whereas minutes of waiting
                // before the first token are paid on every single message.
                // eco stays the explicit minimum-footprint mode, and a machine
                // that cannot hold the experts still falls through to the knee
                // below, streamed regime untouched.
                if ceiling >= expert_total {
                    return ceiling;
                }
                // Best throughput reachable within the ceiling, then the
                // smallest cache reaching 90% of it.
                let reachable = measured
                    .iter()
                    .filter(|(c, _)| (*c * 1e9) as u64 <= ceiling)
                    .map(|(_, t)| *t)
                    .fold(measured[0].1, f64::max);
                for (c, t) in &measured {
                    if *t >= 0.9 * reachable {
                        return ((*c * 1e9) as u64).min(ceiling);
                    }
                }
                ceiling
            }
        }
    };

    // THE DECISION, taken before anything is spawned. What each mode would
    // hold, against what the machine can actually give right now.
    let footprints = ModeFootprints {
        eco: fixed + policy_cache("eco", ceiling_cache),
        balanced: fixed + policy_cache("balanced", ceiling_cache),
        perf: fixed + policy_cache("perf", ceiling_cache),
    };
    let mut decision = choose_start_mode(live_budget, footprints, ram_mode);
    if decision.impossible {
        if override_gb.is_none() {
            // The missing figure, named. "Not enough memory" without a number
            // leaves a user guessing how much to close, which is the same
            // helplessness as "Compute error." wearing better clothes.
            return Err(format!(
                "not enough free memory to start this model right now: its smallest footprint \
                 (eco) needs {:.1} GB, this Mac can spare {:.1} GB, short by {:.1} GB. Quit an \
                 application, or close some browser tabs, then start it again.",
                footprints.eco as f64 / 1e9,
                live_budget as f64 / 1e9,
                footprints.eco.saturating_sub(live_budget) as f64 / 1e9,
            ));
        }
        // An explicit cache size is the user overruling the policy. The clamp
        // below and the quota gate are then the only guards left, which is
        // what an override is for.
        decision.impossible = false;
    }

    // The arena this start actually gets: the chosen mode's cache, never more
    // than the live budget leaves free.
    let max_cache = live_budget.saturating_sub(fixed).min(expert_total);
    let mut cache = match override_gb {
        Some(gb) => gb * 1_000_000_000,
        None => policy_cache(&decision.mode, ceiling_cache),
    };
    cache = cache.min(max_cache).min(expert_total);
    // `decision.resident_bytes` deliberately keeps the CHOSEN MODE's own
    // footprint, not `fixed + cache`. The two are equal whenever the decision
    // was sound, since a mode that fits the budget has a cache that fits
    // `max_cache`; overwriting it would make the clamp above silently repair a
    // wrong decision and hide it from every assertion. The clamp stays as a
    // belt, never as the thing that makes the number true.
    //
    // An explicit override is the one case where the decision did not pick the
    // size, so there the reported figure is what the engine will really hold.
    if override_gb.is_some() {
        decision.resident_bytes = fixed + cache;
    }

    let quota = (cache / (layers * record)).min(experts);
    if quota < 2 {
        return Err(format!(
            "not enough memory for this model right now: the arena would be {:.1} GB, too small \
             to hold two experts per layer. This Mac can spare {:.1} GB in total and the weights \
             alone need {:.1} GB.",
            cache as f64 / 1e9,
            live_budget as f64 / 1e9,
            fixed as f64 / 1e9,
        ));
    }
    for f in [0.75f64, 0.50, 0.25] {
        let mut protected = (quota as f64 * f) as u64;
        protected = protected.clamp(1, quota - 1);
        let probation = quota - protected;
        if probation >= used {
            // STREAMED regime: the largest physical micro-batch whose distinct
            // experts fit in the probation segment, probation / experts_used,
            // capped at 8. A cold batch inserts only into probation, so beyond
            // that bound it would evict its own members.
            //
            // FULL RESIDENCY: every expert owns a permanent slot, the cache
            // stops evicting (h4-expert-cache.cpp) and nothing constrains the
            // micro-batch, so take llama.cpp's standard 512. Prompt processing
            // measured 5 to 13 times faster.
            //
            // The numerics are verified AT that shape, not assumed: the parity
            // probe now sweeps 11 quant types x 13 token counts from 1 to 512 x
            // both projection shapes the MoE block emits, 286 cases, every bit
            // identical to the CPU path. An earlier perplexity table seemed to
            // show the kernels failing past micro-batch 32; the flaw was in the
            // instrument, since llama.cpp pulls mul_mat_id back onto the GPU at
            // batch 32 (op_offload_min_batch_size), so --n-cpu-moe stopped
            // being a CPU reference exactly there.
            //
            // The cross-check regime keeps the small micro-batch: it exists to
            // recompute experts on CPU, not to be fast, and llama.cpp asserts
            // out of bounds on that path at 512.
            let ubatch = if cache >= expert_total && !cpu_moe_regime {
                512u32
            } else {
                (probation / used).clamp(1, 8) as u32
            };
            return Ok(CachePlan { cache_bytes: cache, protected: f, ubatch, decision });
        }
    }
    Err(format!(
        "not enough memory for this model right now: the arena would be {:.1} GB, too small to \
         keep one token's active experts on probation. This Mac can spare {:.1} GB in total.",
        cache as f64 / 1e9,
        live_budget as f64 / 1e9,
    ))
}

/// How many conversations may generate at once, for THIS model on THIS Mac.
///
/// The app shipped a flat default of two. Two slots cost 0.8 GB taken out of
/// the arena of every model on every Mac, whether or not the machine had it,
/// and on a 24 GB Mac 0.8 GB is exactly the difference between a mode that
/// fits and a mode that does not.
///
/// THE RULE: a second conversation must never cost the user a footprint mode.
/// The count is the largest n up to the cap for which the mode the user asked
/// for still starts, and 1 when even that does not hold.
/// How many decode slots to start with.
///
/// The window is a parameter for the same reason it is one on `plan_cache`:
/// this function prices a second KV cache, the price depends on the window, and
/// reading the setting in here made the answer depend on the settings file of
/// whoever ran the test suite.
pub(crate) fn recommended_slots(
    entry: &Value,
    machine: MachineLimits,
    ram_mode: &str,
    cpu_moe: bool,
    ctx_per_slot: u32,
) -> u32 {
    for n in (2..=RECOMMENDED_SLOT_CAP).rev() {
        match plan_cache(entry, machine, None, ram_mode, cpu_moe, n, ctx_per_slot) {
            Ok(plan) if plan.decision.mode == plan.decision.requested => return n,
            _ => continue,
        }
    }
    1
}

/// Which volume layout to preselect, from volumes that have been measured.
///
/// Dual is the point of the pack format: both volumes are read in parallel, so
/// a record is ready when the slower side finishes, and `pack_split_ratio`
/// cuts each record at r* = Bi / (Bi + Be) so the two finish together. It is
/// therefore preferred whenever a second volume is fast enough to be worth
/// reading from and both sides have room for their shares.
///
/// Single wins when there is one volume, when the second is under
/// `DUAL_BANDWIDTH_FLOOR` of the first, when the second has not been measured,
/// or when the shares do not fit but the whole pack does.
pub(crate) fn recommend_layout(volumes: &[PackVolume], pack_bytes: u64) -> PackLayout {
    // Fastest first. An unmeasured volume sorts last rather than being
    // treated as slow: it may well be the fastest, nobody asked it yet.
    let mut ranked: Vec<&PackVolume> = volumes.iter().collect();
    ranked.sort_by(|a, b| {
        b.bandwidth_gbs
            .unwrap_or(-1.0)
            .total_cmp(&a.bandwidth_gbs.unwrap_or(-1.0))
            .then(b.free_bytes.cmp(&a.free_bytes))
    });

    let fits_whole = |v: &PackVolume| v.free_bytes >= pack_bytes + PACK_VOLUME_RESERVE;

    // Dual first: the best pair by aggregate bandwidth whose shares both fit.
    let mut best: Option<(f64, &PackVolume, &PackVolume)> = None;
    for (i, fast) in ranked.iter().enumerate() {
        for slow in ranked.iter().skip(i + 1) {
            let (Some(bi), Some(be)) = (fast.bandwidth_gbs, slow.bandwidth_gbs) else { continue };
            if bi <= 0.0 || be < DUAL_BANDWIDTH_FLOOR * bi {
                continue;
            }
            // The real cut, the one the packer and the engine will both use.
            let ratio = pack_split_ratio(bi, be);
            let share_fast = (pack_bytes as f64 * ratio) as u64;
            let share_slow = pack_bytes.saturating_sub(share_fast);
            if fast.free_bytes < share_fast + PACK_VOLUME_RESERVE
                || slow.free_bytes < share_slow + PACK_VOLUME_RESERVE
            {
                continue;
            }
            let aggregate = bi + be;
            if best.map(|(a, _, _)| aggregate > a).unwrap_or(true) {
                best = Some((aggregate, fast, slow));
            }
        }
    }
    if let Some((_, fast, slow)) = best {
        return PackLayout::Dual { internal: fast.mount.clone(), external: slow.mount.clone() };
    }

    match ranked.iter().find(|v| fits_whole(v)) {
        Some(v) => PackLayout::Single { mount: v.mount.clone() },
        None => PackLayout::NoRoom,
    }
}

/// Which quantization to offer for download, for THIS model on THIS Mac.
///
/// # The registry key
///
/// ```json
/// "variants": [
///   { "id": "Q8_0",   "min_ram_gb": 64, "gguf_bytes": 79000000000, "download": { ... } },
///   { "id": "Q4_K_M", "min_ram_gb": 32, "gguf_bytes": 45000000000, "download": { ... } },
///   { "id": "IQ2_XXS","min_ram_gb": 16, "gguf_bytes": 23000000000, "download": { ... } }
/// ]
/// ```
///
/// Absent, which is every entry today, this returns `None` and the caller uses
/// the entry's single `download` block: today's behaviour, unchanged, so the
/// key can be added one model at a time while the campaign is running.
///
/// # The rule
///
/// The largest variant this Mac can hold: highest `gguf_bytes` among those
/// whose `min_ram_gb` the machine meets. Judged on INSTALLED RAM and never on
/// the live reading. A download is not a start: a browser tab open at download
/// time must not condemn the user to a smaller model for the life of the
/// install, and the mode ladder is what answers a machine under pressure.
pub(crate) fn recommend_variant(entry: &Value, ram_gb: u64) -> Option<String> {
    let variants = entry["variants"].as_array()?;
    variants
        .iter()
        .filter(|v| v["min_ram_gb"].as_u64().map(|min| ram_gb >= min).unwrap_or(false))
        .max_by_key(|v| v["gguf_bytes"].as_u64().unwrap_or(0))
        .and_then(|v| v["id"].as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod recommendation_tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    fn vol(mount: &str, free_gb: u64, bw: Option<f64>) -> PackVolume {
        PackVolume { mount: mount.into(), free_bytes: free_gb * GB, bandwidth_gbs: bw }
    }

    #[test]
    fn one_volume_carries_the_whole_pack() {
        let v = vec![vol("/", 200, Some(6.0))];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Single { mount: "/".into() }
        );
    }

    #[test]
    fn a_second_volume_fast_enough_to_read_from_is_used() {
        // Two decent SSDs: reading both in parallel is what the pack format
        // is for, and the user had to discover it by choosing dual by hand.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/T7", 200, Some(3.0))];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Dual { internal: "/".into(), external: "/Volumes/T7".into() }
        );
    }

    #[test]
    fn a_second_volume_too_slow_to_be_worth_reading_is_left_alone() {
        // 1.0 against 6.0 is under the 35 percent floor the install pipeline
        // already falls back on. Splitting there makes every record wait on
        // the slow side.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/USB2", 200, Some(1.0))];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Single { mount: "/".into() }
        );
    }

    #[test]
    fn an_unmeasured_volume_is_never_made_half_of_a_split() {
        // The split ratio is computed FROM the two bandwidths. Guessing one
        // writes a pack cut at the wrong place for the life of the install.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/T7", 200, None)];
        assert_eq!(
            recommend_layout(&v, 60 * GB),
            PackLayout::Single { mount: "/".into() }
        );
    }

    #[test]
    fn a_pack_too_big_for_either_volume_alone_is_split_across_both() {
        // 300 GB of experts, two 200 GB volumes. Single is impossible and
        // dual is the only thing that installs at all.
        let v = vec![vol("/", 200, Some(6.0)), vol("/Volumes/T7", 200, Some(5.0))];
        assert_eq!(
            recommend_layout(&v, 300 * GB),
            PackLayout::Dual { internal: "/".into(), external: "/Volumes/T7".into() }
        );
    }

    #[test]
    fn the_faster_volume_takes_the_larger_share() {
        // Order matters: `internal` is the side pack_split_ratio gives r* to.
        let v = vec![vol("/Volumes/T7", 400, Some(3.0)), vol("/", 400, Some(6.0))];
        assert_eq!(
            recommend_layout(&v, 100 * GB),
            PackLayout::Dual { internal: "/".into(), external: "/Volumes/T7".into() }
        );
    }

    #[test]
    fn a_machine_with_nowhere_to_put_it_says_so_instead_of_choosing_a_volume() {
        let v = vec![vol("/", 20, Some(6.0)), vol("/Volumes/T7", 20, Some(5.0))];
        assert_eq!(recommend_layout(&v, 300 * GB), PackLayout::NoRoom);
        assert_eq!(recommend_layout(&[], 60 * GB), PackLayout::NoRoom);
    }

    #[test]
    fn the_reserve_is_kept_on_every_volume_a_share_lands_on() {
        // Exactly the pack and not a byte more is not enough: the 2 GiB
        // reserve is what keeps macOS able to work on the volume.
        let tight = vec![vol("/", 60, Some(6.0))];
        assert_eq!(recommend_layout(&tight, 60 * GB), PackLayout::NoRoom);
        let ok = vec![vol("/", 63, Some(6.0))];
        assert_eq!(recommend_layout(&ok, 60 * GB), PackLayout::Single { mount: "/".into() });
    }

    /// A model with three published quantizations. The ids are the shape the
    /// registry key would carry, not a real entry: no registry file is read.
    fn three_variants() -> Value {
        json!({
            "id": "variant-test-fixture",
            "variants": [
                { "id": "IQ2_XXS", "min_ram_gb": 16, "gguf_bytes": 23_000_000_000u64 },
                { "id": "Q4_K_M",  "min_ram_gb": 32, "gguf_bytes": 45_000_000_000u64 },
                { "id": "Q8_0",    "min_ram_gb": 64, "gguf_bytes": 79_000_000_000u64 }
            ]
        })
    }

    #[test]
    fn each_mac_is_offered_the_largest_quantization_it_can_hold() {
        assert_eq!(recommend_variant(&three_variants(), 128), Some("Q8_0".into()));
        assert_eq!(recommend_variant(&three_variants(), 64), Some("Q8_0".into()));
        assert_eq!(recommend_variant(&three_variants(), 48), Some("Q4_K_M".into()));
        assert_eq!(recommend_variant(&three_variants(), 24), Some("IQ2_XXS".into()));
    }

    #[test]
    fn a_mac_below_every_variant_is_offered_none_rather_than_the_smallest() {
        // 8 GB does not meet even IQ2_XXS. Handing it the smallest anyway is
        // how a user ends up downloading 23 GB for a model that cannot start.
        assert_eq!(recommend_variant(&three_variants(), 8), None);
    }

    #[test]
    fn an_entry_with_no_variants_key_keeps_todays_single_download() {
        // Every registry entry today. None means "use entry.download", which
        // is what the installer already does, so the key can be added one
        // model at a time.
        assert_eq!(recommend_variant(&json!({ "id": "x" }), 128), None);
        // A malformed variant with no floor is skipped, not guessed at.
        let broken = json!({ "variants": [{ "id": "Q4", "gguf_bytes": 1 }] });
        assert_eq!(recommend_variant(&broken, 128), None);
    }

    /// GLM-4.5-Air's shape: 7 GB of non-expert weights, 66 GB of experts.
    fn glm_air() -> Value {
        json!({
            "id": "recommendation-test-fixture",
            "min_ram_gb": 16,
            "non_expert_bytes": 7_000_000_000u64,
            "expert_bytes_total": 66_022_539_264u64,
            "layers_moe": 45,
            "experts": 128,
            "experts_used": 8,
            "record_bytes": 11_462_246u64,
            "measured": [
                { "cache_gb": 11.77, "gen_tps": 1.8 },
                { "cache_gb": 44.8, "gen_tps": 6.8 },
                { "cache_gb": 66.02, "gen_tps": 15.4 }
            ],
        })
    }

    #[test]
    fn a_mac_with_room_gets_the_second_conversation() {
        // 128 GB, idle. Balanced reaches full residency and a second KV cache
        // is 0.8 GB out of tens of gigabytes of headroom.
        let m = MachineLimits::mac(128, Some(100 * GB));
        assert_eq!(recommended_slots(&glm_air(), m, "balanced", false, CTX_PER_SLOT), 2);
    }

    /// A model sized so the SECOND slot is what tips the mode over, on a
    /// machine that can otherwise afford balanced. 3 GB of non-expert weights
    /// and 40 GB of experts across 32 layers of 64.
    ///
    /// The shape matters: with GLM-4.5-Air on a 24 GB Mac the planner refuses
    /// at every slot count, so a test written on it passes whether or not the
    /// mode is checked at all. This fixture is the case the rule exists for,
    /// where two slots start and start WORSE.
    fn slot_sensitive() -> Value {
        json!({
            "id": "slot-policy-test-fixture",
            "min_ram_gb": 16,
            "non_expert_bytes": 3_000_000_000u64,
            "expert_bytes_total": 40_000_000_000u64,
            "layers_moe": 32,
            "experts": 64,
            "experts_used": 8,
            "record_bytes": 19_531_250u64,
            "measured": [
                { "cache_gb": 7.0, "gen_tps": 3.0 },
                { "cache_gb": 10.0, "gen_tps": 9.0 },
                { "cache_gb": 40.0, "gen_tps": 10.0 }
            ],
        })
    }

    #[test]
    fn a_mac_that_would_pay_for_the_second_conversation_with_its_mode_does_not_get_it() {
        // 32 GB Mac with 21.3 GB free, so the engine may hold 17.04 GB.
        // Balanced at one slot is 16.85 GB and fits. Balanced at two slots is
        // 17.65 GB and does not, and the flat default of two would have taken
        // the user from Balanced to Eco to buy a second conversation nobody
        // had opened yet.
        let m = MachineLimits::mac(32, Some(21_300_000_000));
        assert_eq!(recommended_slots(&slot_sensitive(), m, "balanced", false, CTX_PER_SLOT), 1);
        // And the step-down is real, not the planner refusing outright: two
        // slots DO start, in a worse mode. Without this the test above would
        // pass on a machine where nothing starts at all, which is how the
        // first version of it passed while checking nothing.
        let two = plan_cache(&slot_sensitive(), m, None, "balanced", false, 2, CTX_PER_SLOT).unwrap();
        assert_eq!(two.decision.mode, "eco");
        assert_eq!(two.decision.requested, "balanced");
        let one = plan_cache(&slot_sensitive(), m, None, "balanced", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(one.decision.mode, "balanced");
    }

    #[test]
    fn a_mac_that_cannot_start_the_model_at_all_is_not_told_it_has_two_conversations() {
        // The colleague's 24 GB Mac with GLM-4.5-Air: the planner refuses at
        // every slot count, and the answer has to be a number llama-server can
        // be started with so the refusal comes from the planner, with its
        // sentence about memory, rather than from here.
        let m = MachineLimits::mac(24, Some(14 * GB));
        assert_eq!(recommended_slots(&glm_air(), m, "balanced", false, CTX_PER_SLOT), 1);
        assert!(plan_cache(&glm_air(), m, None, "balanced", false, 1, CTX_PER_SLOT).is_err());
    }

    #[test]
    fn a_model_that_cannot_start_at_all_still_answers_one_rather_than_zero() {
        // plan_cache refuses at every slot count. Zero slots is not a thing
        // llama-server can be started with, so the refusal has to come from
        // the planner with its sentence about memory, not from here.
        let m = MachineLimits::mac(24, Some(GB));
        assert_eq!(recommended_slots(&glm_air(), m, "balanced", false, CTX_PER_SLOT), 1);
    }
}

#[cfg(test)]
mod plan_cache_tests {
    use super::CTX_PER_SLOT;
    use super::{plan_cache, MachineLimits};
    use serde_json::json;

    const GB: u64 = 1_000_000_000;

    /// A MoE model shaped like GLM-4.5-Air: 3 GB of non-expert weights, 40 GB
    /// of routed experts. The id is deliberately not a real one, so
    /// measured_geometry cannot find a profile.json and reads these fields.
    fn entry(measured: serde_json::Value) -> serde_json::Value {
        json!({
            "id": "plan-cache-test-fixture",
            "min_ram_gb": 16,
            "non_expert_bytes": 3_000_000_000u64,
            "expert_bytes_total": 40_000_000_000u64,
            "layers_moe": 46,
            "experts": 128,
            "experts_used": 8,
            "record_bytes": 4_000_000u64,
            "measured": measured,
        })
    }

    /// The three terms the engine pays before a single expert byte is cached:
    /// weights, then the affine runtime-overhead fit plan_cache uses.
    const FIXED: u64 = 3_000_000_000 + (2_500_000_000 + 3_000_000_000 * 45 / 100);

    #[test]
    fn the_seventy_percent_cap_bounds_the_whole_footprint_not_just_the_arena() {
        // DEFECT 1, pinned. The cap used to bound the ARENA and the weights and
        // the runtime overhead were added on top, so on this 24 GB Mac the
        // planner handed the engine a 15.1 GB arena and 22.0 GB resident: 92
        // percent of the machine, under a bound that reads "70 percent".
        //
        // Against that old shape this assertion is 15_150_000_000 and goes red.
        let plan = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.cache_bytes, 24 * GB * 7 / 10 - FIXED);
        assert_eq!(
            plan.cache_bytes + FIXED,
            16_800_000_000,
            "everything the engine holds must fit under 70 percent of 24 GB"
        );
        assert_eq!(plan.decision.mode, "perf");
    }

    /// A measured curve, so the three modes are three different sizes.
    fn curve() -> serde_json::Value {
        json!([
            {"cache_gb": 4.0, "gen_tps": 20.0},
            {"cache_gb": 8.0, "gen_tps": 30.0},
            {"cache_gb": 10.0, "gen_tps": 31.0},
        ])
    }

    #[test]
    fn an_idle_mac_still_gets_the_mode_it_asked_for() {
        // No reading available: the planner falls back to installed RAM, which
        // is exactly the behaviour that existed before, so a broken vm_stat
        // cannot make the app refuse to work.
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, None), None, "perf", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.decision.mode, "perf");
        assert_eq!(plan.decision.requested, "perf");
    }

    #[test]
    fn a_mac_with_a_browser_open_starts_in_eco_instead_of_dying_mid_graph() {
        // DEFECT 2, pinned. 24 GB installed, 16 GB actually free, so 12.8 GB to
        // spare. perf wants 16.8 and balanced 14.85; eco needs 10.85 and fits.
        // This is the case that reached the user as "Compute error.".
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(16 * GB)), None, "perf", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.decision.mode, "eco");
        assert_eq!(plan.decision.requested, "perf");
        assert_eq!(plan.cache_bytes, 4 * GB);
        assert!(plan.decision.resident_bytes <= plan.decision.budget_bytes);
    }

    #[test]
    fn the_step_down_stops_at_the_first_mode_that_fits() {
        // 19 GB free of 24, so 15.2 GB to spare: perf does not fit, balanced
        // does. Falling straight to eco here would cost the user a working
        // mode for nothing.
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(19 * GB)), None, "perf", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.decision.mode, "balanced");
        assert_eq!(plan.cache_bytes, 8 * GB);
    }

    #[test]
    fn a_machine_with_nothing_to_spare_is_told_so_before_anything_is_spawned() {
        let err = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(2 * GB)), None, "balanced", false, 1, CTX_PER_SLOT)
            .expect_err("2 GB free cannot hold a 3 GB model plus its arena");
        assert!(err.contains("memory"), "the refusal must name memory: {err}");
        assert!(err.contains("eco"), "and name the footprint it tried: {err}");
        assert!(err.contains("short by"), "and the figure that is missing: {err}");
    }

    #[test]
    fn every_decode_slot_past_the_first_is_paid_for_out_of_the_arena() {
        // Third instance of the same class of defect. The overhead fit was
        // measured at ctx 8192, which is ONE slot, while the engine is started
        // with --parallel 2 by default: 0.8 GB of KV cache the ceiling never
        // budgeted. Nothing about the resident total changes here, because in
        // perf the total IS the budget; what changes is that the arena stops
        // being handed memory the KV cache has already taken.
        let one = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 1, CTX_PER_SLOT).unwrap();
        let two = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 2, CTX_PER_SLOT).unwrap();
        let four = plan_cache(&entry(json!([])), MachineLimits::mac(24, None), None, "perf", false, 4, CTX_PER_SLOT).unwrap();
        assert_eq!(one.cache_bytes - two.cache_bytes, 800_000_000);
        assert_eq!(one.cache_bytes - four.cache_bytes, 2_400_000_000);
    }

    #[test]
    fn an_explicit_cache_size_still_overrules_the_policy() {
        // The override is the escape hatch for someone who knows their machine.
        // It must not be silently replaced by a step-down decision.
        let plan = plan_cache(&entry(curve()), MachineLimits::mac(24, Some(19 * GB)), Some(6), "perf", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.cache_bytes, 6 * GB);
    }
}

/// A user's report, turned into arithmetic.
///
/// A colleague on an M5 Mac with 24 GB started a chat in BALANCED, the default,
/// and got `Compute error.` He reproduced it with phi35-moe and with
/// gpt-oss-120b, and both times eco got him out, which he found by trying.
///
/// These are those two machines, those two models, that mode. They are written
/// as fixtures rather than read from the registry on purpose: the registry is
/// edited, and the point of these cases is that somebody breaking the fix in
/// six months sees THIS USER's case go red, not a number that drifted.
#[cfg(test)]
mod user_report_24gb_tests {
    use super::CTX_PER_SLOT;
    use super::{plan_cache, MachineLimits};
    use serde_json::json;

    const GB: u64 = 1_000_000_000;

    /// phi35-moe, from scripts/models-registry.json. `record_bytes` is absent
    /// from the registry entry (it comes from the install profile), so it is
    /// derived here the way the pack writer does: routed bytes over layers
    /// times experts, 24.38 GB / (32 * 16).
    fn phi35_moe() -> serde_json::Value {
        json!({
            "id": "user-report-phi35-moe",
            "min_ram_gb": 16,
            "non_expert_bytes": 900_000_000u64,
            "expert_bytes_total": 24_381_489_152u64,
            "layers_moe": 32,
            "experts": 16,
            "experts_used": 2,
            "record_bytes": 47_620_096u64,
            "measured": [
                {"cache_gb": 10.1,  "gen_tps": 13.2},
                {"cache_gb": 16.8,  "gen_tps": 20.4},
                {"cache_gb": 22.4,  "gen_tps": 22.7},
                {"cache_gb": 24.38, "gen_tps": 23.8},
            ],
        })
    }

    /// gpt-oss-120b, from scripts/models-registry.json, geometry unmodified.
    fn gpt_oss_120b() -> serde_json::Value {
        json!({
            "id": "user-report-gpt-oss-120b",
            "min_ram_gb": 16,
            "non_expert_bytes": 4_500_000_000u64,
            "expert_bytes_total": 60_926_459_904u64,
            "layers_moe": 36,
            "experts": 128,
            "experts_used": 4,
            "record_bytes": 13_221_888u64,
            "min_cache_bytes": 7_616_207_616u64,
            "measured": [
                {"cache_gb": 5.06,  "gen_tps": 2.1},
                {"cache_gb": 13.06, "gen_tps": 4.3},
                {"cache_gb": 21.06, "gen_tps": 6.9},
                {"cache_gb": 24.81, "gen_tps": 7.7},
                {"cache_gb": 33.6,  "gen_tps": 13.1},
                {"cache_gb": 44.8,  "gen_tps": 19.2},
                {"cache_gb": 60.93, "gen_tps": 21.8},
            ],
        })
    }

    // What the OLD planner handed the engine on this 24 GB Mac, in balanced,
    // recomputed from the shape it had:
    //
    //   fixed     = non_expert + 2.5 GB + non_expert * 0.45   (slots ignored)
    //   max_cache = min(ram - fixed - reserve, ram * 7/10, expert_total)
    //   resident  = fixed + cache chosen on that ceiling
    //
    // phi35-moe:     fixed 3.805, ceiling 16.80, knee 16.80 -> 20.61 GB resident
    // gpt-oss-120b:  fixed 9.025, ceiling 12.98, knee  5.06 -> 14.09 GB resident
    //
    // On a 24 GB Mac running macOS, this app, its webview and a browser, the
    // first is 86 percent of the machine and the second 59, and NEITHER was
    // ever compared against what the machine actually had free.
    const OLD_PHI35_BALANCED_RESIDENT: u64 = 20_605_000_000;
    const OLD_GPT_OSS_BALANCED_RESIDENT: u64 = 14_085_000_000;

    #[test]
    fn phi35_moe_on_a_24gb_mac_in_balanced_no_longer_plans_twenty_gigabytes() {
        // The ceiling fix alone, with no reading of free memory: balanced falls
        // from 20.6 GB resident to 13.9, because the 70 percent cap now bounds
        // the whole footprint and the knee is recomputed under it.
        let plan = plan_cache(&phi35_moe(), MachineLimits::mac(24, None), None, "balanced", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.cache_bytes, 10_100_000_000);
        assert_eq!(plan.decision.resident_bytes, 13_905_000_000);
        // And it gets there WITHOUT stepping down: on an idle 24 GB Mac
        // balanced is affordable, so the ladder must not be doing this work.
        // A ceiling that still overcommits would show up here as a step-down.
        assert_eq!(plan.decision.mode, "balanced");
        assert!(
            plan.decision.resident_bytes < OLD_PHI35_BALANCED_RESIDENT,
            "the ceiling fix must strictly improve this user's case"
        );
    }

    #[test]
    fn phi35_moe_balanced_now_holds_what_the_user_had_to_find_by_trying_eco() {
        // The user's machine as he described it: 24 GB, a working session open,
        // 18 GB actually free, so 14.4 claimable.
        //
        // Balanced held 20.6 GB before, which is 6.2 GB more than this machine
        // had to give: that gap IS the "Compute error." he read. It now holds
        // 13.9, the same footprint he reached by switching to eco himself, and
        // the request never has to change mode to get there.
        let plan = plan_cache(&phi35_moe(), MachineLimits::mac(24, Some(18 * GB)), None, "balanced", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.decision.requested, "balanced");
        assert_eq!(plan.decision.mode, "balanced");
        assert_eq!(plan.decision.budget_bytes, 14_400_000_000);
        assert_eq!(plan.decision.resident_bytes, 13_905_000_000);
        assert!(
            OLD_PHI35_BALANCED_RESIDENT > plan.decision.budget_bytes,
            "and this is why he met Compute error.: the old plan did not fit, by {} bytes",
            OLD_PHI35_BALANCED_RESIDENT - plan.decision.budget_bytes
        );
    }

    #[test]
    fn phi35_moe_in_performance_steps_down_on_that_same_machine() {
        // Same Mac, same 18 GB free. Performance would hold the full 16.8 GB
        // ceiling, which does not fit in 14.4, so the ladder takes one rung and
        // says which. The user is told; nothing is decided behind his back.
        let plan = plan_cache(&phi35_moe(), MachineLimits::mac(24, Some(18 * GB)), None, "perf", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.decision.requested, "perf");
        assert_eq!(plan.decision.mode, "balanced");
        assert!(plan.decision.resident_bytes <= plan.decision.budget_bytes);
    }

    #[test]
    fn gpt_oss_120b_shows_the_ceiling_fix_alone_would_not_have_saved_him() {
        // THE POINT WORTH KEEPING. For this model the 70 percent cap was never
        // the binding constraint: `ram - fixed - reserve` was, at 12.98 GB. So
        // the ceiling fix changes NOTHING here, and a report that stopped at
        // "the cap is fixed" would have declared the user's bug closed while
        // one of his two models still planned 14.1 GB resident with nobody
        // asking whether the machine had 14.1 GB to give.
        let plan = plan_cache(&gpt_oss_120b(), MachineLimits::mac(24, None), None, "balanced", false, 1, CTX_PER_SLOT).unwrap();
        assert_eq!(plan.decision.resident_bytes, OLD_GPT_OSS_BALANCED_RESIDENT);
    }

    #[test]
    fn gpt_oss_120b_is_refused_with_the_missing_figure_instead_of_crashing() {
        // Same 24 GB Mac with a browser open: 12 GB free, so 9.6 GB claimable.
        // Even eco needs 14.1. There is no mode that fits, and the honest
        // answer is a number and a refusal, not an engine that dies mid-graph.
        let err = plan_cache(&gpt_oss_120b(), MachineLimits::mac(24, Some(12 * GB)), None, "balanced", false, 1, CTX_PER_SLOT)
            .expect_err("14.1 GB cannot come out of 9.6");
        assert!(err.contains("9.6 GB"), "name what the machine can give: {err}");
        assert!(err.contains("short by 4.5 GB"), "and what is missing: {err}");
    }

    #[test]
    fn gpt_oss_120b_runs_again_once_the_machine_has_room() {
        // The same Mac after the user quits a few things: 18 GB free, 14.4
        // claimable, and eco's 14.085 fits. Nothing here refuses out of
        // caution; the gate is arithmetic, and it opens when the memory is
        // really there.
        let plan = plan_cache(&gpt_oss_120b(), MachineLimits::mac(24, Some(18 * GB)), None, "balanced", false, 1, CTX_PER_SLOT)
            .expect("14.085 GB fits in 14.4");
        assert!(plan.decision.resident_bytes <= plan.decision.budget_bytes);
    }

    #[test]
    fn the_ladder_always_lands_on_a_mode_that_fits_or_refuses_outright() {
        // The step-down cannot loop: it walks a three-element array once. What
        // is worth proving is the other half, that it never hands back a mode
        // that does not fit either, which is the failure mode a retry loop
        // would have had. Swept across every budget from nothing to 32 GB, on
        // both of this user's models, in all three modes.
        for entry in [phi35_moe(), gpt_oss_120b()] {
            for mode in ["eco", "balanced", "perf"] {
                for step in 0..=64u64 {
                    let available = step * 500_000_000;
                    match plan_cache(&entry, MachineLimits::mac(24, Some(available)), None, mode, false, 2, CTX_PER_SLOT) {
                        Ok(plan) => assert!(
                            plan.decision.resident_bytes <= plan.decision.budget_bytes,
                            "{mode} at {available} bytes free planned {} over a budget of {}",
                            plan.decision.resident_bytes,
                            plan.decision.budget_bytes
                        ),
                        // A refusal is a legitimate answer, and the only other
                        // one. It must always carry the figure that is missing.
                        Err(e) => assert!(
                            e.contains("memory"),
                            "a refusal must explain itself: {e}"
                        ),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod ctx_window_tests {
    use super::{ctx_within_model, kv_bytes_for};
    use crate::CTX_PER_SLOT;

    #[test]
    fn a_model_trained_on_less_than_the_default_is_not_stretched_to_it() {
        // OLMoE states 4096. The old form was
        // `asked.clamp(CTX_PER_SLOT, model_max.max(CTX_PER_SLOT))`, which
        // raised the CEILING to 8192 instead of lowering the floor, so every
        // window handed to it was twice what it was trained on. llama.cpp does
        // not refuse that; it extends the rope and the answers get worse
        // without saying so.
        assert_eq!(crate::planner::ctx_within_model(8192, 4096), 4096);
        assert_eq!(crate::planner::ctx_within_model(131_072, 4096), 4096, "asking for more changes nothing");
        // The floor collapses onto the ceiling rather than disappearing: the
        // settings field offers 8K upwards, so anything below it is not a wish
        // the user expressed, and the model gets all it can hold.
        assert_eq!(crate::planner::ctx_within_model(2048, 4096), 4096);
    }

    #[test]
    fn the_default_still_applies_when_the_model_has_room_for_it() {
        assert_eq!(crate::planner::ctx_within_model(4096, 131_072), CTX_PER_SLOT, "the floor holds");
        assert_eq!(crate::planner::ctx_within_model(32_768, 131_072), 32_768, "a wish inside the limit is met");
        assert_eq!(crate::planner::ctx_within_model(262_144, 131_072), 131_072, "the model's limit is the ceiling");
    }

    #[test]
    fn a_ten_million_token_ceiling_changes_nothing_but_the_limit() {
        // Llama-4 Scout publishes 10 * 1024 * 1024. The settings offer stops at
        // 128K, so what a ceiling that large does is stop capping, and every
        // figure that follows still comes from what was asked for rather than
        // from what the model could hold. Checked rather than assumed, because
        // a number six orders of magnitude past the others is exactly where an
        // overflow or a silly plan would show up.
        let scout = 10_485_760;
        assert_eq!(crate::planner::ctx_within_model(131_072, scout), 131_072, "the biggest offer is served whole");
        assert_eq!(crate::planner::ctx_within_model(8192, scout), CTX_PER_SLOT, "and so is the smallest");
        // The KV cost is driven by the WINDOW SERVED, never by the ceiling.
        assert_eq!(crate::planner::kv_bytes_for(131_072, 2), crate::planner::kv_bytes_for(131_072, 2), "no term reads model_max");
        assert!(
            crate::planner::kv_bytes_for(crate::planner::ctx_within_model(131_072, scout), 4) < u64::MAX / 2,
            "nothing overflows on the way through"
        );
    }
}

// ---------------------------------------------------------------- les types
//
// Ce que le planificateur produit et consomme. Ils etaient restes dans lib.rs
// quand leurs fonctions en sont parties: un type separe de la seule chose qui
// le fabrique est une invitation a le faire diverger.

/// Context window every slot keeps by default, whatever the slot count.
///
/// This was the ONLY value for two years, and it is the one every memory figure
/// in this file was measured at. It stays the default and the unit the KV cost
/// below is expressed in.
pub(crate) const CTX_PER_SLOT: u32 = 8192;

/// The largest window offered to a model whose training context nobody recorded.
///
/// Asking for more than a model was trained on does not fail: llama.cpp extends
/// the rope and the answers quietly get worse, which is the failure mode this
/// project exists to avoid. A registry entry that states its own
/// `context_length` is believed; anything else is held here, comfortably inside
/// what every model in the catalogue was trained on.
pub(crate) const CTX_CEILING_UNKNOWN: u32 = 32_768;

/// Hard ceiling on slots: past this the KV cache stops being free and a Mac
/// with a big model would pay it in evictions.
pub(crate) const MAX_SLOTS: u32 = 4;

/// Resident cost of one decode slot beyond the first, from the measurements
/// above: 29.6 GB at one slot, 30.4 at two, 32.0 at four. The planner has to
/// pay it, or a two-slot default silently spends 0.8 GB it never budgeted.
pub(crate) const KV_BYTES_PER_EXTRA_SLOT: u64 = 800_000_000;

/// What a dense model pays beyond its own weights.
///
/// The graph, the compute buffers and the scratch every engine allocates,
/// whatever the architecture. It is the same 2.5 GB the MoE branch charges as
/// its fixed term; a dense model does not escape it for having no experts.
pub(crate) const DENSE_RUNTIME_OVERHEAD: u64 = 2_500_000_000;

/// Share of the measured free pool the engine may claim: four fifths.
///
/// The reading is a snapshot taken seconds before llama-server starts
/// allocating, and the machine does not hold still in between: a tab opens,
/// Spotlight indexes, this app's own webview grows. One fifth of the pool is
/// what absorbs that drift, and it is also the honest price of counting
/// inactive pages as available, since macOS hands them over readily but
/// neither instantly nor always in full.
///
/// A FRACTION of the measured pool, not a constant, and that is the whole
/// point: a constant is exactly the mistake being replaced here. A fifth of
/// 4 GB free is a 0.8 GB cushion on a machine with nothing to spare, and a
/// fifth of 100 GB free is 20 GB on a machine that has plenty. The cushion has
/// to scale with the thing it is cushioning.
pub(crate) const AVAILABLE_CLAIM_NUM: u64 = 4;

pub(crate) const AVAILABLE_CLAIM_DEN: u64 = 5;

/// Total resident bytes the engine may occupy: non-expert weights, runtime
/// overhead and expert arena TOGETHER, not one of the three.
///
/// `available` is what `available_memory_bytes()` measured, and None when
/// vm_stat could not be read or parsed. A missing measurement falls back to
/// the hardware bound instead of refusing everything: no worse than the
/// behaviour this replaces, and a broken probe must never make the app
/// unusable.
///
/// `installed` reaches this from `ram_gb * 1e9`, which understates a machine
/// sold in GiB by about 7 percent, while `available` is real bytes from
/// vm_stat. The mismatch only ever makes the hardware bound smaller than the
/// truth, and a bound that errs toward leaving memory free is the one to keep.
/// The three readings that bound a start, and the one number every registry
/// `min_ram_gb` is written against.
///
/// Grouped rather than passed one by one because they answer the same
/// question, "what can this Mac give", and because they arrive together: one
/// is a property of the hardware, one is a measurement taken seconds before
/// the engine allocates, and one is what the GPU driver will actually let the
/// process hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MachineLimits {
    /// `hw.memsize >> 30`. GiB, because that is the unit every `min_ram_gb`
    /// in the registry is written in.
    pub(crate) ram_gb: u64,
    /// vm_stat free plus inactive plus speculative. `None` when vm_stat could
    /// not be read.
    pub(crate) available: Option<u64>,
    /// `MTLDevice.recommendedMaxWorkingSetSize`. `None` when there is no Metal
    /// device (headless CI, a VM without GPU passthrough).
    pub(crate) gpu_working_set: Option<u64>,
}

/// The footprint modes, from the hungriest to the leanest. The step-down walks
/// this array, so its order IS the policy.
pub(crate) const MODE_LADDER: [&str; 3] = ["perf", "balanced", "eco"];

/// What the engine would hold resident in each mode, for one model on one
/// machine. Bytes, weights and runtime overhead included, not just the arena.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ModeFootprints {
    pub(crate) eco: u64,
    pub(crate) balanced: u64,
    pub(crate) perf: u64,
}

/// The mode a start will actually use, and the numbers that justify it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModeDecision {
    /// The mode the engine is started in.
    pub(crate) mode: String,
    /// The mode the user asked for. Different from `mode` after a step-down.
    pub(crate) requested: String,
    /// True when not even eco fits. The start is then refused with a sentence
    /// about memory, rather than spawning an engine that will die mid-graph.
    pub(crate) impossible: bool,
    /// What the engine will hold, all three terms together.
    pub(crate) resident_bytes: u64,
    /// What the machine can give right now.
    pub(crate) budget_bytes: u64,
}

/// Everything a start needs from the planner: the numbers the engine is given,
/// and the mode decision that produced them.
#[derive(Clone, Debug)]
pub(crate) struct CachePlan {
    pub(crate) cache_bytes: u64,
    /// SLRU protected fraction.
    pub(crate) protected: f64,
    /// Physical micro-batch.
    pub(crate) ubatch: u32,
    pub(crate) decision: ModeDecision,
}

/// The most decode slots the app will ever recommend on its own.
///
/// A slot past the first is a whole extra KV cache: `KV_BYTES_PER_EXTRA_SLOT`,
/// 0.8 GB, measured. Above two, nothing the app can read tells it the user
/// wants a third conversation generating at the same time, so that stays an
/// explicit choice in Settings rather than a guess the machine pays for.
pub(crate) const RECOMMENDED_SLOT_CAP: u32 = 2;

/// A volume the installer could write a pack to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PackVolume {
    pub(crate) mount: String,
    pub(crate) free_bytes: u64,
    /// Measured sequential read bandwidth, GB/s, from `volume_bandwidth`.
    /// `None` when this volume has not been probed, and an unprobed volume is
    /// never chosen as the second half of a dual pack: the split ratio is
    /// computed FROM the two bandwidths, so guessing one would write a pack
    /// cut at the wrong place for the life of the install.
    pub(crate) bandwidth_gbs: Option<f64>,
}

/// Where a model's pack should be written.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum PackLayout {
    /// One volume carries the whole pack.
    Single { mount: String },
    /// Both volumes carry a share of every record and are read in parallel.
    /// `internal` is the faster of the two and takes the larger share.
    Dual { internal: String, external: String },
    /// No arrangement of the mounted volumes has room for this model.
    NoRoom,
}

/// Bytes left free on a volume beyond the share it carries. Same 2 GiB the
/// download preflight keeps (`INSTALL_DOWNLOAD_RESERVE_GIB`): a volume filled
/// to its last byte is a volume macOS cannot work on.
pub(crate) const PACK_VOLUME_RESERVE: u64 = INSTALL_DOWNLOAD_RESERVE_GIB * 1024 * 1024 * 1024;

/// The slowest a second volume may be before splitting the pack across it
/// costs more than it buys.
///
/// Not a new number: it is the threshold the install pipeline already applies
/// as a fallback, and the one the install dialog already paints as its
/// bottleneck verdict. What was missing is that the user had to reach that
/// verdict by hand, by choosing dual and pressing Measure.
pub(crate) const DUAL_BANDWIDTH_FLOOR: f64 = 0.35;
