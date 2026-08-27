// Le moteur: son etat, son compteur de generation, son demarrage et son arret.
//
// Le dernier groupe sorti de lib.rs, et le seul qui soit vraiment a etat. Les
// cinq autres ont ete decoupes en septembre; celui-ci a attendu parce que
// SERVER, SERVER_GEN et les trois chemins qui les partagent ne se separent pas
// par une banniere.
//
// LA REGLE QUI TIENT TOUT: un demarrage lit sa generation APRES son propre
// arret, jamais avant, sinon il s'annule lui-meme. server_generation_tests, en
// bas de ce fichier, est la pour que personne ne la defasse.
//
// Y vit aussi la lecture du journal du moteur, parce qu'un echec de llama-server
// dit toujours les trois memes mots par l'API et la verite dans son log.

use crate::*;

pub(crate) struct ServerState {
    pub(crate) child: Option<Child>,
    pub(crate) model_id: Option<String>,
    pub(crate) phase: String, // stopped | starting | ready | failed
    pub(crate) generation: u64,
    /// Port actually bound by the running server (0 when stopped).
    pub(crate) port: u16,
    /// Engine regime: resident-bit-exact | streamed-bit-exact | cpu-bit-exact
    /// | stock-llamacpp (a dense model, which streams nothing).
    pub(crate) mode: String,
    /// Decode slots the running server was started with (--parallel).
    pub(crate) slots: u32,
    /// Context window per slot the running server was started with.
    ///
    /// The setting offers 8K to 128K, and ctx_per_slot_for clamps it to what
    /// the model declares (or to a cautious 32K when it declares nothing). The
    /// UI painted the STORED value, so someone who chose 128K saw 128K on a
    /// server running 32K, with nothing saying the request had been reduced.
    pub(crate) ctx_per_slot: u32,
    /// Measured tool-calling verdict for the running model (see ServerStatus).
    pub(crate) tools_ok: Option<bool>,
    /// The footprint mode this server was actually started in, and why. None
    /// while stopped.
    pub(crate) footprint: Option<ModeDecision>,
}

pub(crate) static SERVER: OnceLock<Mutex<ServerState>> = OnceLock::new();

pub(crate) static SERVER_GEN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn server_state() -> &'static Mutex<ServerState> {
    SERVER.get_or_init(|| {
        Mutex::new(ServerState {
            child: None,
            model_id: None,
            phase: "stopped".into(),
            generation: 0,
            port: 0,
            mode: String::new(),
            slots: 1,
            ctx_per_slot: 0,
            tools_ok: None,
            footprint: None,
        })
    })
}

/// How the engine is told to parse a chat turn, in one place.
///
/// `--jinja` has always been here. `--reasoning-format deepseek` is the flag
/// that lets the app show a model thinking, and the three values are NOT
/// interchangeable:
///
///   none             leaves the thoughts unparsed inside `message.content`,
///                    so the answer arrives with raw `<think>` tags in it.
///   deepseek-legacy  extracts them AND re-inlines them into the content while
///                    streaming (server-schema.cpp sets `reasoning_in_content`
///                    for exactly this value), so the tags come back on screen.
///   deepseek         puts them in `message.reasoning_content`, including in
///                    every streaming delta, and leaves `content` holding the
///                    answer alone. The only one of the three that lets the
///                    two be shown differently.
///
/// It is passed EXPLICITLY even though this build already defaults to it
/// (`common_params::reasoning_format` in common/common.h). The flag's own help
/// text in common/arg.cpp announces a different default, "auto", so the
/// default is a thing two parts of llama.cpp disagree about, and a vendored
/// dependency is bumped by whoever is bumping it. Stating the value costs two
/// arguments and removes the app's most visible behaviour from that argument.
pub(crate) fn chat_parsing_args() -> [&'static str; 3] {
    ["--jinja", "--reasoning-format", "deepseek"]
}

/// Does the `numerics` setting ask for the bit-exact expert path?
///
/// THE DEFAULT IS NOW STANDARD, and this reversal was made on measurements
/// rather than a preference. The parity flag as the only difference:
///
///     olmoe-1b-7b, q4_K/q6_K experts, 3061 tokens, ubatch 512
///       bit-exact      147 tok/s prefill      74-108 tok/s decode
///       standard      5567-8584 tok/s        187-225 tok/s decode
///
///     gpt-oss-120b, mxfp4 experts, 3521 tokens, ubatch 512
///       bit-exact       61-68 tok/s prefill        29 tok/s decode
///       standard         2286 tok/s              53.6 tok/s decode
///
/// Prefill is 35 to 58 times slower on the parity path, and generation about
/// twice. On the 120B that is the difference between reading a 7256-token
/// thread in 3.2 seconds and in 118, which is what the app felt like: two
/// minutes of nothing before the first word. The answers are as good either
/// way; what the parity path buys is that they are reproducible bit for bit,
/// which matters when certifying kernels and not when answering a question.
///
/// So it becomes what it always was: a verification mode, chosen deliberately.
/// The badge names the running regime either way, so nobody is told they have
/// certified numerics when they do not.
///
/// Opt-in is read generously (a hyphen or a shorter word still means yes)
/// because asking for it costs only speed, while failing to grant it would
/// quietly deny a request somebody made on purpose.
pub(crate) fn bit_exact_numerics(setting: Option<&str>) -> bool {
    matches!(
        setting.map(|v| v.trim()),
        Some("bitexact") | Some("bit-exact") | Some("exact") | Some("certified")
    )
}

#[derive(Serialize, Clone)]
pub(crate) struct ServerStatus {
    pub(crate) running: bool,
    pub(crate) model_id: Option<String>,
    pub(crate) port: u16,
    pub(crate) phase: String,
    pub(crate) mode: String,
    /// Concurrent decode streams the running engine can serve.
    pub(crate) slots: u32,
    /// Whether this model actually emits tool calls, MEASURED at warmup.
    ///
    /// None while unknown (server starting, or the probe has not answered).
    /// A model that cannot call tools cannot drive the agent loop at all: it
    /// reads no file and runs no command, and every agent surface silently
    /// does nothing. The app disables those surfaces instead, which is only
    /// possible if it knows. Declaring the capability in the registry would
    /// have been cheaper and would have been wrong: it depends on the build,
    /// the chat template and the quantization, not on the model name.
    pub(crate) tools_ok: Option<bool>,
    /// The context window per slot the engine is actually serving, which is
    /// not always the one that was asked for.
    pub(crate) ctx_per_slot: u32,
    /// The memory-footprint decision this engine was started with: the mode
    /// asked for, the mode actually used, and the two numbers that separate
    /// them. The UI says so out loud when they differ, because a user who
    /// picked Performance and silently got Eco would rightly call that a bug.
    pub(crate) footprint: Option<ModeDecision>,
}

#[tauri::command(async)]
pub fn server_status() -> ServerStatus {
    let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
    ServerStatus {
        running: s.child.is_some(),
        model_id: s.model_id.clone(),
        port: if s.port == 0 { SERVER_PORT_BASE } else { s.port },
        phase: s.phase.clone(),
        mode: s.mode.clone(),
        // Stopped: report what the NEXT start would give, so the UI never
        // promises a concurrency the engine will not have.
        slots: if s.child.is_some() { s.slots } else { crate::planner::engine_slots() },
        ctx_per_slot: s.ctx_per_slot,
        tools_ok: s.tools_ok,
        footprint: s.footprint.clone(),
    }
}

/// Ask the running model to call a trivial tool, and report whether it did.
///
/// This measures the one thing the agent loop cannot work without. It is a
/// capability of the running combination, not of the model name: the same
/// weights answer differently depending on the chat template baked into the
/// GGUF, on whether the server was started with --jinja, and on the
/// quantization. Declaring it in the registry would therefore have been a
/// guess dressed up as a fact.
///
/// `tool_choice` is left on auto ON PURPOSE. Forcing it would measure whether
/// the engine can constrain the grammar, which it always can; what the agent
/// loop needs is whether the model reaches for a tool on its own when the
/// question plainly calls for one. A model that answers in prose here will
/// answer in prose when asked to read a file.
pub(crate) fn probe_tool_calling(port: u16) -> Option<bool> {
    // Two budgets. The first is what an ordinary model needs; the second is for
    // one that thinks at length before it acts, and is only ever paid when the
    // first answer was cut off mid-sentence.
    for cap in PROBE_TOKEN_BUDGETS {
        let body = probe_body(cap);
        let out = Command::new("curl")
            .args(["-s", "--max-time", "180", "-H", "Content-Type: application/json", "-d", &body])
            .arg(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .output()
            .ok()?;
        match read_tool_verdict(&String::from_utf8_lossy(&out.stdout)) {
            Some(v) => return Some(v),
            // None means the answer was truncated, so it says nothing about the
            // model. Buy more room and ask again.
            None => continue,
        }
    }
    None
}

/// Token budgets for the capability probe, tried in order.
///
/// It was ONE budget of 64, and that number is where this bug lived. A reasoning
/// model spends its opening tokens thinking, so it was cut off long before it
/// reached the tool call, answered with no `tool_calls`, and was recorded as
/// incapable. Qwen3.6 and Mellum2 are both thinking models, and both had the
/// Code and Runs tabs locked against them by a measurement of nothing but the
/// budget. 64 tokens does not measure whether a model can call a tool; it
/// measures whether it can do so while barely being allowed to speak.
pub(crate) const PROBE_TOKEN_BUDGETS: [u32; 2] = [512, 4096];

/// The probe request, at a given token budget.
///
/// `enable_thinking:false` is passed through `chat_template_kwargs`, which the
/// Qwen family honours and every other template ignores: a model that can be
/// asked to skip its reasoning for one question answers this one in a few
/// tokens. It is a shortcut, not the fix, which is why the budgets above are
/// sized to work even when it is ignored.
pub(crate) fn probe_body(max_tokens: u32) -> String {
    format!(
        r#"{{
      "model":"galactus-local",
      "messages":[{{"role":"user","content":"What time is it right now? Use the tool."}}],
      "tools":[{{"type":"function","function":{{
        "name":"get_current_time",
        "description":"Return the current time. Call this whenever the user asks what time it is.",
        "parameters":{{"type":"object","properties":{{}},"required":[]}}}}}}],
      "tool_choice":"auto","max_tokens":{max_tokens},"stream":false,"temperature":0,
      "chat_template_kwargs":{{"enable_thinking":false}}
    }}"#
    )
}

/// Read the verdict out of one chat-completions answer.
///
/// Split out of the probe so the part that can actually be wrong is testable
/// without a 32 GB model: the transport is curl, which either answers or does
/// not, while THIS is where a build that emits an empty `tool_calls` array
/// beside a prose reply would be misread as capable.
///
/// Returns None only when the body is not JSON at all, which means the probe
/// itself failed and the question stays open. Every parseable answer yields a
/// definite yes or no.
pub(crate) fn read_tool_verdict(body: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // A server whose chat template carries no tool support answers with an
    // error rather than a choice. That is a definite no, not an unknown.
    if v.get("error").is_some() {
        return Some(false);
    }
    let calls = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("tool_calls"))
        .and_then(|t| t.as_array());
    let named = |a: &Vec<serde_json::Value>| {
        a.iter().any(|c| {
            c.pointer("/function/name").and_then(|n| n.as_str()).is_some_and(|n| !n.is_empty())
        })
    };
    if let Some(a) = calls {
        if named(a) {
            return Some(true);
        }
    }
    // No call. Before calling that a no, ask whether the model was allowed to
    // finish. finish_reason "length" means the budget ran out mid-answer, and an
    // answer that was cut off is evidence about the budget, not about the model:
    // a reasoning model reaches its tool call after its thinking, so a short
    // budget produced a confident, permanent, wrong "cannot call tools" that
    // locked the Code and Runs tabs. Unknown, so the caller can buy more room.
    let truncated = v
        .pointer("/choices/0/finish_reason")
        .and_then(|f| f.as_str())
        .is_some_and(|f| f == "length");
    if truncated {
        return None;
    }
    Some(false)
}

#[cfg(test)]
mod tool_probe_tests {
    use super::{probe_body, read_tool_verdict, PROBE_TOKEN_BUDGETS};

    #[test]
    fn a_truncated_answer_is_not_a_verdict() {
        // What a thinking model returns when the budget ends inside its
        // reasoning: no call, and finish_reason saying why. Reading this as
        // "cannot call tools" is what locked the Code tab on Qwen3.6.
        let body = r#"{"choices":[{"finish_reason":"length","message":{
            "role":"assistant","content":"","reasoning_content":"The user wants the time, so I should"}}]}"#;
        assert_eq!(read_tool_verdict(body), None, "truncation says nothing about the model");
    }

    #[test]
    fn a_complete_answer_with_no_call_is_a_definite_no() {
        // The distinction the test above depends on: a model that finished its
        // sentence and still did not reach for the tool really cannot be driven.
        let body = r#"{"choices":[{"finish_reason":"stop","message":{
            "role":"assistant","content":"I do not have access to the current time."}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn the_probe_gives_a_reasoning_model_room_to_reach_its_tool_call() {
        // 64 was the shipped value and it measured the budget, not the model.
        assert!(
            PROBE_TOKEN_BUDGETS[0] >= 256,
            "a thinking model spends its opening tokens thinking",
        );
        assert!(
            PROBE_TOKEN_BUDGETS[1] > PROBE_TOKEN_BUDGETS[0],
            "the retry must buy more room than the first attempt",
        );
        for cap in PROBE_TOKEN_BUDGETS {
            let body = probe_body(cap);
            assert!(body.contains(&format!("\"max_tokens\":{cap}")));
            // Auto on purpose: forcing the call would measure the grammar
            // engine, not whether the model reaches for a tool by itself.
            assert!(body.contains("\"tool_choice\":\"auto\""));
            assert!(body.contains("\"enable_thinking\":false"));
            assert!(serde_json::from_str::<serde_json::Value>(&body).is_ok(), "probe body is JSON");
        }
    }

    #[test]
    fn a_real_tool_call_reads_as_capable() {
        // Shape captured from the running engine on Qwen3-30B-A3B.
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[
            {"type":"function","function":{"name":"get_current_time","arguments":"{}"},"id":"ai28"}]}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(true));
    }

    #[test]
    fn a_prose_answer_reads_as_incapable() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"It is about noon."}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn an_empty_array_is_not_a_tool_call() {
        // The trap: a build that always emits the key, empty, beside prose.
        // Testing for the key's presence would have called this one capable.
        let body = r#"{"choices":[{"message":{"content":"Noon.","tool_calls":[]}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn a_nameless_call_is_not_a_tool_call() {
        let body = r#"{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"arguments":"{}"}}]}}]}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
        let empty = r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":""}}]}}]}"#;
        assert_eq!(read_tool_verdict(empty), Some(false));
    }

    #[test]
    fn a_template_without_tool_support_is_a_definite_no() {
        let body = r#"{"error":{"code":500,"message":"this chat template does not support tools"}}"#;
        assert_eq!(read_tool_verdict(body), Some(false));
    }

    #[test]
    fn a_non_json_answer_leaves_the_question_open() {
        // curl timed out, or the server died mid-probe. Reporting "incapable"
        // here would disable the Code view over a transport failure.
        assert_eq!(read_tool_verdict(""), None);
        assert_eq!(read_tool_verdict("<html>502</html>"), None);
    }
}

/// Pick a port we can actually bind. A crashed run can leave an orphan holding
/// the previous one, and other software may squat it too, so instead of
/// fighting for a fixed port we scan a small range and take the first free
/// slot. Orphaned llama-servers of ours are reaped along the way.
/// Reap only servers WE left behind: a llama-server whose command line points
/// at the configured Galactus folder. A llama-server the user started by hand
/// elsewhere is never touched. Purely a memory courtesy, the dynamic port
/// already removes any bind conflict.
pub(crate) fn reap_orphan_servers(root: &Path) {
    let root_str = root.to_string_lossy().into_owned();
    let out = Command::new("pgrep").args(["-f", "llama-server"]).output();
    let pids: Vec<i32> = out
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect()
        })
        .unwrap_or_default();
    let me = std::process::id() as i32;
    for pid in pids {
        if pid == me {
            continue;
        }
        let args = run_capture("ps", &["-p", &pid.to_string(), "-o", "command="]);
        if args.contains("llama-server") && args.contains(&root_str) {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
        }
    }
}

pub(crate) fn pick_free_port() -> Result<u16, String> {
    use std::net::TcpListener;
    for offset in 0..SERVER_PORT_SPAN {
        let port = SERVER_PORT_BASE + offset;
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => {
                drop(l); // released immediately; llama-server takes it next
                return Ok(port);
            }
            Err(_) => continue,
        }
    }
    Err(format!(
        "no free port in {}..{}",
        SERVER_PORT_BASE,
        SERVER_PORT_BASE + SERVER_PORT_SPAN
    ))
}

/// Last lines of llama-server.log, attached to failure events so the UI can
/// show why the engine died.
pub(crate) fn server_log_tail(lines: usize) -> String {
    std::fs::read_to_string(app_support().join("llama-server.log"))
        .map(|t| {
            t.lines()
                .rev()
                .take(lines)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Substrings that mean an allocator refused. Matched lowercase, against the
/// log, never against the API message.
///
/// Where each one comes from, so a llama.cpp bump can be checked against this
/// list rather than trusted:
///   ggml-alloc.c        "not enough space in the buffer to allocate ..."
///   ggml-backend.cpp    "failed to allocate buffer, size = ..."
///   ggml-metal-device.m "failed to allocate context", "greater than the
///                        recommended max working set size"
///   Metal itself        the command buffer's localizedDescription, which for
///                        a GPU allocation failure reads "Insufficient Memory
///                        (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)"
///   libc                strerror(ENOMEM), "Cannot allocate memory"
pub(crate) const OOM_MARKERS: [&str; 8] = [
    "failed to allocate",
    "unable to allocate",
    "cannot allocate memory",
    "not enough space in the buffer",
    "out of memory",
    "outofmemory",
    "insufficient memory",
    "greater than the recommended max working set size",
];

/// Substrings that prove the log line came from a decode that gave up, so the
/// current log can be told apart from one that simply has nothing to say.
pub(crate) const DECODE_FAILURE_MARKERS: [&str; 4] = [
    "compute error",
    "invalid input batch",
    "command buffer",
    "context size has been exceeded",
];

/// What the engine's words say about a failure the user just met.
///
/// `memory`  the allocator refused, and the one action that works is to give
///           the engine less to hold.
/// `context` the conversation outgrew the window. Not a memory problem, and
///           telling the user to switch to Eco would send them the wrong way.
/// `unknown` the log names neither. Say so rather than invent a cause.
pub(crate) fn classify_engine_failure(api_message: &str, log: &str) -> &'static str {
    let msg = api_message.to_lowercase();
    // Checked FIRST: an exceeded context can happen on a machine with memory
    // to spare, and the two remedies point in opposite directions.
    if msg.contains("context size has been exceeded")
        || msg.contains("exceed the available context")
        || msg.contains("context shift")
    {
        return "context";
    }
    let low = log.to_lowercase();
    if OOM_MARKERS.iter().any(|m| low.contains(m)) {
        return "memory";
    }
    "unknown"
}

/// The engine log worth classifying.
///
/// llama-server.log is the running engine; the `.1` beside it is the previous
/// run, kept because a failed start is usually reported after the user has
/// already retried. When the current log holds no trace of a decode giving up,
/// the evidence is in the older one, and reading only the current file would
/// report "unknown" on the exact case this exists for.
pub(crate) fn engine_log_evidence() -> String {
    let current = read_log_tail("llama-server.log");
    let low = current.to_lowercase();
    let speaks = DECODE_FAILURE_MARKERS.iter().any(|m| low.contains(m))
        || OOM_MARKERS.iter().any(|m| low.contains(m));
    if speaks {
        return current;
    }
    let previous = read_log_tail("llama-server.log.1");
    if previous.is_empty() { current } else { previous }
}

/// Last quarter of a megabyte of an engine log.
///
/// A long session writes a log measured in tens of megabytes, and the verdict
/// is always in its last handful of lines. Reading the whole file to look at
/// its tail would make diagnosing a failure cost more than the failure.
pub(crate) fn read_log_tail(name: &str) -> String {
    use std::io::{Read, Seek, SeekFrom};
    const WINDOW: u64 = 256 * 1024;
    let Ok(mut f) = std::fs::File::open(app_support().join(name)) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > WINDOW && f.seek(SeekFrom::Start(len - WINDOW)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// The engine's own line that carries the verdict, so what the UI shows is
/// evidence rather than a claim. Empty when the log names nothing.
pub(crate) fn engine_failure_evidence(log: &str) -> String {
    log.lines()
        .rev()
        .find(|l| {
            let low = l.to_lowercase();
            OOM_MARKERS.iter().any(|m| low.contains(m))
        })
        .map(|l| l.trim().chars().take(240).collect())
        .unwrap_or_default()
}

/// What the UI needs to replace "Compute error." with a sentence.
#[derive(Serialize, Clone, Debug)]
pub(crate) struct EngineDiagnosis {
    /// memory | context | unknown
    pub(crate) kind: String,
    /// The footprint mode the running engine was started in ("" when stopped).
    pub(crate) mode: String,
    /// Whether there is a leaner mode left to fall back to. False in eco,
    /// where the honest advice is to free memory instead.
    pub(crate) can_step_down: bool,
    /// The engine's own line, shown so the diagnosis can be checked.
    pub(crate) evidence: String,
    /// The raw engine message, passed through for the unknown case.
    pub(crate) message: String,
}

/// Diagnose a failure the user just met in a conversation.
///
/// Called from the chat error path with the message llama-server sent. The
/// classification reads the engine log rather than pattern-matching the
/// message, because the message is the same three words whatever happened.
///
/// Async so the log read never runs on the main thread: this is called at the
/// exact moment the machine is short of memory and the UI must stay alive.
#[tauri::command]
pub async fn engine_diagnose(message: String) -> EngineDiagnosis {
    let log = engine_log_evidence();
    let kind = classify_engine_failure(&message, &log);
    let mode = {
        let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        s.footprint.as_ref().map(|f| f.mode.clone()).unwrap_or_default()
    };
    EngineDiagnosis {
        can_step_down: !mode.is_empty() && mode != "eco",
        kind: kind.to_string(),
        mode,
        evidence: if kind == "memory" { engine_failure_evidence(&log) } else { String::new() },
        message,
    }
}

#[cfg(test)]
mod chat_parsing_tests {
    use super::{bit_exact_numerics, chat_parsing_args};

    #[test]
    fn the_engine_is_told_to_separate_thinking_from_the_answer() {
        // Without this pair the thoughts either never leave `content` or are
        // re-inlined into it, and the app is back to showing nothing while a
        // model reasons for half a minute.
        let args = chat_parsing_args();
        let at = args
            .iter()
            .position(|a| *a == "--reasoning-format")
            .expect("the engine must be told which reasoning format to use");
        assert_eq!(
            args.get(at + 1),
            Some(&"deepseek"),
            "the value has to follow the flag, or llama-server reads the next flag as it"
        );
    }

    #[test]
    fn the_legacy_format_is_never_the_one_asked_for() {
        // deepseek-legacy extracts the thoughts AND re-inlines them into the
        // content while streaming, which puts raw <think> tags back on screen.
        // It reads like a harmless synonym and is the one wrong answer here.
        assert!(
            !chat_parsing_args().contains(&"deepseek-legacy"),
            "deepseek-legacy re-inlines thinking into the streamed content"
        );
    }

    #[test]
    fn the_template_engine_stays_on() {
        // The reasoning format is only consulted on the jinja path: without
        // --jinja the server never runs the parser that fills reasoning_content.
        assert!(chat_parsing_args().contains(&"--jinja"));
    }

    #[test]
    fn the_parity_path_is_entered_only_on_purpose() {
        // The default, and every way of not having chosen: standard kernels.
        // This is the reversal, and the reason is at the function.
        assert!(!bit_exact_numerics(None));
        assert!(!bit_exact_numerics(Some("")));
        assert!(!bit_exact_numerics(Some("   ")));
        assert!(!bit_exact_numerics(Some("standard")));
        // Asking for it is read generously: it costs only speed, so a hyphen
        // or a shorter word must not silently deny a deliberate request.
        assert!(bit_exact_numerics(Some("bitexact")));
        assert!(bit_exact_numerics(Some(" bit-exact ")));
        assert!(bit_exact_numerics(Some("exact")));
        assert!(bit_exact_numerics(Some("certified")));
        // Anything nobody meant is the default, not a slow surprise.
        assert!(!bit_exact_numerics(Some("bitexcat")));
        assert!(!bit_exact_numerics(Some("fast")));
    }

    #[test]
    fn the_cli_server_is_started_with_the_same_parsing_flags_as_the_app() {
        // `galactus serve` passed --jinja alone. Without --reasoning-format
        // deepseek the engine leaves the thinking inside message.content, so a
        // client pointed at the CLI's server got <think> tags mixed into the
        // answer while the app, on the same model, separated them.
        //
        // Read from the source rather than asserted about a string, because
        // what went wrong was a second copy of the list drifting from the
        // first, and a test with its own third copy would not have caught it.
        let cli = include_str!("cli.rs");
        assert!(
            cli.contains("crate::chat_parsing_args()"),
            "serve must take its parsing flags from the one function that defines them"
        );
        assert!(
            !cli.contains(".arg(\"--jinja\")"),
            "and must not carry its own copy of any of them"
        );
    }
}

#[cfg(test)]
mod engine_failure_tests {
    use super::classify_engine_failure;

    /// What a real Metal allocation failure leaves behind, trimmed.
    const METAL_OOM: &str = "\
ggml_metal_synchronize: error: command buffer 0 failed with status 5
error: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)
srv  update_slots: Compute error. off = 0, n_batch = 512, ret = -3";

    #[test]
    fn the_allocator_refusing_is_named_memory() {
        assert_eq!(classify_engine_failure("Compute error.", METAL_OOM), "memory");
    }

    #[test]
    fn the_ggml_allocator_message_counts_too() {
        let log = "ggml_gallocr_reserve_n: not enough space in the buffer to allocate 1073741824 bytes";
        assert_eq!(classify_engine_failure("Compute error.", log), "memory");
    }

    #[test]
    fn an_exceeded_context_is_never_reported_as_memory() {
        // The remedies point opposite ways: this one is answered by a shorter
        // conversation, not by a smaller footprint. Even with an old memory
        // line still sitting in the log, the message decides.
        assert_eq!(
            classify_engine_failure("Context size has been exceeded.", METAL_OOM),
            "context"
        );
    }

    #[test]
    fn a_failure_the_log_does_not_explain_stays_unknown() {
        // Inventing a memory story here would send the user to Settings for
        // nothing, and would hide the real fault.
        let log = "srv  update_slots: Compute error. off = 0, n_batch = 512, ret = -3";
        assert_eq!(classify_engine_failure("Compute error.", log), "unknown");
        assert_eq!(classify_engine_failure("Compute error.", ""), "unknown");
    }
}

// Async: pack resolution and the port scan touch disks and sockets, which
/// Proof that a llama-server carries the Galactus engine, not just its flags.
///
/// The engine code is linked into the llama library, so the marker is looked up
/// in the binary AND in the llama/ggml dylibs beside it. A stock upstream build
/// silently ignores every GALACTUS_H4_* variable and would serve the model
/// natively, which is exactly what the product forbids: fail closed instead.
pub(crate) fn engine_is_wired(bin: &Path) -> Result<(), String> {
    const MARKER: &[u8] = b"galactus_h4:";
    let mut candidates: Vec<PathBuf> = vec![bin.to_path_buf()];
    if let Some(dir) = bin.parent() {
        for probe in [dir.to_path_buf(), dir.join("../lib")] {
            if let Ok(entries) = std::fs::read_dir(&probe) {
                for e in entries.flatten() {
                    let p = e.path();
                    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    if name.ends_with(".dylib") && (name.contains("llama") || name.contains("ggml")) {
                        candidates.push(p);
                    }
                }
            }
        }
    }
    for path in candidates {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.windows(MARKER.len()).any(|w| w == MARKER) {
            return Ok(());
        }
    }
    Err(format!(
        "this llama-server has no Galactus engine ({}): it would run the model natively, \
         without the expert cache and without the certified numerics. Rebuild it with the patch:\n  \
         patches/appliquer.sh third_party/llama.cpp && cmake --build third_party/llama.cpp/build --target llama-server -j",
        bin.display()
    ))
}

// must not run on the main thread.
#[tauri::command]
pub async fn server_start(app: AppHandle, model_id: String, cache_gb: Option<u64>) -> Result<(), String> {
    // One start at a time, and the second caller is TOLD rather than queued.
    //
    // Two clicks on two cards ran two of these concurrently, and the window
    // between spawning the engine and taking the state lock includes launching
    // a watchdog shell: the second start's stop could land inside it, leaving
    // the first process alive with the whole model resident and nothing
    // pointing at it.
    //
    // A blocking mutex would be wrong here: this function awaits, and holding a
    // std lock across an await parks a runtime worker and invites a deadlock.
    // An atomic that refuses is also the better behaviour, since loading a
    // model takes minutes and a silently queued second start is a surprise.
    static STARTING: AtomicBool = AtomicBool::new(false);
    if STARTING.swap(true, Ordering::SeqCst) {
        return Err("a model is already starting: wait for it, or stop it first".into());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            STARTING.store(false, Ordering::SeqCst);
        }
    }
    // Released on every path out, including the early returns and a panic.
    let _done = Done;
    let root = galactus_root()?;
    let entry = registry_entry(&root, &model_id)?;
    require_certified_model(&entry)?;
    require_compatible_hardware(&entry, hw_info_impl().ram_gb)?;
    let (model_dir, _pack, profile) = model_paths(&root, &model_id);
    let gguf = find_gguf(&model_dir).ok_or("model GGUF not found")?;
    // Dual-pack resolution: two distinct paths make the engine split every
    // record across both SSDs and read them in parallel (P0v2); identical
    // paths are the classic mono pack.
    let dense = is_dense(&entry);
    let (pack_internal, pack_external) = resolve_packs(&root, &model_id, &entry)?;
    // A dense model has no pack and never will: demanding one here would refuse
    // to start a model whose weights are sitting on disk, complete.
    if !dense && (!pack_internal.is_file() || !pack_external.is_file()) {
        return Err("pack not found, install the model first".into());
    }

    let settings = settings_load();
    let override_gb = cache_gb.or_else(|| {
        settings
            .get("cache_gb")
            .and_then(|s| s.trim().parse::<u64>().ok())
    });
    let ram_gb = hw_info_impl().ram_gb.max(8);
    let ram_mode = settings
        .get("ram_mode")
        .map(|s| s.as_str())
        .filter(|s| matches!(*s, "eco" | "balanced" | "perf"))
        .unwrap_or("balanced")
        .to_string();
    // Needed before planning: the cross-check regime keeps a small micro-batch.
    let cpu_moe = entry["cpu_moe"].as_bool().unwrap_or(false)
        || settings.get("cpu_moe").map(|v| v == "1").unwrap_or(false);
    // What the Mac can hand over RIGHT NOW, measured a moment before the
    // engine starts allocating, and what Metal will let it hold resident. The
    // first is the whole reason the planner can step down; the second is the
    // bound the allocator answers to.
    let machine = MachineLimits::probe(ram_gb);
    // Resolved BEFORE planning: every slot past the first is a whole extra KV
    // cache, and the plan has to pay for the slots this start will really ask
    // llama-server for. Per model and per machine, not a flat two.
    let slots = crate::planner::resolved_slots(&entry, machine, &ram_mode, cpu_moe);
    // The window the engine will really be started with, resolved once and used
    // both to price the plan and to build --ctx-size. They were two separate
    // reads for one release, and the plan priced a window the engine did not get.
    let ctx_per_slot = crate::planner::ctx_per_slot_for(&entry);
    let plan = crate::planner::plan_cache(&entry, machine, override_gb, &ram_mode, cpu_moe, slots, ctx_per_slot)?;
    let (cache_bytes, fraction, ubatch) = (plan.cache_bytes, plan.protected, plan.ubatch);

    // Engine resolution: a developer checkout build wins (always freshest);
    // otherwise the fully relocated llama-server shipped INSIDE the app
    // bundle is used, no Homebrew, no checkout, plug and play.
    let checkout_bin = root.join("third_party/llama.cpp/build/bin/llama-server");
    let server_bin = if checkout_bin.exists() {
        checkout_bin
    } else if let Some(bundled) = bundled_engine() {
        bundled
    } else {
        return Err("llama-server binary not found, build it: cmake --build third_party/llama.cpp/build --target llama-server -j".into());
    };
    // Product law: a certified model NEVER runs as a plain native llama.cpp.
    // A stock build accepts every flag and ignores every GALACTUS_H4_* var, so
    // it would serve the model natively while the app reported the engine
    // regime. Prove the wiring is linked in before spawning anything.
    //
    // A dense model is exempt because it makes no such claim: it has no pack, no
    // expert records, and its registry status says stock_unmodified. Demanding
    // the marker there refuses to serve a model that a stock binary serves
    // correctly, which is a refusal with nothing behind it.
    if !dense {
        engine_is_wired(&server_bin)?;
    }

    // A sidecar generated by the installer is mandatory whenever profile.json
    // exists. Check it before replacing a healthy server.
    let has_engine_profile = profile.is_file();
    if !has_engine_profile && model_dir.join("profile.json").is_file() {
        return Err(format!(
            "engine profile missing: {} (regenerate it with scripts/moe-profile.py, \
             or reinstall the model)",
            profile.display()
        ));
    }

    // Every deterministic preflight has succeeded. Only now may this request
    // replace the active server.
    server_stop_impl()?;
    // The generation to beat, read AFTER that stop and not before it.
    //
    // WHY THE ORDER IS THE WHOLE FIX. `server_stop_impl` bumps this counter,
    // which is what lets a Stop reach a start that has not spawned anything
    // yet. Reading the counter at the top of this function therefore compared
    // against a value that this function's OWN internal stop had already
    // invalidated, so the check below fired on every start and every model
    // refused to load with "cancelled". Read here, the only thing that can
    // move it is a Stop the user pressed during the slow part that follows:
    // the engine binary and every dylib read to verify the patches, the
    // machine probe, the cache plan, which together are the seconds where
    // Stop used to do nothing at all.
    let entry_gen = SERVER_GEN.load(Ordering::SeqCst);
    reap_orphan_servers(&root);
    let port = pick_free_port()?;

    // Keep the server's output so failures are visible instead of hanging.
    // The PREVIOUS run is kept alongside: a failed start is usually reported
    // after the user has already retried, and truncating on every start
    // destroyed the only evidence of what actually failed.
    let log_path = app_support().join("llama-server.log");
    let _ = std::fs::create_dir_all(app_support());
    let _ = std::fs::rename(&log_path, app_support().join("llama-server.log.1"));
    let log_out = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

    // Engine regime, ALWAYS the H4 wiring, ALWAYS the certified numerics.
    //
    // Certification rule (product law): a certified model runs BIT-EXACT.
    // That is the CPU-experts regime the certification benches validated:
    // the upstream Metal mv_id kernels diverge from CPU truth on iq quants
    // (patch comment, probe v4: 1-2% relative per layer; ppl 8.89 vs 2.67 on
    // GLM at 1.58 bpw), so Metal experts are OPT-IN and explicitly outside
    // the certification envelope ("metal_experts": true in the registry
    // entry, or setting metal_experts=1).
    //
    // The physical micro-batch stays at the planner's guarded value: the
    // certified curves were measured in this envelope, and a different batch
    // shape changes kernel paths and accumulation order, do not trade
    // bit-exactness for prompt speed silently.
    // Residency is judged on the SAME geometry the planner used (the profile
    // measured at install when there is one), not on the registry estimate:
    // the two can drift and the badge would then contradict the plan.
    let expert_total = crate::planner::measured_geometry(&entry)
        .map(|g| g.1)
        .unwrap_or_else(|| entry["expert_bytes_total"].as_u64().unwrap_or(u64::MAX));
    let full_residency = cache_bytes >= expert_total;
    // The Metal parity path (patches 0002-0004) now covers EVERY expert quant
    // type of the certified registry (iq1_s..q3_K, q8_0, q5_0, q4_K, q6_K,
    // mxfp4), verified 32768/32768 identical bits by the parity probe: Metal
    // experts ARE the certified numerics, and the default everywhere. CPU
    // experts stay as an explicit cross-check regime ("cpu_moe": true per
    // model, or setting cpu_moe=1). Resolved before planning, above.
    let metal_experts = !cpu_moe;
    // Whether the Metal expert kernels replay the CPU algorithm bit for bit, or
    // run llama.cpp's own mul_mat_id.
    //
    // WHY THIS IS A CHOICE AND NOT A CONSTANT. The parity path is correct and
    // it is verified, but replaying a CPU algorithm on a GPU cannot reach the
    // throughput of a kernel written for the GPU, and the cost is enormous. It
    // falls almost entirely on prompt ingestion, which is why generation
    // benchmarks never showed it.
    //
    // MEASURED, same model, same prompt, same micro-batch of 512, olmoe-1b-7b
    // (q4_K / q6_K experts), 3061 tokens, the flag as the only difference:
    //
    //     bit-exact      147 tok/s prefill      74-108 tok/s decode
    //     standard      5567-8584 tok/s        187-225 tok/s decode
    //
    // Prefill is 38 to 58 times slower on the parity path; the same 3061 tokens
    // take 20.6 seconds instead of 0.36. On a working session with
    // gpt-oss-120b (mxfp4) the symptom is the same shape: 171 tok/s of prefill
    // against 40 of decode, a ratio of 4.3 where a Metal MoE should be ten to
    // thirty. The magnitude on mxfp4 is not measured here and may differ.
    //
    // The default stays bit-exact, because that is the promise the rest of this
    // file is built on and nobody should lose it by upgrading. `numerics =
    // standard` is the user saying, explicitly, that they would rather have the
    // speed. It is per-machine, it survives a restart, and the badge says which
    // regime is running so the choice is never invisible.
    let bit_exact = bit_exact_numerics(settings.get("numerics").map(|v| v.as_str()));
    let eff_ubatch: u32 = ubatch;

    let mut cmd = Command::new(&server_bin);
    cmd.env("LC_ALL", "C");
    // The streaming layer is what makes a model larger than memory possible, and
    // it substitutes expert tensors to do it. A dense model has none, so setting
    // these would point the engine at a pack that does not exist. It runs as
    // plain llama.cpp here, which is the whole reason its card says so.
    if !dense {
        cmd.env("GALACTUS_H4", "1")
            .env("GALACTUS_H4_INTERNAL", &pack_internal)
            .env("GALACTUS_H4_EXTERNAL", &pack_external)
            .env("GALACTUS_H4_CACHE_BYTES", cache_bytes.to_string())
            .env("GALACTUS_H4_PROTECTED", format!("{fraction:.2}"))
            .env("GALACTUS_H4_QD", "32");
    }
    // Without GALACTUS_PROFILE the engine adopts its builtin GLM-5.2 geometry.
    // That is right for GLM-5.2 itself and wrong for every other model, so the
    // sidecar is mandatory as soon as the install produced a profile: a
    // renamed or deleted profile.engine.txt would otherwise read experts at
    // the wrong offsets instead of failing.
    if has_engine_profile {
        cmd.env("GALACTUS_PROFILE", &profile);
    }
    // The split ratio the install recorded for this model, handed to the
    // engine as a CROSS-CHECK. The engine cuts by the .split record the pack
    // writer left beside the pack; this is the app's independent copy of the
    // same number, and the engine refuses to start when the two disagree
    // rather than reading one of the two volumes at the wrong offset. Only
    // dual installs have it: a mono pack has nothing to split.
    if pack_internal != pack_external {
        if let Some(r) = settings
            .get(&format!("pack_ratio_{model_id}"))
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            cmd.env("GALACTUS_H4_RATIO", r);
        }
    }
    if cpu_moe {
        cmd.env("GALACTUS_H4_CPU_MOE", "1");
    } else if bit_exact {
        // Metal experts run through the bit-exact parity path (patches 0002 +
        // 0003): the Metal mul_mat_id replays the CPU algorithm bit for bit
        // for every expert quant type of the flagged models. Certified
        // numerics on the GPU.
        cmd.env("GALACTUS_METAL_BITEXACT", "1");
    }
    // Slots and window: --ctx-size is the TOTAL KV budget and llama-server
    // divides it by --parallel, so it is scaled with the slot count. Splitting
    // a fixed 8192 instead would silently give a two-conversation user a
    // 4096-token window per thread.
    //
    // `slots` was resolved before planning, and must stay the same number: the
    // engine has to be started with exactly the slot count the ceiling paid for.
    // The window the planner sized the memory for, not the constant: the two
    // must be the same number or the engine is started with a cache the ceiling
    // never accounted for.
    let ctx_total = ctx_per_slot * slots;
    cmd.arg("--model")
        .arg(&gguf)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--ctx-size")
        .arg(ctx_total.to_string())
        .arg("--n-gpu-layers")
        .arg("99")
        .arg("--no-repack")
        .arg("--fit")
        .arg("off")
        .arg("--no-mmap");
    if cpu_moe {
        cmd.arg("--n-cpu-moe").arg("99");
    }
    // Logical batch stays normal (the server sizes its output buffers from
    // it, a tiny value asserts in output_reserve). Only the PHYSICAL
    // micro-batch is constrained by the expert-cache probation guard.
    cmd.arg("--batch-size")
        .arg("512")
        .arg("--ubatch-size")
        .arg(eff_ubatch.to_string())
        // One slot per conversation the app is allowed to run at once.
        .arg("--parallel")
        .arg(slots.to_string())
        .args(chat_parsing_args())
        .stdout(Stdio::from(log_out))
        .stderr(Stdio::from(log_err));
    let mut child = cmd.spawn().map_err(|e| format!("spawn llama-server: {e}"))?;
    // Did somebody press Stop while all of the above was running?
    if SERVER_GEN.load(Ordering::SeqCst) != entry_gen {
        let _ = child.kill();
        let _ = child.wait();
        return Err("cancelled".into());
    }

    // Watchdog: the engine must die WITH the app in every death mode (crash,
    // force quit, kill -9), not only on the clean RunEvent::Exit path. A tiny
    // detached shell outlives us, watches our PID, and kills the server when
    // we are gone. It verifies the command name first so PID reuse can never
    // make it kill an unrelated process.
    {
        let app_pid = std::process::id();
        let srv_pid = child.id();
        let _ = Command::new("/bin/zsh")
            .arg("-c")
            .arg(format!(
                // It watches BOTH pids and leaves when either is gone. Watching
                // only the app meant one of these shells survived every model
                // change and every stop, waking up every three seconds until
                // the app closed: twenty models tried in a session left twenty
                // of them behind.
                "while kill -0 {app_pid} 2>/dev/null && kill -0 {srv_pid} 2>/dev/null; do sleep 3; done; \
                 if kill -0 {app_pid} 2>/dev/null; then exit 0; fi; \
                 if ps -p {srv_pid} -o comm= 2>/dev/null | grep -q llama-server; then \
                   kill {srv_pid} 2>/dev/null; sleep 2; kill -9 {srv_pid} 2>/dev/null; fi"
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    let generation = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        // The same question as after the spawn, asked again under the lock so
        // that a Stop landing in the window between the two cannot be lost:
        // from here on the child is in the state and Stop can reach it itself.
        if generation != entry_gen + 1 {
            drop(s);
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        s.child = Some(child);
        s.model_id = Some(model_id.clone());
        // Both expert paths are bit-exact, so the regime worth showing is the
        // residency one: it is what tells the user the model runs in a
        // fraction of its own size. CPU experts stay named, being the
        // cross-check regime rather than the default.
        s.mode = if dense {
            // Named for what it is. Every other regime here is a claim about
            // expert numerics; this one has no experts and makes no such claim.
            "stock-llamacpp".into()
        } else if !metal_experts {
            "cpu-bit-exact".into()
        } else if !bit_exact {
            // The user chose speed over the parity path. The name says so,
            // because a badge that still read "bit-exact" would be a claim this
            // engine is no longer making.
            if full_residency { "resident-fast".into() } else { "streamed-fast".into() }
        } else if full_residency {
            "resident-bit-exact".into()
        } else {
            "streamed-bit-exact".into()
        };
        s.phase = "starting".into();
    // Verdict of the PREVIOUS model: it says nothing about this one.
    s.tools_ok = None;
        s.generation = generation;
        s.port = port;
        s.slots = slots;
        s.ctx_per_slot = ctx_per_slot;
        s.footprint = Some(plan.decision.clone());
    }
    let _ = app.emit(
        "galactus://server",
        json!({"phase": "starting", "footprint": plan.decision}),
    );

    // Health poller: big models can take minutes to warm the arena. It also
    // watches for the process dying, so a broken server surfaces its error
    // instead of leaving the UI on "starting" forever.
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(900);
        loop {
            if Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(1000));
            {
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != generation || s.child.is_none() {
                    return;
                }
                // Did it exit already? Then it failed to load.
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        let tail = server_log_tail(12);
                        // The engine's own verdict, so a start that died for
                        // want of memory says so instead of handing the user
                        // twelve lines of log to interpret.
                        let kind = classify_engine_failure("", &engine_log_evidence());
                        s.child = None;
                        s.phase = "failed".into();
                        drop(s);
                        let _ = app.emit(
                            "galactus://server",
                            json!({"phase": "failed",
                                   "code": status.code(),
                                   "kind": kind,
                                   "log": tail}),
                        );
                        return;
                    }
                }
            }
            let ok = Command::new("curl")
                .args([
                    "-s",
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code}",
                    "--max-time",
                    "2",
                    &format!("http://127.0.0.1:{port}/health"),
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "200")
                .unwrap_or(false);
            if ok {
                // /health goes 200 once the non-expert weights are up, but the
                // real load (graph + Metal pipelines + first experts) only
                // happens on the first inference. Force it NOW with a tiny
                // generation so "ready" means actually ready, instead of the
                // first user message eating the whole warmup.
                {
                    let s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                    if s.generation != generation {
                        return;
                    }
                }
                let _ = Command::new("curl")
                    .args([
                        "-s",
                        "-o",
                        "/dev/null",
                        "--max-time",
                        "600",
                        "-H",
                        "Content-Type: application/json",
                        "-d",
                        r#"{"model":"galactus-local","messages":[{"role":"user","content":"ok"}],"max_tokens":4,"stream":false}"#,
                    ])
                    .arg(format!("http://127.0.0.1:{port}/v1/chat/completions"))
                    .output();
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                // Stopped or swapped during the warmup: stay silent.
                if s.generation != generation || s.child.is_none() {
                    return;
                }
                // A crash during the warmup leaves the child unreaped, so
                // is_none() alone would still declare ready on a dead server.
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        let tail = server_log_tail(12);
                        // The engine's own verdict, so a start that died for
                        // want of memory says so instead of handing the user
                        // twelve lines of log to interpret.
                        let kind = classify_engine_failure("", &engine_log_evidence());
                        s.child = None;
                        s.phase = "failed".into();
                        drop(s);
                        let _ = app.emit(
                            "galactus://server",
                            json!({"phase": "failed",
                                   "code": status.code(),
                                   "kind": kind,
                                   "log": tail}),
                        );
                        return;
                    }
                }
                s.phase = "ready".into();
                drop(s);
                let _ = app.emit("galactus://server", json!({"phase": "ready"}));

                // The tool probe runs AFTER ready is announced, never before.
                // It costs one short generation, and holding the UI on
                // "starting" for it would make a model that works perfectly
                // for chat look slower to load than it is. The agent surfaces
                // read `tools_ok` and stay disabled while it is still None.
                let verdict = probe_tool_calling(port);
                let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != generation || s.child.is_none() {
                    return;
                }
                s.tools_ok = verdict;
                drop(s);
                let _ = app.emit(
                    "galactus://server",
                    json!({"phase": "ready", "tools_ok": verdict}),
                );
                return;
            }
        }
        // Deadline passed: kill the stuck server so the state cannot claim
        // "starting" forever with a process nobody can reach.
        {
            let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
            if s.generation == generation {
                if let Some(mut child) = s.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                s.phase = "failed".into();
            }
        }
        let _ = app.emit("galactus://server", json!({"phase": "timeout"}));
    });
    Ok(())
}

// Async: child.wait() can block for the whole engine teardown.
#[tauri::command]
pub async fn server_stop() -> Result<(), String> {
    server_stop_impl()
}

pub(crate) fn server_stop_impl() -> Result<(), String> {
    // The child comes OUT of the lock before it is killed and waited on.
    //
    // Tearing down an engine holding ninety gigabytes is not instant, and the
    // lock was held for the whole of it. server_status wants the same lock and
    // is called from the UI on every tick, so stopping a large model froze the
    // window until the process was gone.
    let child = {
        let mut s = server_state().lock().unwrap_or_else(|e| e.into_inner());
        // A start already in flight belongs to the generation before this one,
        // so bumping here is how Stop reaches a model that has not been spawned
        // yet. Without it, the preamble of server_start (reading llama-server
        // and every dylib to check the patches, probing the machine, planning
        // the cache) runs for seconds during which Stop found `child == None`,
        // did nothing at all, and the ninety gigabyte model finished loading
        // as if nobody had asked.
        s.generation = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let taken = s.child.take();
        s.model_id = None;
        s.mode = String::new();
        s.phase = "stopped".into();
        s.port = 0;
        s.ctx_per_slot = 0;
        // The decision described a process that no longer exists: keeping it
        // would let the UI report a footprint for nothing.
        s.footprint = None;
        taken
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// The counter that lets Stop reach a start, and the trap it comes with.
#[cfg(test)]
mod server_generation_tests {
    use super::*;

    /// A start must not be cancelled by the stop it performs itself.
    ///
    /// WHAT THIS PINS, and it shipped broken. `server_start` stops whatever is
    /// running before launching the next model, and `server_stop_impl` bumps
    /// SERVER_GEN so that a Stop pressed during the slow preflight can reach a
    /// process that does not exist yet. Read the counter at the top of
    /// `server_start` and it is compared against a value the function's own
    /// internal stop has already moved: the check fires every time, and every
    /// model refuses to load with "cancelled". The counter has to be read
    /// AFTER that stop, and the difference between the two readings is what
    /// this test states.
    #[test]
    fn a_start_reads_its_generation_after_its_own_stop_and_not_before() {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let too_early = SERVER_GEN.load(Ordering::SeqCst);
        // The internal stop every start performs. With no child it is a no-op
        // apart from the thing that matters here.
        server_stop_impl().expect("stopping nothing is not a failure");
        let entry_gen = SERVER_GEN.load(Ordering::SeqCst);
        assert_ne!(
            too_early, entry_gen,
            "the internal stop is expected to bump the counter: that is the whole trap"
        );

        // What the start does next, and what it checks.
        let generation = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(
            generation,
            entry_gen + 1,
            "a start that read the counter after its own stop must not refuse itself"
        );
        assert_ne!(
            generation,
            too_early + 1,
            "reading before the stop is what shipped, and it cancelled every start"
        );
    }
}
