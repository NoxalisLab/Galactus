// Galactus, the clock a scheduled job lives on.
//
// WHY THE CLOCK IS IN RUST
//
// The agent loop lives in the webview. A schedule that also lived there would
// be a schedule that dies with the window, and the whole point of a scheduled
// job is that nobody is there to keep it alive. So the parsing, the next fire
// and the catch-up arithmetic are here, in the process that outlives every
// view, and the frontend is told when to work rather than asked to remember.
//
// WHY NO CRATE
//
// `cron` and `chrono` would both do this. Neither is in Cargo.toml, and the
// job is calendar arithmetic plus a bitmask match: about as much code as the
// licence review would be. relay.rs made the same call for HTTP.
//
// THE ONE HARD PART IS NOT PARSING, IT IS THE WALL CLOCK
//
// "30 2 * * *" is not a statement about elapsed seconds, it is a statement
// about what a clock on a wall reads. Twice a year that clock lies:
//
//   spring forward   02:30 does not happen at all
//   fall back        02:30 happens twice
//
// Doing the arithmetic in UTC and adding an offset afterwards gets both cases
// wrong, silently, and only in March and October. So the search below walks
// LOCAL minutes and converts each candidate to an instant, which makes each
// wall clock reading occur exactly once per day by construction:
//
//   a local time that does not exist fires at the instant the clock jumps,
//   which is the first moment the wall clock is past what was asked for;
//   a local time that happens twice fires on the FIRST of the two.
//
// Both rules are pinned by tests against a zone the test owns, not against
// whatever /etc/localtime happens to say on the machine running CI.
//
// An interval (`30m`, `every 2h`) is deliberately NOT wall clock. It is
// counted from the previous fire, so it is immune to all of the above, and a
// user who wants "every two hours" gets two hours even in March.

// ---------------------------------------------------------------- civil time

/// A reading of a wall clock. No zone attached: the zone is the thing that
/// turns one of these into an instant, and vice versa.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Civil {
    pub year: i32,
    /// 1..=12
    pub month: u32,
    /// 1..=31
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`, which is exact for every year this app can reach).
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y as i64 - 1 } else { y as i64 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse.
pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

pub fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 0 is Sunday, matching the cron field. 1970-01-01 was a Thursday.
pub fn weekday(year: i32, month: u32, day: u32) -> u32 {
    (days_from_civil(year, month, day) + 4).rem_euclid(7) as u32
}

/// Seconds since the epoch for a civil reading taken as UTC.
pub fn unix_from_civil_utc(c: &Civil) -> i64 {
    days_from_civil(c.year, c.month, c.day) * 86_400
        + c.hour as i64 * 3600
        + c.minute as i64 * 60
        + c.second as i64
}

/// The inverse.
pub fn civil_from_unix_utc(t: i64) -> Civil {
    let days = t.div_euclid(86_400);
    let rest = t.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Civil {
        year,
        month,
        day,
        hour: (rest / 3600) as u32,
        minute: (rest % 3600 / 60) as u32,
        second: (rest % 60) as u32,
    }
}

// ---------------------------------------------------------------- zones

/// Everything the schedule needs to know about a time zone: the offset from
/// UTC in effect at a given instant. One method, because that is genuinely all
/// of it, and because a one-method trait is a trait a test can implement in
/// four lines with a DST rule it chose itself.
pub trait Zone {
    /// Seconds to ADD to UTC to get local time at this instant.
    fn offset(&self, unix: i64) -> i32;
}

/// No offset, ever. Used by the CLI-ish paths and by tests that do not care.
pub struct Utc;

impl Zone for Utc {
    fn offset(&self, _unix: i64) -> i32 {
        0
    }
}

/// A zone that never changes. Enough for most of the world and for most tests.
pub struct Fixed(pub i32);

impl Zone for Fixed {
    fn offset(&self, _unix: i64) -> i32 {
        self.0
    }
}

/// The machine's own zone, DST rules included, straight from libc.
///
/// `localtime_r` is the only correct source here: it reads the same tzdata the
/// rest of the system reads, so a job set for 08:00 fires when the user's
/// clock says 08:00 and keeps doing so after the next tzdata update. Parsing
/// /etc/localtime by hand would be a second, slowly diverging implementation
/// of the same table. pty.rs already declares libc symbols directly, for the
/// same reason: they are in libSystem, which is linked either way.
pub struct Local;

#[cfg(target_os = "macos")]
#[repr(C)]
struct Tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const i8,
}

#[cfg(target_os = "macos")]
extern "C" {
    fn localtime_r(clock: *const i64, result: *mut Tm) -> *mut Tm;
}

impl Zone for Local {
    #[cfg(target_os = "macos")]
    fn offset(&self, unix: i64) -> i32 {
        // SAFETY: `localtime_r` writes into a caller-owned struct and reads a
        // caller-owned time_t. Darwin's time_t is 64 bit, which is what i64
        // is here. The reentrant form is the one taken on purpose: the tick
        // thread is not the main thread, and `localtime` returns a shared
        // static that another thread can overwrite mid read.
        unsafe {
            let mut tm: Tm = std::mem::zeroed();
            let t = unix;
            if localtime_r(&t as *const i64, &mut tm as *mut Tm).is_null() {
                return 0;
            }
            tm.tm_gmtoff as i32
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn offset(&self, _unix: i64) -> i32 {
        0
    }
}

/// The wall clock reading at an instant.
pub fn civil_at(zone: &dyn Zone, unix: i64) -> Civil {
    civil_from_unix_utc(unix + zone.offset(unix) as i64)
}

/// The instant at which a wall clock reads `c`.
///
/// The two awkward cases are decided here, once, rather than at each call
/// site:
///
///   the reading happens TWICE (fall back): the earlier instant wins, so a
///   daily job fires once and not twice;
///   the reading NEVER happens (spring forward): the instant the clock jumps
///   wins, so a daily job fires once and not zero times. Two readings inside
///   the same gap therefore collapse onto the same instant, which is what
///   makes "fires at most once" true without a special case.
pub fn unix_at(zone: &dyn Zone, c: &Civil) -> i64 {
    let naive = unix_from_civil_utc(c);
    // Any single transition within a day of the target is covered by probing
    // the offset a day either side; nowhere on earth transitions twice in
    // twenty four hours.
    let mut offsets = [
        zone.offset(naive - 86_400),
        zone.offset(naive),
        zone.offset(naive + 86_400),
    ];
    offsets.sort_unstable();
    let mut best: Option<i64> = None;
    for o in offsets {
        let t = naive - o as i64;
        if civil_at(zone, t) == *c {
            best = Some(match best {
                Some(b) if b <= t => b,
                _ => t,
            });
        }
    }
    if let Some(t) = best {
        return t;
    }
    // No instant reads this. The clock jumped over it: fire where it landed.
    let lo = naive - offsets[offsets.len() - 1] as i64;
    let hi = naive - offsets[0] as i64;
    transition_between(zone, lo, hi)
}

/// The first instant in (lo, hi] whose offset differs from the offset at `lo`.
fn transition_between(zone: &dyn Zone, mut lo: i64, mut hi: i64) -> i64 {
    let base = zone.offset(lo);
    if zone.offset(hi) == base {
        return hi;
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if zone.offset(mid) == base {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi
}

// ---------------------------------------------------------------- the spec

/// A parsed five field cron expression, as five bitmasks.
///
/// `dom_star` and `dow_star` are kept beside the masks because the POSIX day
/// rule needs to know whether a field was WRITTEN as `*`, not merely whether
/// it happens to match everything. See `day_matches`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CronSpec {
    /// bits 0..=59
    minutes: u64,
    /// bits 0..=23
    hours: u32,
    /// bits 1..=31
    doms: u32,
    /// bits 1..=12
    months: u16,
    /// bits 0..=6, 0 is Sunday
    dows: u8,
    dom_star: bool,
    dow_star: bool,
}

impl CronSpec {
    fn minute_matches(&self, m: u32) -> bool {
        self.minutes & (1u64 << m) != 0
    }

    fn hour_matches(&self, h: u32) -> bool {
        self.hours & (1u32 << h) != 0
    }

    fn month_matches(&self, m: u32) -> bool {
        self.months & (1u16 << m) != 0
    }

    /// The rule that trips everyone up.
    ///
    /// When BOTH the day of month and the day of week are restricted, a day
    /// matches if EITHER does. "0 0 13 * 5" is every Friday AND every 13th,
    /// not only Friday the 13th. When one of the two is `*`, only the other
    /// one is consulted, or every Sunday-plus-`*` expression would fire daily.
    fn day_matches(&self, c: &Civil) -> bool {
        let dom = self.doms & (1u32 << c.day) != 0;
        let dow = self.dows & (1u8 << weekday(c.year, c.month, c.day)) != 0;
        match (self.dom_star, self.dow_star) {
            (true, true) => true,
            (false, true) => dom,
            (true, false) => dow,
            (false, false) => dom || dow,
        }
    }
}

const MONTH_NAMES: [(&str, u32); 12] = [
    ("jan", 1),
    ("feb", 2),
    ("mar", 3),
    ("apr", 4),
    ("may", 5),
    ("jun", 6),
    ("jul", 7),
    ("aug", 8),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];

const DAY_NAMES: [(&str, u32); 8] = [
    ("sun", 0),
    ("mon", 1),
    ("tue", 2),
    ("wed", 3),
    ("thu", 4),
    ("fri", 5),
    ("sat", 6),
    // Accepted because crontab(5) does: 7 and "sun" are the same day.
    ("sun", 7),
];

/// One field into a bitmask. `min`/`max` bound it; `names` are the three
/// letter aliases a human types instead of a number.
fn parse_field(text: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Result<u64, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty field".into());
    }
    let mut mask: u64 = 0;
    for item in text.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err(format!("empty item in \"{text}\""));
        }
        let (range, step) = match item.split_once('/') {
            Some((r, s)) => {
                let n: u32 = s
                    .trim()
                    .parse()
                    .map_err(|_| format!("\"{s}\" is not a step"))?;
                if n == 0 {
                    return Err("a step of 0 never fires".into());
                }
                (r.trim(), n)
            }
            None => (item, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            let a = parse_value(a.trim(), min, max, names)?;
            let b = parse_value(b.trim(), min, max, names)?;
            if a > b {
                return Err(format!("range {a}-{b} runs backwards"));
            }
            (a, b)
        } else {
            let v = parse_value(range, min, max, names)?;
            // Vixie's reading: "5/2" means "from 5 to the end, every 2".
            if step > 1 {
                (v, max)
            } else {
                (v, v)
            }
        };
        let mut v = lo;
        while v <= hi {
            mask |= 1u64 << v;
            v += step;
        }
    }
    if mask == 0 {
        return Err(format!("\"{text}\" matches nothing"));
    }
    Ok(mask)
}

fn parse_value(text: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Result<u32, String> {
    let lower = text.to_ascii_lowercase();
    for (name, value) in names {
        if lower.starts_with(name) && lower.len() == 3 {
            return Ok(*value);
        }
    }
    let v: u32 = text
        .parse()
        .map_err(|_| format!("\"{text}\" is not a number"))?;
    if v < min || v > max {
        return Err(format!("{v} is outside {min}-{max}"));
    }
    Ok(v)
}

/// Parse the five fields: minute hour day-of-month month day-of-week.
pub fn parse_cron(expr: &str) -> Result<CronSpec, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "a cron expression has 5 fields (minute hour day month weekday), got {}",
            fields.len()
        ));
    }
    let minutes = parse_field(fields[0], 0, 59, &[])?;
    let hours = parse_field(fields[1], 0, 23, &[])? as u32;
    let doms = parse_field(fields[2], 1, 31, &[])? as u32;
    let months = parse_field(fields[3], 1, 12, &MONTH_NAMES)? as u16;
    let dows_raw = parse_field(fields[4], 0, 7, &DAY_NAMES)?;
    // 7 and 0 are the same day. Folding here rather than at match time keeps
    // the mask eight bits wide and the comparison a single shift.
    let dows = ((dows_raw | (dows_raw >> 7)) & 0x7f) as u8;
    Ok(CronSpec {
        minutes,
        hours,
        doms,
        months,
        dows,
        dom_star: fields[2].trim() == "*",
        dow_star: fields[4].trim() == "*",
    })
}

// ---------------------------------------------------------------- schedules

/// What a job is set to. Two shapes, because humans write both.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Schedule {
    /// A wall clock statement. Subject to DST, deliberately.
    Cron(CronSpec),
    /// A plain interval in seconds, counted from the previous fire. Never
    /// aligned to the clock and never moved by DST.
    Every(i64),
}

/// The shortest interval accepted. The tick runs on a coarse timer and a run
/// takes minutes: anything under a minute would be a promise the rest of the
/// system cannot keep.
pub const MIN_INTERVAL_SECS: i64 = 60;
/// The longest. A year is already a schedule nobody should trust an app to
/// remember, and it keeps the catch-up arithmetic in a sane range.
pub const MAX_INTERVAL_SECS: i64 = 366 * 86_400;

fn parse_interval(text: &str) -> Option<Result<i64, String>> {
    let mut body = text.trim().to_ascii_lowercase();
    for lead in ["every ", "each ", "every", "each"] {
        if let Some(rest) = body.strip_prefix(lead) {
            body = rest.trim().to_string();
            break;
        }
    }
    let cut = body.find(|c: char| !c.is_ascii_digit())?;
    if cut == 0 {
        return None;
    }
    let (number, unit) = body.split_at(cut);
    let unit = unit.trim();
    let n: i64 = match number.parse() {
        Ok(n) => n,
        Err(_) => return Some(Err(format!("\"{number}\" is not a number"))),
    };
    let scale = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => 86_400,
        _ => return None,
    };
    let secs = n.saturating_mul(scale);
    if secs < MIN_INTERVAL_SECS {
        return Some(Err(format!(
            "the shortest interval is {MIN_INTERVAL_SECS} seconds"
        )));
    }
    if secs > MAX_INTERVAL_SECS {
        return Some(Err("the longest interval is 366 days".into()));
    }
    Some(Ok(secs))
}

/// Everything a human might reasonably type, in one entry point.
///
/// The named aliases and the interval forms are tried FIRST and only fall
/// through to cron when they do not apply, so an unparsable schedule reports
/// the cron error rather than "not an interval", which is the message a person
/// who typed a cron expression needs.
pub fn parse_schedule(text: &str) -> Result<Schedule, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("a job needs a schedule".into());
    }
    let alias = match trimmed.to_ascii_lowercase().as_str() {
        "@hourly" => Some("0 * * * *"),
        "@daily" | "@midnight" => Some("0 0 * * *"),
        "@weekly" => Some("0 0 * * 0"),
        "@monthly" => Some("0 0 1 * *"),
        "@yearly" | "@annually" => Some("0 0 1 1 *"),
        _ => None,
    };
    if let Some(expr) = alias {
        return parse_cron(expr).map(Schedule::Cron);
    }
    if let Some(interval) = parse_interval(trimmed) {
        return interval.map(Schedule::Every);
    }
    parse_cron(trimmed).map(Schedule::Cron)
}

/// A schedule, written back the way the engine understood it. Shown in the UI
/// so "30m" and "*/30 * * * *" stop looking like the same thing.
pub fn describe(schedule: &Schedule) -> String {
    match schedule {
        Schedule::Every(secs) => {
            let s = *secs;
            if s % 86_400 == 0 {
                format!("every {} day(s), counted from the last fire", s / 86_400)
            } else if s % 3600 == 0 {
                format!("every {} hour(s), counted from the last fire", s / 3600)
            } else {
                format!("every {} minute(s), counted from the last fire", s / 60)
            }
        }
        Schedule::Cron(_) => "on the local wall clock".into(),
    }
}

// ---------------------------------------------------------------- next fire

/// How far ahead the search will look before giving up. Twelve years, because
/// "0 0 29 2 *" can legitimately skip eight of them: 2096 is a leap year, 2100
/// is not, and the next 29 February is 2104. A shorter horizon would report
/// "never" for a schedule that is merely patient.
const HORIZON_YEARS: i32 = 12;

fn next_minute(c: Civil) -> Civil {
    let mut c = c;
    c.second = 0;
    if c.minute < 59 {
        c.minute += 1;
        return c;
    }
    c.minute = 0;
    next_hour_keep(c)
}

fn next_hour(c: Civil) -> Civil {
    let mut c = c;
    c.second = 0;
    c.minute = 0;
    next_hour_keep(c)
}

fn next_hour_keep(c: Civil) -> Civil {
    let mut c = c;
    if c.hour < 23 {
        c.hour += 1;
        return c;
    }
    c.hour = 0;
    next_day_keep(c)
}

fn next_day(c: Civil) -> Civil {
    let mut c = c;
    c.second = 0;
    c.minute = 0;
    c.hour = 0;
    next_day_keep(c)
}

fn next_day_keep(c: Civil) -> Civil {
    let mut c = c;
    if c.day < days_in_month(c.year, c.month) {
        c.day += 1;
        return c;
    }
    c.day = 1;
    next_month_keep(c)
}

fn next_month(c: Civil) -> Civil {
    let mut c = c;
    c.second = 0;
    c.minute = 0;
    c.hour = 0;
    c.day = 1;
    next_month_keep(c)
}

fn next_month_keep(c: Civil) -> Civil {
    let mut c = c;
    if c.month < 12 {
        c.month += 1;
        return c;
    }
    c.month = 1;
    c.year += 1;
    c
}

/// The first instant strictly after `after` at which this expression fires.
///
/// The walk is over LOCAL minutes, with whole months, days and hours skipped
/// when their field cannot match, so the worst case is a few thousand cheap
/// comparisons rather than a minute-by-minute crawl through a decade.
pub fn next_cron_after(spec: &CronSpec, after: i64, zone: &dyn Zone) -> Option<i64> {
    let start = after - after.rem_euclid(60) + 60;
    let mut c = civil_at(zone, start);
    c.second = 0;
    let deadline = c.year + HORIZON_YEARS;
    loop {
        if c.year > deadline {
            return None;
        }
        if !spec.month_matches(c.month) {
            c = next_month(c);
            continue;
        }
        if !spec.day_matches(&c) {
            c = next_day(c);
            continue;
        }
        if !spec.hour_matches(c.hour) {
            c = next_hour(c);
            continue;
        }
        if !spec.minute_matches(c.minute) {
            c = next_minute(c);
            continue;
        }
        let t = unix_at(zone, &c);
        // A gap collapses several readings onto one instant, and the fall back
        // hour is walked from its first occurrence: both can produce a
        // candidate that is not actually in the future. Skip it rather than
        // firing in the past.
        if t > after {
            return Some(t);
        }
        c = next_minute(c);
    }
}

/// The next fire of any schedule.
///
/// `anchor` is what an interval counts from: the previous fire, or the moment
/// the job was enabled when it has never fired. It is ignored by a cron
/// expression, which counts from the calendar and from nothing else.
pub fn next_fire(schedule: &Schedule, after: i64, anchor: i64, zone: &dyn Zone) -> Option<i64> {
    match schedule {
        Schedule::Cron(spec) => next_cron_after(spec, after, zone),
        Schedule::Every(secs) => {
            let mut t = anchor.saturating_add(*secs);
            // An interval whose anchor is far in the past would otherwise
            // report a next fire that already happened. Step it forward to the
            // first one that has not, which is also what makes the catch-up
            // arithmetic below terminate.
            if t <= after {
                let behind = after - anchor;
                let skips = behind / *secs + 1;
                t = anchor.saturating_add(skips.saturating_mul(*secs));
            }
            Some(t)
        }
    }
}

/// What fell due between `anchor` (exclusive) and `now` (inclusive).
///
/// `last` is the one that matters for the catch-up decision; `count` and
/// `saturated` exist so the UI can say "47 fires were missed" instead of
/// pretending nothing happened. Counting stops at `cap` because a per-minute
/// job and a laptop closed for a month is 43200 iterations nobody needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Missed {
    pub count: u32,
    pub saturated: bool,
    pub last: Option<i64>,
}

pub fn missed_since(
    schedule: &Schedule,
    anchor: i64,
    now: i64,
    zone: &dyn Zone,
    cap: u32,
) -> Missed {
    let mut out = Missed {
        count: 0,
        saturated: false,
        last: None,
    };
    match schedule {
        Schedule::Every(secs) => {
            if now <= anchor {
                return out;
            }
            let n = (now - anchor) / *secs;
            if n <= 0 {
                return out;
            }
            out.count = n.min(cap as i64) as u32;
            out.saturated = n > cap as i64;
            out.last = Some(anchor + n * *secs);
            out
        }
        Schedule::Cron(_) => {
            let mut cursor = anchor;
            loop {
                let Some(t) = next_fire(schedule, cursor, anchor, zone) else {
                    return out;
                };
                if t > now {
                    return out;
                }
                out.last = Some(t);
                if out.count < cap {
                    out.count += 1;
                } else {
                    // The count is no longer exact, but `last` still has to be,
                    // so the walk continues. It is bounded by `now`.
                    out.saturated = true;
                }
                cursor = t;
            }
        }
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A zone with exactly one spring forward and one fall back, at instants
    /// this test names outright. Real tzdata would make the assertions depend
    /// on a file the test does not own and cannot pin.
    ///
    ///   2024-03-31T01:00:00Z  +1 becomes +2   (local 02:00 becomes 03:00)
    ///   2024-10-27T01:00:00Z  +2 becomes +1   (local 03:00 becomes 02:00)
    struct Europe;

    const SPRING: i64 = 1_711_846_800;
    const FALL: i64 = 1_729_990_800;

    impl Zone for Europe {
        fn offset(&self, unix: i64) -> i32 {
            if unix >= SPRING && unix < FALL {
                7200
            } else {
                3600
            }
        }
    }

    fn utc(text: &str) -> i64 {
        // "YYYY-MM-DDTHH:MM:SSZ", the only shape the tests write.
        let b = text.as_bytes();
        let n = |a: usize, b2: usize| text[a..b2].parse::<i64>().expect("number");
        assert_eq!(b.len(), 20, "timestamp shape");
        unix_from_civil_utc(&Civil {
            year: n(0, 4) as i32,
            month: n(5, 7) as u32,
            day: n(8, 10) as u32,
            hour: n(11, 13) as u32,
            minute: n(14, 16) as u32,
            second: n(17, 19) as u32,
        })
    }

    fn cron(expr: &str) -> CronSpec {
        parse_cron(expr).expect(expr)
    }

    // ------------------------------------------------------------ calendar

    #[test]
    fn civil_and_days_round_trip_across_centuries() {
        for (y, m, d) in [
            (1970, 1, 1),
            (1999, 12, 31),
            (2000, 2, 29),
            (2024, 2, 29),
            (2100, 2, 28),
            (2104, 2, 29),
            (2400, 12, 31),
        ] {
            let z = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(z), (y, m, d), "{y}-{m}-{d}");
        }
        assert_eq!(unix_from_civil_utc(&civil_from_unix_utc(0)), 0);
        assert_eq!(
            civil_from_unix_utc(utc("2024-02-29T13:45:07Z")).day,
            29,
            "a leap day must survive the round trip"
        );
    }

    #[test]
    fn the_century_rule_is_the_gregorian_one_and_not_divisible_by_four() {
        assert!(is_leap(2024));
        assert!(is_leap(2000));
        assert!(!is_leap(2100), "2100 is not a leap year");
        assert!(!is_leap(1900));
        assert_eq!(days_in_month(2100, 2), 28);
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2024, 4), 30);
    }

    #[test]
    fn weekdays_are_zero_for_sunday() {
        assert_eq!(weekday(1970, 1, 1), 4, "a Thursday");
        assert_eq!(weekday(2024, 5, 12), 0, "a Sunday");
        assert_eq!(weekday(2024, 5, 13), 1, "a Monday");
        assert_eq!(weekday(2024, 9, 13), 5, "Friday the 13th");
    }

    // ------------------------------------------------------------ parsing

    #[test]
    fn every_field_form_parses() {
        let s = cron("*/15 0-6,20 1,15 jan-mar mon-fri");
        for m in [0u32, 15, 30, 45] {
            assert!(s.minute_matches(m));
        }
        assert!(!s.minute_matches(14));
        for h in 0..=6u32 {
            assert!(s.hour_matches(h));
        }
        assert!(s.hour_matches(20));
        assert!(!s.hour_matches(7));
        assert!(s.month_matches(3));
        assert!(!s.month_matches(4));
        assert!(!s.dom_star);
        assert!(!s.dow_star);
    }

    #[test]
    fn seven_and_sunday_are_the_same_day() {
        let a = cron("0 0 * * 0");
        let b = cron("0 0 * * 7");
        let c = cron("0 0 * * sun");
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(a.dows, 1, "only the Sunday bit");
    }

    #[test]
    fn a_step_from_a_value_runs_to_the_end_of_the_field() {
        // Vixie's reading of "5/10": from 5 to 59, every 10.
        let s = cron("5/10 * * * *");
        for m in [5u32, 15, 25, 35, 45, 55] {
            assert!(s.minute_matches(m), "{m}");
        }
        assert!(!s.minute_matches(6));
        assert!(!s.minute_matches(0));
    }

    #[test]
    fn nonsense_is_refused_with_a_reason_and_never_defaulted() {
        for (expr, needle) in [
            ("* * * *", "5 fields"),
            ("* * * * * *", "5 fields"),
            ("60 * * * *", "outside 0-59"),
            ("* 24 * * *", "outside 0-23"),
            ("* * 0 * *", "outside 1-31"),
            ("* * * 13 *", "outside 1-12"),
            ("* * * * 8", "outside 0-7"),
            ("*/0 * * * *", "step of 0"),
            ("10-5 * * * *", "backwards"),
            ("abc * * * *", "not a number"),
            ("1,,2 * * * *", "empty item"),
        ] {
            let err = parse_cron(expr).expect_err(expr);
            assert!(err.contains(needle), "{expr}: got {err}");
        }
    }

    #[test]
    fn the_forms_a_human_actually_types_are_understood() {
        assert_eq!(parse_schedule("30m").expect("30m"), Schedule::Every(1800));
        assert_eq!(parse_schedule("every 2h").expect("2h"), Schedule::Every(7200));
        assert_eq!(
            parse_schedule("every 90 minutes").expect("90 minutes"),
            Schedule::Every(5400)
        );
        assert_eq!(parse_schedule("1d").expect("1d"), Schedule::Every(86_400));
        assert_eq!(parse_schedule("  EVERY 1 Hour ").expect("case"), Schedule::Every(3600));
        assert_eq!(
            parse_schedule("@daily").expect("@daily"),
            Schedule::Cron(cron("0 0 * * *"))
        );
        assert_eq!(
            parse_schedule("*/5 * * * *").expect("cron"),
            Schedule::Cron(cron("*/5 * * * *"))
        );
    }

    #[test]
    fn an_interval_shorter_than_the_tick_is_refused_rather_than_rounded() {
        let err = parse_schedule("30s").expect_err("30s");
        assert!(err.contains("shortest interval"), "got {err}");
        let err = parse_schedule("400d").expect_err("400d");
        assert!(err.contains("366 days"), "got {err}");
        // An empty schedule must not silently become "never".
        assert!(parse_schedule("   ").is_err());
    }

    #[test]
    fn an_unparsable_schedule_reports_the_cron_error_not_the_interval_one() {
        // Someone who typed four fields wants to hear about the fifth, not
        // about units of time they never mentioned.
        let err = parse_schedule("0 9 * *").expect_err("four fields");
        assert!(err.contains("5 fields"), "got {err}");
    }

    // ------------------------------------------------------------ next fire

    #[test]
    fn the_next_fire_is_strictly_after_the_instant_asked_about() {
        let s = cron("*/10 * * * *");
        let t = utc("2024-05-15T10:20:00Z");
        assert_eq!(
            next_cron_after(&s, t, &Utc),
            Some(utc("2024-05-15T10:30:00Z")),
            "the minute it is already is not the next one"
        );
        assert_eq!(
            next_cron_after(&s, t - 1, &Utc),
            Some(t),
            "one second earlier and it is"
        );
    }

    #[test]
    fn a_month_end_is_crossed_without_inventing_a_thirty_first() {
        let s = cron("0 0 31 * *");
        let mut t = utc("2024-01-01T00:00:00Z");
        let mut seen = Vec::new();
        for _ in 0..7 {
            t = next_cron_after(&s, t, &Utc).expect("a 31st");
            let c = civil_from_unix_utc(t);
            seen.push((c.year, c.month, c.day));
        }
        assert_eq!(
            seen,
            vec![
                (2024, 1, 31),
                (2024, 3, 31),
                (2024, 5, 31),
                (2024, 7, 31),
                (2024, 8, 31),
                (2024, 10, 31),
                (2024, 12, 31),
            ],
            "February, April, June, September and November have no 31st"
        );
    }

    #[test]
    fn february_29_waits_for_a_leap_year_and_skips_the_century() {
        let s = cron("0 0 29 2 *");
        let t = next_cron_after(&s, utc("2023-03-01T00:00:00Z"), &Utc).expect("leap day");
        assert_eq!(t, utc("2024-02-29T00:00:00Z"));
        // 2096 is a leap year, 2100 is not: the next one is eight years later,
        // which is the case a shorter search horizon would report as "never".
        let t = next_cron_after(&s, utc("2096-03-01T00:00:00Z"), &Utc).expect("2104");
        assert_eq!(t, utc("2104-02-29T00:00:00Z"));
    }

    #[test]
    fn the_last_day_of_february_differs_by_year() {
        let s = cron("0 12 28 2 *");
        assert_eq!(
            next_cron_after(&s, utc("2023-02-01T00:00:00Z"), &Utc),
            Some(utc("2023-02-28T12:00:00Z"))
        );
        assert_eq!(
            next_cron_after(&s, utc("2024-02-01T00:00:00Z"), &Utc),
            Some(utc("2024-02-28T12:00:00Z")),
            "the 28th still exists in a leap year"
        );
    }

    #[test]
    fn day_of_month_and_day_of_week_are_ored_when_both_are_restricted() {
        // September 2024: Fridays are the 6th, 13th, 20th, 27th. The 13th is
        // one of them, so the OR must not be mistaken for an AND.
        let s = cron("0 0 13 * 5");
        let mut t = utc("2024-09-01T00:00:00Z");
        let mut days = Vec::new();
        for _ in 0..4 {
            t = next_cron_after(&s, t, &Utc).expect("a day");
            days.push(civil_from_unix_utc(t).day);
        }
        assert_eq!(days, vec![6, 13, 20, 27]);
    }

    #[test]
    fn a_restricted_day_of_month_alone_ignores_the_weekday() {
        let s = cron("0 0 13 * *");
        let t = next_cron_after(&s, utc("2024-09-01T00:00:00Z"), &Utc).expect("the 13th");
        assert_eq!(civil_from_unix_utc(t).day, 13);
        let t2 = next_cron_after(&s, t, &Utc).expect("the next 13th");
        assert_eq!(civil_from_unix_utc(t2).month, 10);
        assert_eq!(civil_from_unix_utc(t2).day, 13);
    }

    #[test]
    fn a_restricted_weekday_alone_ignores_the_day_of_month() {
        let s = cron("0 0 * * 1");
        let mut t = utc("2024-09-01T00:00:00Z");
        for _ in 0..5 {
            t = next_cron_after(&s, t, &Utc).expect("a Monday");
            let c = civil_from_unix_utc(t);
            assert_eq!(weekday(c.year, c.month, c.day), 1, "{c:?}");
        }
    }

    // ------------------------------------------------------------ DST

    #[test]
    fn the_test_zone_transitions_where_the_test_says_it_does() {
        assert_eq!(Europe.offset(SPRING - 1), 3600);
        assert_eq!(Europe.offset(SPRING), 7200);
        assert_eq!(Europe.offset(FALL - 1), 7200);
        assert_eq!(Europe.offset(FALL), 3600);
    }

    #[test]
    fn a_local_time_that_never_happens_fires_when_the_clock_jumps() {
        // 02:30 does not exist on 2024-03-31: the clock goes from 02:00 to
        // 03:00. A daily job must fire once that day, not zero times.
        let s = cron("30 2 * * *");
        let after = utc("2024-03-30T01:30:00Z"); // local 02:30 on the 30th
        let t = next_cron_after(&s, after, &Europe).expect("a fire");
        assert_eq!(t, SPRING, "it fires at the instant the clock jumps");
        assert_eq!(
            civil_at(&Europe, t),
            Civil { year: 2024, month: 3, day: 31, hour: 3, minute: 0, second: 0 },
            "which the wall clock reads as 03:00"
        );
    }

    #[test]
    fn two_jobs_inside_the_same_gap_do_not_fire_twice() {
        // 02:15 and 02:45 both vanish. Collapsing them onto the transition is
        // what keeps "at most one fire per scheduled time" true without a
        // special case: the second candidate is no longer in the future.
        let s = cron("15,45 2 * * *");
        let after = utc("2024-03-30T02:00:00Z");
        let first = next_cron_after(&s, after, &Europe).expect("first");
        assert_eq!(first, SPRING);
        let second = next_cron_after(&s, first, &Europe).expect("second");
        assert_eq!(
            civil_at(&Europe, second).day,
            1,
            "the next one is on 1 April, not a second fire on 31 March"
        );
    }

    #[test]
    fn a_local_time_that_happens_twice_fires_once_on_the_first_of_the_two() {
        // 02:30 happens at 00:30Z (+2) and again at 01:30Z (+1).
        let s = cron("30 2 * * *");
        let after = utc("2024-10-26T02:00:00Z");
        let t = next_cron_after(&s, after, &Europe).expect("a fire");
        assert_eq!(t, utc("2024-10-27T00:30:00Z"), "the first occurrence");
        assert_eq!(civil_at(&Europe, t).hour, 2);
        let next = next_cron_after(&s, t, &Europe).expect("the day after");
        assert_eq!(
            next,
            utc("2024-10-28T01:30:00Z"),
            "the repeat of 02:30 an hour later is NOT a second fire"
        );
    }

    #[test]
    fn an_hourly_job_skips_the_repeated_hour_rather_than_running_it_twice() {
        let s = cron("0 * * * *");
        let mut t = utc("2024-10-26T22:59:00Z"); // local 00:59
        let mut fires = Vec::new();
        for _ in 0..4 {
            t = next_cron_after(&s, t, &Europe).expect("an hour");
            fires.push(t);
        }
        assert_eq!(
            fires,
            vec![
                utc("2024-10-26T23:00:00Z"), // local 01:00 +2
                utc("2024-10-27T00:00:00Z"), // local 02:00 +2, the first one
                utc("2024-10-27T02:00:00Z"), // local 03:00 +1
                utc("2024-10-27T03:00:00Z"), // local 04:00 +1
            ],
            "local 02:00 +1 is the same wall clock reading and is not fired again"
        );
    }

    #[test]
    fn a_job_away_from_the_transition_is_untouched_by_it() {
        let s = cron("0 9 * * *");
        let t = next_cron_after(&s, utc("2024-03-30T12:00:00Z"), &Europe).expect("fire");
        assert_eq!(civil_at(&Europe, t).hour, 9);
        assert_eq!(t, utc("2024-03-31T07:00:00Z"), "09:00 local at +2");
    }

    #[test]
    fn an_interval_is_immune_to_the_wall_clock() {
        // The point of the second form: "every 2h" is two hours, in March too.
        let s = parse_schedule("every 2h").expect("2h");
        let anchor = SPRING - 3600; // one hour before the jump
        let t = next_fire(&s, anchor, anchor, &Europe).expect("fire");
        assert_eq!(t - anchor, 7200);
    }

    #[test]
    fn a_fixed_offset_zone_shifts_every_fire_by_that_offset() {
        let s = cron("0 9 * * *");
        let utc_fire = next_cron_after(&s, utc("2024-05-15T00:00:00Z"), &Utc).expect("utc");
        let plus2 = next_cron_after(&s, utc("2024-05-15T00:00:00Z"), &Fixed(7200)).expect("+2");
        assert_eq!(utc_fire - plus2, 7200);
    }

    #[test]
    fn the_machine_zone_is_wired_to_libc_and_round_trips() {
        // The one thing a fake zone cannot prove: that the FFI declaration
        // above actually reads tm_gmtoff and not whatever happened to be on
        // the stack. A garbage offset fails all three of these.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(1_715_760_000);
        for t in [now, now - 180 * 86_400, now + 180 * 86_400, 0] {
            let offset = Local.offset(t);
            assert!(
                offset.abs() <= 14 * 3600,
                "no zone on earth is {offset} seconds from UTC"
            );
            assert_eq!(offset % 60, 0, "offsets are whole minutes");
            // A whole-minute instant must convert back to itself. Only a gap
            // breaks this, and the three instants above are six months apart,
            // so at most one of them could ever land in one.
            let minute = t - t.rem_euclid(60);
            let back = unix_at(&Local, &civil_at(&Local, minute));
            assert_eq!(back, minute, "round trip at {minute}");
        }
        // And the value itself, against the system's own answer. Without this
        // the round trip above would pass just as happily on an offset that is
        // always zero, which is exactly what a wrong struct layout produces.
        let out = std::process::Command::new("/bin/date")
            .arg("+%z")
            .output()
            .expect("date");
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let sign = if text.starts_with('-') { -1 } else { 1 };
        let hours: i32 = text[1..3].parse().expect("hours");
        let minutes: i32 = text[3..5].parse().expect("minutes");
        assert_eq!(
            Local.offset(now),
            sign * (hours * 3600 + minutes * 60),
            "libc says one thing and `date +%z` says {text}"
        );
    }

    #[test]
    fn a_daily_job_on_the_machine_zone_lands_on_the_hour_it_was_given() {
        let s = cron("30 7 * * *");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(1_715_760_000);
        let t = next_cron_after(&s, now, &Local).expect("a fire");
        let c = civil_at(&Local, t);
        assert!(t > now);
        assert!(t - now <= 86_400 + 3600);
        assert_eq!((c.hour, c.minute), (7, 30), "{c:?}");
    }

    // ------------------------------------------------------------ catch up

    #[test]
    fn missed_fires_are_counted_and_the_last_one_is_exact() {
        let s = parse_schedule("0 * * * *").expect("hourly");
        let anchor = utc("2024-05-15T00:00:00Z");
        let now = utc("2024-05-15T05:30:00Z");
        let m = missed_since(&s, anchor, now, &Utc, 100);
        assert_eq!(m.count, 5, "01:00 through 05:00");
        assert!(!m.saturated);
        assert_eq!(m.last, Some(utc("2024-05-15T05:00:00Z")));
    }

    #[test]
    fn a_night_of_missed_minutes_saturates_the_count_but_not_the_last_fire() {
        // The 400-runs case, stated as arithmetic: a per-minute job and an app
        // closed for seven hours. The count is allowed to be approximate; the
        // instant the catch-up decision reads must not be.
        let s = parse_schedule("* * * * *").expect("per minute");
        let anchor = utc("2024-05-15T00:00:00Z");
        let now = utc("2024-05-15T07:00:00Z");
        let m = missed_since(&s, anchor, now, &Utc, 100);
        assert_eq!(m.count, 100);
        assert!(m.saturated, "420 fires do not fit in a cap of 100");
        assert_eq!(m.last, Some(now));
    }

    #[test]
    fn an_interval_counts_its_misses_without_walking_them() {
        let s = parse_schedule("30m").expect("30m");
        let anchor = utc("2024-05-15T00:00:00Z");
        let now = utc("2024-05-15T10:10:00Z");
        let m = missed_since(&s, anchor, now, &Utc, 100);
        assert_eq!(m.count, 20);
        assert!(!m.saturated, "twenty fires fit in a cap of a hundred");
        assert_eq!(m.last, Some(utc("2024-05-15T10:00:00Z")));

        // The saturating branch of the INTERVAL arm. The cron arm has its own
        // test above; this arm reaches the cap by arithmetic rather than by
        // walking, and nothing asserted its flag, so `saturated = false` was a
        // mutation the whole suite let through.
        let over = missed_since(&s, anchor, now, &Utc, 5);
        assert_eq!(over.count, 5, "the count stops at the cap");
        assert!(over.saturated, "twenty fires do not fit in a cap of five");
        assert_eq!(
            over.last,
            Some(utc("2024-05-15T10:00:00Z")),
            "the instant the catch-up decision reads stays exact past the cap"
        );
    }

    #[test]
    fn nothing_is_missed_when_nothing_was_due() {
        let s = parse_schedule("0 3 * * *").expect("daily");
        let anchor = utc("2024-05-15T04:00:00Z");
        let now = utc("2024-05-15T09:00:00Z");
        let m = missed_since(&s, anchor, now, &Utc, 100);
        assert_eq!(m.count, 0);
        assert_eq!(m.last, None);
    }

    #[test]
    fn an_interval_whose_anchor_is_ancient_still_reports_a_future_fire() {
        let s = parse_schedule("30m").expect("30m");
        let anchor = utc("2020-01-01T00:00:00Z");
        let now = utc("2024-05-15T10:10:00Z");
        let t = next_fire(&s, now, anchor, &Utc).expect("fire");
        assert!(t > now, "a next fire in the past is not a next fire");
        assert!(t - now <= 1800);
    }
}
