//! What this Mac is, and what it can give right now.
//!
//! The app used to know three things about the machine it runs on:
//! `hw.memsize`, `hw.ncpu` and the CPU brand string. A 16 GB M1 and a 16 GB
//! M4 Max were the same machine as far as every decision was concerned, and
//! the one number that decides whether a start survives, how much unified
//! memory the GPU may hold resident, was never read at all.
//!
//! # What each probe costs
//!
//! Measured on an Apple M5 Max, macOS 26.5, 20 iterations each, warm:
//!
//! | probe                                | per call | what it gives              |
//! |--------------------------------------|----------|----------------------------|
//! | `sysctl -n k1 k2 ...` (one call)     |   0.2 ms | RAM, cores, perf levels    |
//! | `vm_stat`                            |   1.0 ms | free/inactive/speculative  |
//! | `notifyutil -g ...thermalpressure`   |   1.5 ms | thermal pressure level     |
//! | `pmset -g ps`                        |   5.5 ms | AC or battery              |
//! | `pmset -g`                           |   5.5 ms | energy mode                |
//! | `ioreg -rc AGXAccelerator -d 1`      |  14.5 ms | GPU core count             |
//! | `MTLCreateSystemDefaultDevice` + 2   |  15.7 ms | working set, buffer limit  |
//! | ... the same, second call in-process |   0.1 ms |                            |
//! | `system_profiler SPDisplaysDataType` | 290.0 ms | GPU core count             |
//!
//! `system_profiler` is twenty times the cost of `ioreg` for the same GPU core
//! count (`sppci_cores` against `gpu-core-count`, both 40 on the machine
//! above), so it is not used. Everything here is cheap enough to read at
//! launch; the static half is read once and cached, and only the live half is
//! read again.
//!
//! # What cannot be known
//!
//! **Memory bandwidth** has no API, no sysctl and no IORegistry key. The
//! `hw.memfrequency` and `hw.busfrequency` an Intel Mac published are not even
//! registered on Apple Silicon, so it cannot be reconstructed from a clock
//! either. [`published_bandwidth_gbs`] is a table of the figures Apple states
//! in its own announcements and specification pages, and it returns `None` for
//! any chip not in it. It is shown to the user and feeds no decision.
//!
//! **The GPU memory limit cannot be computed**, only read. `iogpu.wired_limit_mb`
//! is undocumented by Apple (IOGPUFamily is closed source; the only text Apple
//! ships for it is `sysctl -d`, which answers "Wired Limit Megabytes"), and 0
//! means "no override, the kernel decides". The formula everyone quotes comes
//! from a 2023 decompilation of `AGXAccelerator::calcMaxGPUPhysicalMemoryBytes`
//! on a Ventura beta: reserve a third below 32 GiB and a quarter above. It is
//! already wrong. On the machine this was written on it predicts 96.00 GiB and
//! `recommendedMaxWorkingSetSize` answers 107.52 GiB, a 16 percent reserve
//! rather than 25. So the API is read and no formula is kept: llama.cpp,
//! Ollama and MLX all do the same thing for the same reason.
//!
//! **Thermal state** turned out to be readable after all, and cheaply, which
//! is worth writing down because the obvious probe is a dead end: `pmset -g
//! therm` answers "No CPU power status has been recorded" on Apple Silicon,
//! and its own man page says "Not available on all platforms". See
//! [`parse_thermal_pressure`] for the key that does work.

use std::ffi::{c_char, c_void, CString};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

// ------------------------------------------------------------------ probing

/// Run a command and return its trimmed stdout, empty on any failure.
fn capture(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Every sysctl key this module reads, in ONE call.
///
/// `sysctl` costs about 0.2 ms per invocation, almost all of it process
/// creation, so eleven keys in one call cost what one key would. The output is
/// `key: value` per line and is parsed by [`parse_sysctl`].
const SYSCTL_KEYS: [&str; 6] = [
    "hw.memsize",
    "hw.memsize_usable",
    "hw.ncpu",
    "hw.nperflevels",
    "machdep.cpu.brand_string",
    "iogpu.wired_limit_mb",
];

/// `key: value` lines into pairs. Values may contain colons and spaces (the
/// brand string of an Intel Mac is `Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz`),
/// so only the FIRST colon separates.
fn parse_sysctl(out: &str, key: &str) -> Option<String> {
    for line in out.lines() {
        let (k, v) = line.split_once(':')?;
        if k.trim() == key {
            return Some(v.trim().to_string());
        }
    }
    None
}

// ------------------------------------------------------------------- chip

/// Where a chip sits in its own generation. Not a performance ranking across
/// generations: an M1 Ultra and an M4 are both "not the base tier of the other
/// one's family", and comparing them needs the generation too.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChipTier {
    Base,
    Pro,
    Max,
    Ultra,
    /// Intel, a virtual machine, or an Apple Silicon tier that did not exist
    /// when this was written. Never guessed into one of the four above.
    Unknown,
}

/// Generation and tier out of `machdep.cpu.brand_string`.
///
/// The brand string is the only identifier that names the chip in a form that
/// survives new models: `hw.cpufamily` is an opaque hash that has to be
/// tabulated per chip and is unknown for anything newer than the build, and
/// `hw.targettype` (`J714c`) names the BOARD, so two Macs with the same chip
/// report different values.
///
/// Returns `(None, Unknown)` for anything that is not `Apple M<n>`: an Intel
/// Mac, a VM, or a future naming scheme. A caller that gets `None` must fall
/// back on numbers it measured, never on a tier it invented.
pub fn parse_chip(brand: &str) -> (Option<u32>, ChipTier) {
    let rest = match brand.trim().strip_prefix("Apple M") {
        Some(r) => r,
        None => return (None, ChipTier::Unknown),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let generation: u32 = match digits.parse() {
        Ok(g) => g,
        Err(_) => return (None, ChipTier::Unknown),
    };
    let tier = match rest[digits.len()..].trim() {
        "" => ChipTier::Base,
        "Pro" => ChipTier::Pro,
        "Max" => ChipTier::Max,
        "Ultra" => ChipTier::Ultra,
        // A tier this build has never heard of. Reporting Unknown keeps every
        // tier-keyed lookup honest instead of silently filing it under Base.
        _ => ChipTier::Unknown,
    };
    (Some(generation), tier)
}

/// GPU cores out of `ioreg -rc AGXAccelerator -d 1`.
///
/// The property is `"gpu-core-count" = 40`. `system_profiler
/// SPDisplaysDataType` reports the same number as `sppci_cores` and costs
/// twenty times as much, so this is the one that is used.
///
/// `None` on an Intel Mac, in a VM, or if the property is ever renamed, and
/// the callers treat that as "unknown" rather than as zero.
pub fn parse_gpu_cores(ioreg: &str) -> Option<u32> {
    let i = ioreg.find("\"gpu-core-count\"")?;
    let after = &ioreg[i..];
    let eq = after.find('=')?;
    after[eq + 1..]
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// One tier of CPU cores, as macOS names it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CoreLevel {
    /// Verbatim `hw.perflevelN.name`, NEVER a name this code chose.
    pub name: String,
    pub count: u32,
}

/// The CPU core tiers, fastest first.
///
/// The count of tiers is `hw.nperflevels` and is NOT always two: it was two on
/// every M1 and M2, and the machine this was written on (an M5 Max, macOS
/// 26.5) reports `hw.perflevel0.name = Super` and `hw.perflevel1.name =
/// Performance`, with no level named "Efficiency" anywhere. Any code that
/// hardcoded "perflevel0 is P, perflevel1 is E" would report six efficiency
/// cores that do not exist.
///
/// So the NAMES are read, not assumed, and the only structural property relied
/// on is the ordering: level 0 is the fastest. That ordering is what
/// `hw.perflevel0` meaning the top tier rests on, and it is the one thing
/// about this sysctl that has been stable since it was introduced.
fn read_core_levels(nperflevels: u32) -> Vec<CoreLevel> {
    let mut out = Vec::new();
    for level in 0..nperflevels.min(8) {
        let keys = [
            format!("hw.perflevel{level}.name"),
            format!("hw.perflevel{level}.logicalcpu"),
        ];
        let args: Vec<&str> = std::iter::once("-n").chain(keys.iter().map(String::as_str)).collect();
        let out_text = capture("sysctl", &args);
        let mut lines = out_text.lines();
        let (Some(name), Some(count)) = (lines.next(), lines.next()) else { continue };
        let Ok(count) = count.trim().parse::<u32>() else { continue };
        out.push(CoreLevel { name: name.trim().to_string(), count });
    }
    out
}

// ------------------------------------------------------------------- Metal

// The GPU working set is the number that decides whether a start survives, and
// it is the only one of these that is not a string in a pipe.
//
// WHERE THE MEMORY IS ACTUALLY WIRED. The expert arena is host memory
// (posix_memalign, h4-expert-store.cpp), and llama.cpp hands it to Metal with
// newBufferWithBytesNoCopy under MTLResourceStorageModeShared
// (ggml-metal-device.m:1621), then puts every buffer in an MTLResidencySet and
// calls requestResidency (:1470); residency sets are on by default from macOS
// 15 (:827). The allocation itself wires almost nothing: a 4 GiB shared buffer
// fully written by the CPU moved `vm_stat` "Pages wired down" by 30 MiB, page
// tables and no more. requestResidency on the same buffer moved it by
// 4116 MiB, the whole thing. Measured on the machine this was written on and
// reproduced at a different size. So the budget that matters is not the
// allocation, it is the residency, which is exactly what
// recommendedMaxWorkingSetSize bounds.
//
// A HINT, NOT A CAP, and the distinction is why it is used as a budget rather
// than as a gate. Apple: "An approximation of how much memory, in bytes, this
// GPU device can allocate without affecting its runtime performance", and "You
// can help the GPU maintain its performance by keeping the total memory
// footprint of its resources and heaps less than this threshold value."
// Nothing refuses past it. maxBufferLength IS a real cap by contrast: "The
// largest amount of memory, in bytes, that a GPU device can allocate to a
// buffer instance."
//
// What going past it looks like is therefore not an exception. llama.cpp
// compares currentAllocatedSize against it and only LOGS (:1427), inside
// `#ifndef GGML_METAL_NDEBUG`, so a release build prints nothing; the
// allocation then either succeeds and the machine pays for it in swap, or
// newBufferWithBytesNoCopy returns nil and the backend buffer fails (:1626).
// Apple documents no OOM kill, fault or panic for macOS at all: the only
// termination it documents is scoped to iOS and tvOS. In practice the
// dominant outcome reported against llama.cpp is the swap spiral, not a clean
// failure, and neither outcome ever reaches the user as a sentence about
// memory. That is what "it crashed twice" looked like from the outside.
//
// Zero new dependencies: MTLCreateSystemDefaultDevice is a C entry point, and
// the two properties are read through objc_msgSend, which is how any Objective
// C property is read. objc2 is in the lock file but objc2-metal is not, and
// `cargo test --offline` must keep working.

#[link(name = "Metal", kind = "framework")]
extern "C" {
    /// Create Rule: the caller owns the returned device and must release it.
    fn MTLCreateSystemDefaultDevice() -> *mut c_void;
}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

/// Read a `NSUInteger` property off an Objective C object.
///
/// # Safety
///
/// `obj` must be a live Objective C object that responds to `selector` with a
/// method returning `NSUInteger`. Both call sites below satisfy that: the
/// object is an `MTLDevice` and the two selectors are declared on the
/// `MTLDevice` protocol as `NSUInteger` properties.
///
/// The transmute of `objc_msgSend` is how it is meant to be called: it is
/// declared without a signature precisely because the caller supplies one, and
/// on arm64 there is a single entry point (no `objc_msgSend_stret`, which only
/// ever applied to struct returns on x86).
unsafe fn msg_send_u64(obj: *mut c_void, selector: &str) -> u64 {
    let name = match CString::new(selector) {
        Ok(n) => n,
        Err(_) => return 0,
    };
    let sel = sel_registerName(name.as_ptr());
    let send: extern "C" fn(*mut c_void, *mut c_void) -> u64 =
        std::mem::transmute(objc_msgSend as *const ());
    send(obj, sel)
}

/// # Safety
/// Same contract as [`msg_send_u64`], for a method returning `void`.
unsafe fn msg_send_void(obj: *mut c_void, selector: &str) {
    let Ok(name) = CString::new(selector) else { return };
    let sel = sel_registerName(name.as_ptr());
    let send: extern "C" fn(*mut c_void, *mut c_void) = std::mem::transmute(objc_msgSend as *const ());
    send(obj, sel);
}

/// What Metal says this GPU may hold.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuLimits {
    /// `MTLDevice.recommendedMaxWorkingSetSize`. The unified memory the GPU
    /// may keep resident. llama.cpp itself treats this as the total GPU
    /// memory and reports `free = this - currentAllocatedSize`
    /// (ggml-metal-device.m:1043).
    pub working_set_bytes: u64,
    /// `MTLDevice.maxBufferLength`. The largest SINGLE `MTLBuffer`. It is not
    /// a ceiling on the arena: past it llama.cpp cuts the host allocation into
    /// overlapping views (ggml-metal-device.m:1636). It IS a ceiling on one
    /// layer's contiguous slab, which is what `ExpertStore::max_slab_bytes`
    /// exists to bound.
    pub max_buffer_bytes: u64,
}

/// Ask Metal once, keep the answer.
///
/// `None` when there is no Metal device: a headless CI runner, a VM without
/// GPU passthrough. Callers must fall back on the RAM bound rather than refuse
/// to start, exactly as `available_memory_bytes` does when vm_stat is unread.
///
/// Once per process: creating the device costs 15.7 ms the first time and
/// 0.1 ms after, and the numbers do not change while the app runs. The device
/// is released immediately; the properties are plain integers.
pub fn gpu_limits() -> Option<GpuLimits> {
    static CACHE: OnceLock<Option<GpuLimits>> = OnceLock::new();
    *CACHE.get_or_init(|| unsafe {
        let device = MTLCreateSystemDefaultDevice();
        if device.is_null() {
            return None;
        }
        let limits = GpuLimits {
            working_set_bytes: msg_send_u64(device, "recommendedMaxWorkingSetSize"),
            max_buffer_bytes: msg_send_u64(device, "maxBufferLength"),
        };
        msg_send_void(device, "release");
        // A device that answers zero is a device that answered nothing.
        if limits.working_set_bytes == 0 {
            return None;
        }
        Some(limits)
    })
}

// ------------------------------------------------------------------- power

/// Where the Mac's power is coming from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PowerSource {
    Ac,
    Battery,
    /// `pmset` unreadable, or a Mac with no battery at all (a Mac mini reports
    /// `AC Power` and no battery line, which is `Ac`, not this).
    Unknown,
}

/// `pmset -g ps` prints `Now drawing from 'AC Power'` or `'Battery Power'`.
pub fn parse_power_source(pmset_ps: &str) -> PowerSource {
    let head = pmset_ps.lines().next().unwrap_or_default();
    if head.contains("'AC Power'") {
        PowerSource::Ac
    } else if head.contains("'Battery Power'") {
        PowerSource::Battery
    } else {
        PowerSource::Unknown
    }
}

/// The energy mode the user chose in System Settings.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PowerMode {
    Automatic,
    Low,
    High,
    Unknown,
}

/// `pmset -g` prints a ` powermode  N` line among the active settings: 0
/// automatic, 1 low power, 2 high power. A Mac with no such line (an older
/// one, or a desktop without the setting) reads as Automatic rather than
/// Unknown, because "the user has not asked for anything special" is exactly
/// what a missing line means.
pub fn parse_power_mode(pmset_g: &str) -> PowerMode {
    for line in pmset_g.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some("powermode") {
            continue;
        }
        return match parts.next() {
            Some("0") => PowerMode::Automatic,
            Some("1") => PowerMode::Low,
            Some("2") => PowerMode::High,
            _ => PowerMode::Unknown,
        };
    }
    PowerMode::Automatic
}

// ----------------------------------------------------------------- profile

/// The half of the machine that cannot change while the app is running.
///
/// Read once, at launch, and cached. Nothing in here moves without the user
/// shutting the Mac down: the chip does not change, the cores do not change,
/// the soldered memory does not change, and `recommendedMaxWorkingSetSize` is
/// a property of the device rather than of the moment.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StaticProfile {
    /// `machdep.cpu.brand_string`, verbatim, for display.
    pub chip: String,
    /// 5 for an M5 Max. `None` on Intel or in a VM.
    pub chip_generation: Option<u32>,
    pub chip_tier: ChipTier,
    /// `hw.ncpu`.
    pub cores: u32,
    /// The CPU tiers, fastest first, named as macOS names them.
    pub core_levels: Vec<CoreLevel>,
    /// `None` on anything without an AGXAccelerator (Intel, VM).
    pub gpu_cores: Option<u32>,
    /// `hw.memsize`: the memory the Mac was sold with, in bytes.
    pub ram_bytes: u64,
    /// `hw.memsize_usable`: the same minus what firmware carved out. About
    /// 1 GB smaller on the machine this was written on.
    pub ram_usable_bytes: u64,
    /// `None` when there is no Metal device.
    pub gpu: Option<GpuLimits>,
    /// `iogpu.wired_limit_mb` in bytes, when the user or an installer has set
    /// it. `None` when the sysctl reads 0, which is its default and means
    /// "macOS decides", the case where `gpu.working_set_bytes` is the answer.
    pub wired_limit_override_bytes: Option<u64>,
    /// Apple's published memory bandwidth for this chip, in GB/s. `None` for
    /// any chip not in the table, which includes every chip newer than this
    /// build. Reported, never used to decide.
    pub bandwidth_gbs: Option<f64>,
}

/// Read the machine. Once per process.
pub fn static_profile() -> &'static StaticProfile {
    static CACHE: OnceLock<StaticProfile> = OnceLock::new();
    CACHE.get_or_init(|| {
        let args: Vec<&str> = SYSCTL_KEYS.to_vec();
        let sysctl = capture("sysctl", &args);
        let num = |k: &str| -> u64 { parse_sysctl(&sysctl, k).and_then(|v| v.parse().ok()).unwrap_or(0) };
        let ram_bytes = num("hw.memsize");
        let chip = parse_sysctl(&sysctl, "machdep.cpu.brand_string").unwrap_or_default();
        let (chip_generation, chip_tier) = parse_chip(&chip);
        let gpu_cores = parse_gpu_cores(&capture("ioreg", &["-rc", "AGXAccelerator", "-d", "1"]));
        let wired_mb = num("iogpu.wired_limit_mb");
        StaticProfile {
            chip_generation,
            chip_tier,
            cores: num("hw.ncpu") as u32,
            core_levels: read_core_levels(num("hw.nperflevels") as u32),
            gpu_cores,
            ram_bytes,
            // A Mac that does not publish memsize_usable (or a parse that
            // failed) falls back to memsize rather than to zero.
            ram_usable_bytes: match num("hw.memsize_usable") {
                0 => ram_bytes,
                usable => usable,
            },
            gpu: gpu_limits(),
            wired_limit_override_bytes: match wired_mb {
                0 => None,
                mb => Some(mb * 1024 * 1024),
            },
            bandwidth_gbs: published_bandwidth_gbs(chip_generation, chip_tier, gpu_cores),
            chip,
        }
    })
}

/// Apple's published memory bandwidth, GB/s, for the chips that existed when
/// this was written.
///
/// There is NO API and NO sysctl for memory bandwidth. This table is the
/// figure Apple states in its own newsroom announcements and technical
/// specifications for each chip, and it exists so the app can SHOW the user
/// what their machine is rather than to feed a calculation. A chip missing
/// from the table returns `None`, and every caller must keep working with
/// `None`, because a table of chip names is guaranteed to be out of date the
/// day a new Mac ships.
///
/// The Max tier is binned: an M3 Max with 30 GPU cores has 300 GB/s and one
/// with 40 has 400, so the GPU core count read from ioreg is what separates
/// them. When it is unknown the higher bin is NOT assumed; the entry is
/// skipped and the answer is `None`.
fn published_bandwidth_gbs(
    generation: Option<u32>,
    tier: ChipTier,
    gpu_cores: Option<u32>,
) -> Option<f64> {
    let generation = generation?;
    Some(match (generation, tier) {
        // The base M1 is deliberately ABSENT. Apple never published a figure
        // for it: it is in neither the M1 newsroom announcement nor any of the
        // M1 Mac technical specifications. The 68.25 GB/s everyone quotes is
        // back-computed from "nearly 6x that of M1" and "50 percent more than
        // M1" in two later announcements. A number nobody published is a
        // number this table does not have.
        (1, ChipTier::Pro) => 200.0,
        (1, ChipTier::Max) => 400.0,
        (1, ChipTier::Ultra) => 800.0,
        (2, ChipTier::Base) => 100.0,
        (2, ChipTier::Pro) => 200.0,
        (2, ChipTier::Max) => 400.0,
        (2, ChipTier::Ultra) => 800.0,
        (3, ChipTier::Base) => 100.0,
        // A regression against the M2 Pro's 200, and Apple's own figure.
        (3, ChipTier::Pro) => 150.0,
        // Binned: 14-core CPU with 30-core GPU is 300 GB/s, 16 with 40 is 400.
        (3, ChipTier::Max) => match gpu_cores? {
            c if c <= 30 => 300.0,
            _ => 400.0,
        },
        // 819 in the Mac Studio specifications, "over 800GB/s" in the
        // announcement. The specification is the precise one.
        (3, ChipTier::Ultra) => 819.0,
        (4, ChipTier::Base) => 120.0,
        (4, ChipTier::Pro) => 273.0,
        // Binned: the 32-core GPU part is 410 GB/s, the 40-core is 546.
        (4, ChipTier::Max) => match gpu_cores? {
            c if c <= 32 => 410.0,
            _ => 546.0,
        },
        (5, ChipTier::Base) => 153.0,
        (5, ChipTier::Pro) => 307.0,
        // Binned, and the CPU core count does NOT separate them: both parts
        // are 18-core CPUs, 32-core GPU at 460 GB/s and 40-core at 614. The
        // GPU core count is the only reading that tells them apart, which is
        // the whole reason ioreg is probed at all.
        (5, ChipTier::Max) => match gpu_cores? {
            c if c <= 32 => 460.0,
            _ => 614.0,
        },
        // Every other pair, including every chip released after this build.
        _ => return None,
    })
}

/// How hard macOS says the machine is being pushed thermally.
///
/// The five levels of `OSThermalPressureLevel`, from
/// `/usr/include/libkern/OSThermalNotification.h`. They are NOT the four cases
/// of `NSProcessInfo.thermalState`, and Apple documents no mapping between the
/// two, so they are reported under their own names rather than folded into the
/// Foundation ones.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ThermalPressure {
    Nominal,
    Moderate,
    Heavy,
    Trapping,
    Sleeping,
    /// notify key unreadable, or a level this build has never heard of.
    Unknown,
}

/// `notifyutil -g com.apple.system.thermalpressurelevel` prints
/// `com.apple.system.thermalpressurelevel 0`.
///
/// This is the reading `pmset -g therm` cannot give. On Apple Silicon pmset
/// answers "No CPU power status has been recorded" because
/// `IOPMCopyCPUPowerStatus` returns `kIOReturnNotFound`
/// (PowerManagement/pmset/pmset.m): the three warning levels it prints are
/// Intel-era mechanisms that nothing feeds here. Its own man page says "Not
/// available on all platforms." The notify key is fed, costs 1.5 ms, and needs
/// no root, unlike `powermetrics --samplers thermal`.
pub fn parse_thermal_pressure(notifyutil: &str) -> ThermalPressure {
    match notifyutil.split_whitespace().last() {
        Some("0") => ThermalPressure::Nominal,
        Some("1") => ThermalPressure::Moderate,
        Some("2") => ThermalPressure::Heavy,
        Some("3") => ThermalPressure::Trapping,
        Some("4") => ThermalPressure::Sleeping,
        _ => ThermalPressure::Unknown,
    }
}

/// The half of the machine that moves while the app is running.
///
/// All three of these change under the user, and none of them is a property of
/// the hardware. They are read again on every start, and shown live; what they
/// must never do is move a running engine, which is why nothing here feeds a
/// decision that is taken more than once per start.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiveState {
    /// Free plus inactive plus speculative, from vm_stat. `None` when vm_stat
    /// could not be read.
    pub available_bytes: Option<u64>,
    pub power_source: PowerSource,
    pub power_mode: PowerMode,
    pub thermal: ThermalPressure,
}

/// Read the moving half. About 13 ms: one vm_stat, two pmset calls and one
/// notifyutil.
pub fn live_state(available_bytes: Option<u64>) -> LiveState {
    LiveState {
        available_bytes,
        power_source: parse_power_source(&capture("pmset", &["-g", "ps"])),
        power_mode: parse_power_mode(&capture("pmset", &["-g"])),
        thermal: parse_thermal_pressure(&capture(
            "notifyutil",
            &["-g", "com.apple.system.thermalpressurelevel"],
        )),
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chip_is_read_as_a_generation_and_a_tier() {
        assert_eq!(parse_chip("Apple M1"), (Some(1), ChipTier::Base));
        assert_eq!(parse_chip("Apple M1 Pro"), (Some(1), ChipTier::Pro));
        assert_eq!(parse_chip("Apple M2 Max"), (Some(2), ChipTier::Max));
        assert_eq!(parse_chip("Apple M3 Ultra"), (Some(3), ChipTier::Ultra));
        assert_eq!(parse_chip("Apple M5 Max"), (Some(5), ChipTier::Max));
        // Two digits, so the parser must not read one character.
        assert_eq!(parse_chip("Apple M10 Pro"), (Some(10), ChipTier::Pro));
    }

    #[test]
    fn a_machine_that_is_not_an_apple_silicon_mac_is_unknown_rather_than_guessed() {
        assert_eq!(
            parse_chip("Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz"),
            (None, ChipTier::Unknown)
        );
        assert_eq!(parse_chip(""), (None, ChipTier::Unknown));
        // A tier that does not exist yet must not be filed under Base: a
        // policy keyed on Base would then be applied to a chip nobody sized.
        assert_eq!(parse_chip("Apple M9 Extreme"), (Some(9), ChipTier::Unknown));
    }

    #[test]
    fn gpu_cores_come_out_of_the_ioreg_property() {
        // Trimmed from the real output of `ioreg -rc AGXAccelerator -d 1`.
        let ioreg = r#"+-o AGXAcceleratorG17X  <class AGXAcceleratorG17X, id 0x100000571>
    {
      "gpu-core-count" = 40
      "GPUConfigurationVariable" = {"num_cores"=40,"gpu_gen"=17}
    }"#;
        assert_eq!(parse_gpu_cores(ioreg), Some(40));
        assert_eq!(parse_gpu_cores(""), None);
        assert_eq!(parse_gpu_cores("\"gpu-core-count\" = "), None);
    }

    #[test]
    fn sysctl_values_may_contain_colons_and_spaces() {
        let out = "hw.memsize: 137438953472\nmachdep.cpu.brand_string: Intel(R) Core(TM) i9 @ 2.30GHz\n";
        assert_eq!(parse_sysctl(out, "hw.memsize").as_deref(), Some("137438953472"));
        assert_eq!(
            parse_sysctl(out, "machdep.cpu.brand_string").as_deref(),
            Some("Intel(R) Core(TM) i9 @ 2.30GHz")
        );
        assert_eq!(parse_sysctl(out, "hw.ncpu"), None);
    }

    #[test]
    fn the_power_source_is_read_from_the_line_pmset_actually_prints() {
        assert_eq!(
            parse_power_source("Now drawing from 'AC Power'\n -InternalBattery-0 80%; AC attached"),
            PowerSource::Ac
        );
        assert_eq!(
            parse_power_source("Now drawing from 'Battery Power'\n -InternalBattery-0 62%"),
            PowerSource::Battery
        );
        assert_eq!(parse_power_source(""), PowerSource::Unknown);
    }

    #[test]
    fn the_energy_mode_is_read_and_a_mac_without_one_is_automatic() {
        let g = "System-wide power settings:\nCurrently in use:\n standby              1\n powermode            2\n womp                 1";
        assert_eq!(parse_power_mode(g), PowerMode::High);
        assert_eq!(parse_power_mode(" powermode            1"), PowerMode::Low);
        assert_eq!(parse_power_mode(" powermode            0"), PowerMode::Automatic);
        // No such line: the user has not asked for anything special.
        assert_eq!(parse_power_mode(" standby              1"), PowerMode::Automatic);
    }

    #[test]
    fn bandwidth_is_none_for_a_chip_the_table_has_never_heard_of() {
        // The whole point of the None: a table of chip names is out of date
        // the day a new Mac ships, and the app has to keep working.
        assert_eq!(published_bandwidth_gbs(Some(9), ChipTier::Max, Some(40)), None);
        assert_eq!(published_bandwidth_gbs(None, ChipTier::Max, Some(40)), None);
        assert_eq!(published_bandwidth_gbs(Some(4), ChipTier::Unknown, Some(40)), None);
        // The base M1 too: Apple published no figure for it, and the 68.25
        // everyone quotes is back-computed from two later announcements.
        assert_eq!(published_bandwidth_gbs(Some(1), ChipTier::Base, None), None);
    }

    #[test]
    fn the_thermal_pressure_level_is_read_from_the_notify_key_that_is_actually_fed() {
        assert_eq!(
            parse_thermal_pressure("com.apple.system.thermalpressurelevel 0"),
            ThermalPressure::Nominal
        );
        assert_eq!(
            parse_thermal_pressure("com.apple.system.thermalpressurelevel 2"),
            ThermalPressure::Heavy
        );
        assert_eq!(
            parse_thermal_pressure("com.apple.system.thermalpressurelevel 4"),
            ThermalPressure::Sleeping
        );
        // A level this build has never heard of is Unknown, never Nominal:
        // reading a new level as "everything is fine" is the one wrong answer.
        assert_eq!(
            parse_thermal_pressure("com.apple.system.thermalpressurelevel 9"),
            ThermalPressure::Unknown
        );
        assert_eq!(parse_thermal_pressure(""), ThermalPressure::Unknown);
    }

    #[test]
    fn a_binned_max_is_separated_by_its_gpu_cores_and_never_assumed() {
        assert_eq!(published_bandwidth_gbs(Some(4), ChipTier::Max, Some(32)), Some(410.0));
        assert_eq!(published_bandwidth_gbs(Some(4), ChipTier::Max, Some(40)), Some(546.0));
        assert_eq!(published_bandwidth_gbs(Some(3), ChipTier::Max, Some(30)), Some(300.0));
        assert_eq!(published_bandwidth_gbs(Some(3), ChipTier::Max, Some(40)), Some(400.0));
        // Unknown core count on a binned tier: no bin is assumed.
        assert_eq!(published_bandwidth_gbs(Some(4), ChipTier::Max, None), None);
        // An unbinned tier does not need the core count.
        assert_eq!(published_bandwidth_gbs(Some(4), ChipTier::Pro, None), Some(273.0));
    }

    #[test]
    fn this_machine_answers_every_probe_with_something_plausible() {
        // Not fixed values: this runs on whatever Mac the developer or CI has.
        // The point is that each probe parses and lands where no parsing bug
        // would land.
        let p = super::static_profile();
        assert!(p.ram_bytes >= 4_000_000_000, "ram_bytes: {}", p.ram_bytes);
        assert!(p.ram_usable_bytes <= p.ram_bytes);
        assert!(p.cores >= 2 && p.cores <= 256, "cores: {}", p.cores);
        assert!(!p.chip.is_empty());
        // The perf levels must add up to hw.ncpu, or a level was dropped.
        if !p.core_levels.is_empty() {
            let summed: u32 = p.core_levels.iter().map(|l| l.count).sum();
            assert_eq!(summed, p.cores, "core levels {:?} vs ncpu {}", p.core_levels, p.cores);
            // Names come from macOS, never from this code.
            assert!(p.core_levels.iter().all(|l| !l.name.is_empty()));
        }
        if let Some(g) = p.gpu {
            assert!(g.working_set_bytes > 1_000_000_000, "working set: {}", g.working_set_bytes);
            assert!(g.working_set_bytes <= p.ram_bytes, "working set exceeds installed RAM");
            assert!(g.max_buffer_bytes > 0);
        }
    }
}
