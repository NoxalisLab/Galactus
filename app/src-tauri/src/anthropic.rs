// OpenAI chat-completions <-> Anthropic Messages, both directions.
//
// The agent speaks OpenAI to every teammate, local or not. Anthropic's API is
// not OpenAI-shaped, and its own OpenAI-compatibility layer is documented as a
// testing aid, not a production path, so the cloud proxy translates here: the
// request on the way out, the answer (whole or streamed) on the way back.
//
// Pure functions and one small state machine, no I/O: every rule below is
// something the Messages API enforces with a 400, and each one is pinned by a
// test on a realistic payload.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Output budget when the caller named none. The Messages API requires one.
const DEFAULT_MAX_TOKENS: u64 = 16_000;
/// Streaming has no HTTP timeout to fear, so a long answer is allowed.
const DEFAULT_MAX_TOKENS_STREAM: u64 = 64_000;
/// Said when the provider refused and gave no text of its own, so the thread
/// shows why the answer is empty.
pub(crate) const REFUSED: &str = "Refused by the provider.";

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The text of an OpenAI content field: a string, or the text parts of an array.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// One OpenAI image part as an Anthropic image block.
fn image_block(url: &str) -> Option<Value> {
    if let Some(rest) = url.strip_prefix("data:") {
        // data:<media>;base64,<data>
        let (meta, data) = rest.split_once(',')?;
        let media = meta.strip_suffix(";base64")?;
        return Some(json!({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}));
    }
    if url.starts_with("https://") || url.starts_with("http://") {
        return Some(json!({"type": "image", "source": {"type": "url", "url": url}}));
    }
    None
}

/// An OpenAI content field as Anthropic blocks. Empty text is dropped: the API
/// refuses a text block with nothing in it.
fn content_blocks(content: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    match content {
        Value::String(s) if !s.is_empty() => out.push(json!({"type": "text", "text": s})),
        Value::Array(parts) => {
            for p in parts {
                match p["type"].as_str() {
                    Some("image_url") => {
                        let url = p["image_url"]["url"].as_str().or(p["image_url"].as_str());
                        if let Some(b) = url.and_then(image_block) {
                            out.push(b);
                        }
                    }
                    _ => {
                        if let Some(t) = p["text"].as_str().filter(|t| !t.is_empty()) {
                            out.push(json!({"type": "text", "text": t}));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// Append blocks under a role, merging into the previous message when it has
/// the same role: the API requires user and assistant to alternate.
fn push(out: &mut Vec<(String, Vec<Value>)>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    match out.last_mut() {
        Some((r, b)) if r == role => b.extend(blocks),
        _ => out.push((role.to_string(), blocks)),
    }
}

/// An OpenAI chat-completions request as a Messages request. Returns the body
/// and whether it streams.
pub(crate) fn translate_request(req: &Value, model: &str) -> Result<(Value, bool), String> {
    let stream = req["stream"].as_bool().unwrap_or(false);
    let msgs = req["messages"].as_array().ok_or("the request has no messages")?;
    let mut system: Vec<String> = Vec::new();
    let mut turns: Vec<(String, Vec<Value>)> = Vec::new();
    for m in msgs {
        match m["role"].as_str().unwrap_or("") {
            // The Messages API has one system prompt, outside the turns.
            "system" | "developer" => {
                let t = text_of(&m["content"]);
                if !t.trim().is_empty() {
                    system.push(t);
                }
            }
            "assistant" => {
                let mut blocks = content_blocks(&m["content"]);
                for tc in m["tool_calls"].as_array().into_iter().flatten() {
                    let args = tc["function"]["arguments"].as_str().unwrap_or("");
                    // `input` must be an object. A model that wrote broken JSON
                    // as arguments still made the call; it is sent as empty
                    // rather than failing the whole conversation on it.
                    let input = match serde_json::from_str::<Value>(args) {
                        Ok(v @ Value::Object(_)) => v,
                        _ => json!({}),
                    };
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc["id"].as_str().unwrap_or(""),
                        "name": tc["function"]["name"].as_str().unwrap_or(""),
                        "input": input,
                    }));
                }
                push(&mut turns, "assistant", blocks);
            }
            // Every tool result answering one assistant turn goes into ONE user
            // message: the API rejects results split across several. Merging
            // consecutive same-role turns does exactly that.
            "tool" => {
                let mut block = Map::new();
                block.insert("type".into(), json!("tool_result"));
                block.insert("tool_use_id".into(), json!(m["tool_call_id"].as_str().unwrap_or("")));
                let t = text_of(&m["content"]);
                if !t.is_empty() {
                    block.insert("content".into(), json!(t));
                }
                push(&mut turns, "user", vec![Value::Object(block)]);
            }
            _ => push(&mut turns, "user", content_blocks(&m["content"])),
        }
    }
    // The conversation must open on a user turn.
    if turns.first().map(|(r, _)| r.as_str()) != Some("user") {
        turns.insert(0, ("user".into(), vec![json!({"type": "text", "text": "Continue."})]));
    }
    let messages: Vec<Value> = turns
        .into_iter()
        .map(|(role, content)| json!({"role": role, "content": content}))
        .collect();

    let max_tokens = req["max_completion_tokens"]
        .as_u64()
        .or(req["max_tokens"].as_u64())
        .filter(|n| *n > 0)
        .unwrap_or(if stream { DEFAULT_MAX_TOKENS_STREAM } else { DEFAULT_MAX_TOKENS });

    // Built from what is KEPT, not by deleting what is not: temperature, top_p,
    // top_k, penalties, seed and the llama.cpp extras (id_slot, cache_prompt,
    // chat_template_kwargs) are rejected with a 400 by current Claude models,
    // and a list of exclusions would miss the next one a caller adds. No
    // "thinking" either: the model's default is used.
    let mut out = Map::new();
    out.insert("model".into(), json!(model));
    out.insert("max_tokens".into(), json!(max_tokens));
    out.insert("messages".into(), json!(messages));
    if !system.is_empty() {
        out.insert("system".into(), json!(system.join("\n\n")));
    }
    let tools: Vec<Value> = req["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let f = &t["function"];
            let name = f["name"].as_str()?;
            let mut tool = Map::new();
            tool.insert("name".into(), json!(name));
            if let Some(d) = f["description"].as_str() {
                tool.insert("description".into(), json!(d));
            }
            let schema = match &f["parameters"] {
                v @ Value::Object(_) => v.clone(),
                _ => json!({"type": "object", "properties": {}}),
            };
            tool.insert("input_schema".into(), schema);
            Some(Value::Object(tool))
        })
        .collect();
    if !tools.is_empty() {
        out.insert("tools".into(), json!(tools));
        // A forced tool choice is answered with a 400 by the newest models, so
        // anything but "none" becomes auto. Without tools it is not sent at all.
        let choice = match req["tool_choice"].as_str() {
            Some("none") => "none",
            _ => "auto",
        };
        out.insert("tool_choice".into(), json!({"type": choice}));
    }
    let stops: Vec<Value> = match &req["stop"] {
        Value::String(s) => vec![json!(s)],
        Value::Array(a) => a.iter().filter(|s| s.is_string()).cloned().collect(),
        _ => vec![],
    };
    if !stops.is_empty() {
        out.insert("stop_sequences".into(), json!(stops));
    }
    if stream {
        out.insert("stream".into(), json!(true));
    }
    Ok((Value::Object(out), stream))
}

/// Anthropic's stop_reason as an OpenAI finish_reason.
pub(crate) fn finish_reason(stop: &str) -> &'static str {
    match stop {
        "tool_use" => "tool_calls",
        "max_tokens" | "model_context_window_exceeded" => "length",
        "refusal" => "content_filter",
        // end_turn, stop_sequence, pause_turn and anything new.
        _ => "stop",
    }
}

/// Prompt tokens as the cap must see them. Cache reads and cache writes are
/// billed at other rates than input, and are all counted AT THE INPUT PRICE
/// here: a read costs a tenth of that and a write a little more, so the sum
/// over-estimates in the usual case, which is the safe side for a cap.
fn prompt_tokens(u: &Value) -> u64 {
    ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .iter()
        .map(|k| u[*k].as_u64().unwrap_or(0))
        .sum()
}

/// A whole (non-streamed) Messages answer as a chat completion, with its usage.
pub(crate) fn translate_response(v: &Value) -> (Value, u64, u64) {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls = Vec::new();
    for b in v["content"].as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("text") => text.push_str(b["text"].as_str().unwrap_or("")),
            Some("thinking") => reasoning.push_str(b["thinking"].as_str().unwrap_or("")),
            Some("tool_use") => calls.push(json!({
                "id": b["id"],
                "type": "function",
                "function": {"name": b["name"], "arguments": b["input"].to_string()},
            })),
            _ => {}
        }
    }
    let finish = finish_reason(v["stop_reason"].as_str().unwrap_or("end_turn"));
    if finish == "content_filter" && text.is_empty() {
        text = REFUSED.into();
    }
    let (p, c) = (prompt_tokens(&v["usage"]), v["usage"]["output_tokens"].as_u64().unwrap_or(0));
    let mut message = json!({"role": "assistant", "content": text});
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    let out = json!({
        "id": v["id"],
        "object": "chat.completion",
        "created": now(),
        "model": v["model"],
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c},
    });
    (out, p, c)
}

/// An Anthropic error body as the OpenAI error shape, for the same status.
pub(crate) fn translate_error(status: u16, body: &[u8]) -> Value {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let message = v["error"]["message"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().chars().take(500).collect());
    let kind = v["error"]["type"].as_str().unwrap_or("upstream_error");
    json!({"error": {"message": format!("anthropic: {message}"), "type": kind, "code": status}})
}

/// The streamed answer, event by event, as OpenAI chunks.
///
/// Fed raw bytes as they arrive; an event cut across two reads waits in the
/// buffer until its blank line comes. What it returns is ready to write to the
/// client: `data: {...}\n\n` lines, and `data: [DONE]` once.
#[derive(Default)]
pub(crate) struct StreamTranslator {
    buf: Vec<u8>,
    id: String,
    model: String,
    created: u64,
    /// Anthropic content-block index -> OpenAI tool_calls index.
    tools: HashMap<u64, u64>,
    next_tool: u64,
    pub(crate) prompt_tokens: u64,
    pub(crate) completion_tokens: u64,
    finish: Option<&'static str>,
    sent_text: bool,
    done: bool,
}

impl StreamTranslator {
    pub(crate) fn new() -> Self {
        StreamTranslator { created: now(), ..Default::default() }
    }

    fn chunk(&self, delta: Value, finish: Option<&str>, usage: Option<Value>) -> String {
        let mut c = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        if let Some(u) = usage {
            c["usage"] = u;
        }
        format!("data: {c}\n\n")
    }

    fn usage(&self) -> Value {
        json!({
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
        })
    }

    /// Whether the stream reached its end (message_stop or an error).
    #[cfg(test)]
    pub(crate) fn is_done(&self) -> bool {
        self.done
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> String {
        self.buf.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            // Events end on a blank line; the boundary is ASCII, so splitting
            // bytes there never cuts a UTF-8 character.
            let lf = self.buf.windows(2).position(|w| w == b"\n\n").map(|p| (p, 2));
            let crlf = self.buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| (p, 4));
            let Some((at, len)) = [lf, crlf].into_iter().flatten().min_by_key(|(p, _)| *p) else {
                break;
            };
            let event: Vec<u8> = self.buf.drain(..at + len).collect();
            out.push_str(&self.event(&String::from_utf8_lossy(&event[..at])));
        }
        out
    }

    fn event(&mut self, raw: &str) -> String {
        if self.done {
            return String::new();
        }
        let data: String = raw
            .lines()
            .filter_map(|l| l.trim_end_matches('\r').strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        let Ok(v) = serde_json::from_str::<Value>(&data) else { return String::new() };
        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                let m = &v["message"];
                self.id = m["id"].as_str().unwrap_or("").to_string();
                self.model = m["model"].as_str().unwrap_or("").to_string();
                self.prompt_tokens = prompt_tokens(&m["usage"]);
                self.completion_tokens = m["usage"]["output_tokens"].as_u64().unwrap_or(0);
                self.chunk(json!({"role": "assistant", "content": ""}), None, None)
            }
            "content_block_start" => {
                let b = &v["content_block"];
                match b["type"].as_str() {
                    Some("tool_use") => {
                        let k = self.next_tool;
                        self.next_tool += 1;
                        self.tools.insert(v["index"].as_u64().unwrap_or(0), k);
                        self.chunk(
                            json!({"tool_calls": [{"index": k, "id": b["id"], "type": "function",
                                                   "function": {"name": b["name"], "arguments": ""}}]}),
                            None,
                            None,
                        )
                    }
                    Some("text") => match b["text"].as_str().filter(|t| !t.is_empty()) {
                        Some(t) => {
                            self.sent_text = true;
                            self.chunk(json!({"content": t}), None, None)
                        }
                        None => String::new(),
                    },
                    _ => String::new(),
                }
            }
            "content_block_delta" => {
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let t = d["text"].as_str().unwrap_or("");
                        if t.is_empty() {
                            return String::new();
                        }
                        self.sent_text = true;
                        self.chunk(json!({"content": t}), None, None)
                    }
                    Some("input_json_delta") => {
                        let part = d["partial_json"].as_str().unwrap_or("");
                        let Some(k) = self.tools.get(&v["index"].as_u64().unwrap_or(0)).copied() else {
                            return String::new();
                        };
                        if part.is_empty() {
                            return String::new();
                        }
                        self.chunk(json!({"tool_calls": [{"index": k, "function": {"arguments": part}}]}), None, None)
                    }
                    Some("thinking_delta") => {
                        let t = d["thinking"].as_str().unwrap_or("");
                        if t.is_empty() {
                            return String::new();
                        }
                        self.chunk(json!({"reasoning_content": t}), None, None)
                    }
                    // signature_delta and anything newer carry nothing to show.
                    _ => String::new(),
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    self.finish = Some(finish_reason(s));
                }
                let u = &v["usage"];
                if let Some(o) = u["output_tokens"].as_u64() {
                    // Cumulative, not a delta.
                    self.completion_tokens = o;
                }
                if u.get("input_tokens").and_then(Value::as_u64).is_some() {
                    self.prompt_tokens = prompt_tokens(u);
                }
                String::new()
            }
            "message_stop" => {
                self.done = true;
                let finish = self.finish.unwrap_or("stop");
                let mut out = String::new();
                if finish == "content_filter" && !self.sent_text {
                    out.push_str(&self.chunk(json!({"content": REFUSED}), None, None));
                }
                // Finish and usage in ONE chunk that still has a choice, so a
                // client reading choices[0] on every chunk never meets an
                // empty array.
                out.push_str(&self.chunk(json!({}), Some(finish), Some(self.usage())));
                out.push_str("data: [DONE]\n\n");
                out
            }
            "error" => {
                self.done = true;
                let e = &v["error"];
                format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({"error": {"message": format!("anthropic: {}", e["message"].as_str().unwrap_or("stream error")),
                                     "type": e["type"].as_str().unwrap_or("upstream_error")}})
                )
            }
            // ping, content_block_stop, and events added later.
            _ => String::new(),
        }
    }

    /// Called at EOF. A stream that ended without message_stop was cut: the
    /// client is told so, and still gets its [DONE].
    pub(crate) fn finish(&mut self) -> String {
        let mut out = String::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            out.push_str(&self.event(&String::from_utf8_lossy(&rest)));
        }
        if !self.done {
            self.done = true;
            out.push_str(&format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"error": {"message": "anthropic: the stream ended before the answer did", "type": "upstream_error"}})
            ));
        }
        out
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A turn of the agent loop as the webview sends it to a llama-server:
    /// two system messages, a user question, an assistant tool call, two tool
    /// results, and the llama.cpp extras that Claude would reject.
    fn agent_request(stream: bool) -> Value {
        json!({
            "model": "galactus-local",
            "stream": stream,
            "temperature": 0.6, "top_p": 0.95, "top_k": 20, "seed": 7,
            "frequency_penalty": 0.1, "presence_penalty": 0.1,
            "id_slot": 1, "cache_prompt": true,
            "chat_template_kwargs": {"enable_thinking": false},
            "max_tokens": 2048,
            "tool_choice": "required",
            "tools": [{"type": "function", "function": {
                "name": "read_file", "description": "Read a file",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}],
            "messages": [
                {"role": "system", "content": "You are the expert."},
                {"role": "system", "content": [{"type": "text", "text": "Answer in French."}]},
                {"role": "user", "content": "Read a.txt and b.txt"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"a.txt\"}"}},
                    {"id": "call_2", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"b.txt\"}"}}]},
                {"role": "tool", "tool_call_id": "call_1", "content": "alpha"},
                {"role": "tool", "tool_call_id": "call_2", "content": "beta"},
                {"role": "user", "content": "Now compare them."},
                {"role": "user", "content": [
                    {"type": "text", "text": "And this image."},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}]}
            ]
        })
    }

    #[test]
    fn system_messages_become_the_one_system_prompt() {
        let (r, _) = translate_request(&agent_request(false), "claude-opus-5").unwrap();
        assert_eq!(r["system"], "You are the expert.\n\nAnswer in French.");
        assert!(r["messages"].as_array().unwrap().iter().all(|m| m["role"] != "system"));
    }

    #[test]
    fn tool_calls_and_their_results_keep_their_pairing_and_the_turns_alternate() {
        let (r, _) = translate_request(&agent_request(false), "claude-opus-5").unwrap();
        let m = r["messages"].as_array().unwrap();
        let roles: Vec<&str> = m.iter().map(|x| x["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["user", "assistant", "user"], "strict alternation");
        // The empty assistant text was dropped, the two calls kept, input parsed.
        let a = m[1]["content"].as_array().unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0], json!({"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a.txt"}}));
        // BOTH results in ONE user message, first, then the two user turns merged after them.
        let u = m[2]["content"].as_array().unwrap();
        assert_eq!(u[0], json!({"type": "tool_result", "tool_use_id": "call_1", "content": "alpha"}));
        assert_eq!(u[1], json!({"type": "tool_result", "tool_use_id": "call_2", "content": "beta"}));
        assert_eq!(u[2], json!({"type": "text", "text": "Now compare them."}));
        assert_eq!(u[3], json!({"type": "text", "text": "And this image."}));
        assert_eq!(
            u[4],
            json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}})
        );
    }

    #[test]
    fn sampling_and_llama_parameters_are_dropped_and_the_rest_mapped() {
        let (r, stream) = translate_request(&agent_request(false), "claude-opus-5").unwrap();
        assert!(!stream);
        for k in ["temperature", "top_p", "top_k", "seed", "frequency_penalty", "presence_penalty",
                  "id_slot", "cache_prompt", "chat_template_kwargs", "thinking", "stream", "tool_choice_x"] {
            assert!(r.get(k).is_none(), "{k} must not be sent: {r}");
        }
        assert_eq!(r["model"], "claude-opus-5");
        assert_eq!(r["max_tokens"], 2048);
        assert_eq!(r["tool_choice"], json!({"type": "auto"}), "a forced choice becomes auto");
        assert_eq!(
            r["tools"][0],
            json!({"name": "read_file", "description": "Read a file",
                   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}})
        );
    }

    #[test]
    fn max_tokens_defaults_and_tool_choice_edges() {
        let base = json!({"messages": [{"role": "user", "content": "hi"}]});
        assert_eq!(translate_request(&base, "m").unwrap().0["max_tokens"], 16000);
        let mut s = base.clone();
        s["stream"] = json!(true);
        let (r, stream) = translate_request(&s, "m").unwrap();
        assert!(stream);
        assert_eq!((r["max_tokens"].as_u64(), r["stream"].as_bool()), (Some(64000), Some(true)));
        let mut c = base.clone();
        c["max_completion_tokens"] = json!(900);
        c["max_tokens"] = json!(100);
        assert_eq!(translate_request(&c, "m").unwrap().0["max_tokens"], 900);
        // tool_choice without tools is not sent; "none" stays none.
        let mut n = base.clone();
        n["tool_choice"] = json!("none");
        assert!(translate_request(&n, "m").unwrap().0.get("tool_choice").is_none());
        let mut t = agent_request(false);
        t["tool_choice"] = json!("none");
        assert_eq!(translate_request(&t, "m").unwrap().0["tool_choice"], json!({"type": "none"}));
        // A conversation that opens on the assistant is given a user turn first.
        let a = json!({"messages": [{"role": "assistant", "content": "hello"}, {"role": "user", "content": "go"}]});
        assert_eq!(translate_request(&a, "m").unwrap().0["messages"][0]["role"], "user");
        assert!(translate_request(&json!({}), "m").is_err());
    }

    #[test]
    fn a_whole_answer_with_text_and_a_tool_call() {
        let v = json!({
            "id": "msg_01", "type": "message", "role": "assistant", "model": "claude-opus-5",
            "content": [
                {"type": "text", "text": "Je lis le fichier."},
                {"type": "tool_use", "id": "toolu_01", "name": "read_file", "input": {"path": "a.txt"}}],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 100, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 10, "output_tokens": 30}
        });
        let (o, p, c) = translate_response(&v);
        assert_eq!((p, c), (160, 30));
        let ch = &o["choices"][0];
        assert_eq!(ch["finish_reason"], "tool_calls");
        assert_eq!(ch["message"]["content"], "Je lis le fichier.");
        assert_eq!(ch["message"]["tool_calls"][0]["id"], "toolu_01");
        assert_eq!(ch["message"]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"a.txt\"}");
        assert_eq!(o["usage"]["total_tokens"], 190);
    }

    #[test]
    fn stop_reasons_and_a_silent_refusal() {
        assert_eq!(finish_reason("end_turn"), "stop");
        assert_eq!(finish_reason("stop_sequence"), "stop");
        assert_eq!(finish_reason("tool_use"), "tool_calls");
        assert_eq!(finish_reason("max_tokens"), "length");
        assert_eq!(finish_reason("refusal"), "content_filter");
        let v = json!({"id": "m", "model": "x", "content": [], "stop_reason": "refusal",
                       "usage": {"input_tokens": 5, "output_tokens": 0}});
        let (o, _, _) = translate_response(&v);
        assert_eq!(o["choices"][0]["finish_reason"], "content_filter");
        assert_eq!(o["choices"][0]["message"]["content"], REFUSED);
    }

    #[test]
    fn provider_errors_keep_their_status_in_the_openai_shape() {
        let body = br#"{"type":"error","error":{"type":"invalid_request_error","message":"temperature is not supported"}}"#;
        let e = translate_error(400, body);
        assert_eq!(e["error"]["type"], "invalid_request_error");
        assert_eq!(e["error"]["code"], 400);
        assert_eq!(e["error"]["message"], "anthropic: temperature is not supported");
        let e = translate_error(529, b"overloaded");
        assert_eq!(e["error"]["message"], "anthropic: overloaded");
    }

    /// A stream as Anthropic sends it: thinking, text, then a tool call whose
    /// arguments arrive in pieces, then the usage and the stop.
    pub(crate) const RECORDED: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01X\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-5\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":472,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":1200,\"output_tokens\":2}}}\n\n\
event: ping\n\
data: {\"type\":\"ping\"}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Il faut lire le fichier.\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"EqQBCgIYAhIM\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Je regarde \"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"le fichier.\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":1}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01T\",\"name\":\"read_file\",\"input\":{}}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\": \\\"a\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\".txt\\\"}\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":2}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":89}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

    fn chunks(out: &str) -> Vec<Value> {
        out.split("\n\n")
            .filter_map(|e| e.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .map(|d| serde_json::from_str(d).unwrap())
            .collect()
    }

    #[test]
    fn a_recorded_stream_becomes_openai_chunks() {
        let mut t = StreamTranslator::new();
        let out = t.feed(RECORDED.as_bytes()) + &t.finish();
        assert!(out.ends_with("data: [DONE]\n\n"));
        assert_eq!(out.matches("[DONE]").count(), 1);
        let c = chunks(&out);
        let deltas: Vec<&Value> = c.iter().map(|x| &x["choices"][0]["delta"]).collect();
        assert_eq!(deltas[0]["role"], "assistant");
        assert_eq!(c[0]["id"], "msg_01X");
        let reasoning: String = deltas.iter().filter_map(|d| d["reasoning_content"].as_str()).collect();
        assert_eq!(reasoning, "Il faut lire le fichier.");
        let text: String = deltas.iter().filter_map(|d| d["content"].as_str()).collect();
        assert_eq!(text, "Je regarde le fichier.");
        // The tool call: opened with id and name, then its arguments in pieces,
        // all on OpenAI index 0 although it is Anthropic block 2.
        let calls: Vec<&Value> = deltas.iter().filter_map(|d| d["tool_calls"].get(0)).collect();
        assert_eq!(calls[0]["id"], "toolu_01T");
        assert_eq!(calls[0]["function"]["name"], "read_file");
        assert!(calls.iter().all(|c| c["index"] == 0));
        let args: String = calls.iter().filter_map(|c| c["function"]["arguments"].as_str()).collect();
        assert_eq!(serde_json::from_str::<Value>(&args).unwrap(), json!({"path": "a.txt"}));
        // Last chunk: finish reason and usage together, cache reads counted.
        let last = c.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(last["usage"], json!({"prompt_tokens": 1672, "completion_tokens": 89, "total_tokens": 1761}));
        assert_eq!((t.prompt_tokens, t.completion_tokens), (1672, 89));
        // What the proxy's usage reader sees at the end of the stream.
        assert_eq!(crate::cloud::extract_usage(out.as_bytes()).map(|u| (u.0, u.1)), Some((1672, 89)));
    }

    #[test]
    fn the_same_stream_cut_at_every_byte_gives_the_same_chunks() {
        let whole = {
            let mut t = StreamTranslator::new();
            t.feed(RECORDED.as_bytes()) + &t.finish()
        };
        let strip = |s: &str| {
            chunks(s)
                .into_iter()
                .map(|mut v| {
                    v["created"] = json!(0);
                    v
                })
                .collect::<Vec<_>>()
        };
        for step in [1, 7, 64] {
            let mut t = StreamTranslator::new();
            let mut out = String::new();
            for piece in RECORDED.as_bytes().chunks(step) {
                out.push_str(&t.feed(piece));
            }
            out.push_str(&t.finish());
            assert_eq!(strip(&out), strip(&whole), "cut every {step} bytes");
        }
    }

    #[test]
    fn two_tool_calls_get_two_openai_indices() {
        let s = "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"model\":\"x\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"f\",\"input\":{}}}\n\n\
data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"b\",\"name\":\"g\",\"input\":{}}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n";
        let mut t = StreamTranslator::new();
        let c = chunks(&t.feed(s.as_bytes()));
        let idx: Vec<u64> = c.iter().filter_map(|x| x["choices"][0]["delta"]["tool_calls"][0]["index"].as_u64()).collect();
        assert_eq!(idx, [0, 1, 1]);
    }

    #[test]
    fn a_refusal_mid_stream_and_an_error_event_and_a_cut_stream() {
        let refusal = "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"model\":\"x\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"},\"usage\":{\"output_tokens\":0}}\n\n\
data: {\"type\":\"message_stop\"}\n\n";
        let mut t = StreamTranslator::new();
        let c = chunks(&t.feed(refusal.as_bytes()));
        let text: String = c.iter().filter_map(|x| x["choices"][0]["delta"]["content"].as_str()).collect();
        assert_eq!(text, REFUSED);
        assert_eq!(c.last().unwrap()["choices"][0]["finish_reason"], "content_filter");

        let err = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let mut t = StreamTranslator::new();
        let out = t.feed(err.as_bytes());
        assert!(t.is_done());
        assert_eq!(chunks(&out)[0]["error"]["type"], "overloaded_error");
        assert!(out.ends_with("data: [DONE]\n\n"));
        assert_eq!(t.finish(), "", "nothing more after the error");

        let mut t = StreamTranslator::new();
        let _ = t.feed(b"data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"model\":\"x\",\"usage\":{}}}\n\n");
        let out = t.finish();
        assert!(out.contains("ended before the answer did") && out.ends_with("data: [DONE]\n\n"));
    }
}
