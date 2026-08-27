// Les connecteurs MCP: des programmes tiers parles en JSON-RPC sur stdio.
//
// Sorti de lib.rs avec sa banniere. Chaque serveur est un processus enfant que
// l'app demarre, interroge et doit tuer en partant, d'ou les pid gardes a part:
// un connecteur qui survit a l'application est un processus que personne ne
// reclame et que l'utilisateur ne sait pas nommer.

use crate::*;

pub(crate) struct McpServerProc {
    child: Child,
    stdin: std::process::ChildStdin,
    pending: Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>>,
    next_id: u64,
}

#[derive(Serialize, Clone)]
pub(crate) struct McpToolInfo {
    pub(crate) server: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
}

/// One lock PER SERVER, not one lock for all of them.
///
/// A single map-wide lock held across a call meant one slow connector stopped
/// every other connector: a tool call waits up to 60 seconds for its answer, and
/// while it waited nothing else could reach any MCP server, nor list one. Servers
/// are independent processes and the code now says so.
pub(crate) static MCP: OnceLock<Mutex<HashMap<String, Arc<Mutex<McpServerProc>>>>> = OnceLock::new();

pub(crate) static MCP_TOOLS: OnceLock<Mutex<Vec<McpToolInfo>>> = OnceLock::new();

/// Child pids, kept beside the map so shutdown never has to take a server lock.
/// At exit a connector may be mid-call, holding its own lock for another minute;
/// waiting for that to close the window would read as an app that will not quit.
pub(crate) static MCP_PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();

pub(crate) fn mcp_state() -> &'static Mutex<HashMap<String, Arc<Mutex<McpServerProc>>>> {
    MCP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn mcp_pids() -> &'static Mutex<Vec<u32>> {
    MCP_PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) const SIG_KILL: i32 = 9;

/// SIGKILL every connector child, by pid.
pub(crate) fn mcp_kill_children() {
    if let Ok(pids) = mcp_pids().lock() {
        for pid in pids.iter() {
            // SAFETY: a plain kill(2) on a pid this process spawned. A pid that
            // has already exited returns ESRCH, which is not an error here.
            unsafe { kill(*pid as i32, SIG_KILL) };
        }
    }
}

pub(crate) fn mcp_tools_state() -> &'static Mutex<Vec<McpToolInfo>> {
    MCP_TOOLS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) fn mcp_request(proc_: &mut McpServerProc, method: &str, params: Value) -> Result<Value, String> {
    proc_.next_id += 1;
    let id = proc_.next_id;
    let (tx, rx) = std::sync::mpsc::channel();
    proc_.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    writeln!(proc_.stdin, "{}", serde_json::to_string(&msg).unwrap()).map_err(|e| e.to_string())?;
    proc_.stdin.flush().map_err(|e| e.to_string())?;
    let res = rx.recv_timeout(Duration::from_secs(60));
    if res.is_err() {
        // Otherwise the sender leaks in the map, one entry per timeout.
        proc_.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
    res.map_err(|_| format!("MCP timeout on {method}"))
}

pub(crate) fn mcp_notify(proc_: &mut McpServerProc, method: &str, params: Value) -> Result<(), String> {
    let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
    writeln!(proc_.stdin, "{}", serde_json::to_string(&msg).unwrap()).map_err(|e| e.to_string())?;
    proc_.stdin.flush().map_err(|e| e.to_string())
}

/// A GUI app on macOS inherits a bare PATH (/usr/bin:/bin): npx, node, uvx
/// and friends live in Homebrew or user dirs and would never be found.
pub(crate) fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.volta/bin"),
    ];
    for extra in extras {
        if !path.split(':').any(|p| p == extra) {
            path.push(':');
            path.push_str(&extra);
        }
    }
    path
}

/// Resolve a connector command against the augmented PATH, with a clear
/// error instead of a silent ENOENT swallowed by the UI.
pub(crate) fn resolve_command(cmd: &str, path: &str) -> Result<PathBuf, String> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("command not found: {cmd}"))
        };
    }
    for dir in path.split(':') {
        let cand = Path::new(dir).join(cmd);
        if cand.is_file() {
            return Ok(cand);
        }
    }
    Err(format!("command '{cmd}' not found (PATH searched, Homebrew included). Install it or use an absolute path."))
}

#[tauri::command]
pub async fn mcp_reload() -> Result<Vec<McpToolInfo>, String> {
    // On a blocking thread: this spawns processes and runs an initialize
    // handshake per connector, and it waits on the lock of any server that is
    // mid-call. None of that belongs on an async worker.
    tauri::async_runtime::spawn_blocking(mcp_reload_blocking)
        .await
        .map_err(|e| format!("the connector thread died: {e}"))?
}

pub(crate) fn mcp_reload_blocking() -> Result<Vec<McpToolInfo>, String> {
    // One reload at a time: two concurrent reloads would each drain the
    // server map and spawn duplicate children.
    static RELOAD_GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _serial = RELOAD_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Tear down previous servers.
    {
        let drained: Vec<Arc<Mutex<McpServerProc>>> = {
            let mut servers = mcp_state().lock().unwrap_or_else(|e| e.into_inner());
            servers.drain().map(|(_, p)| p).collect()
        };
        mcp_pids().lock().unwrap_or_else(|e| e.into_inner()).clear();
        for p in drained {
            // Waits for an in-flight call on that server to return, which is the
            // right order: killing a child out from under a thread reading its
            // pipe turns a slow answer into a confusing error.
            let mut p = p.lock().unwrap_or_else(|e| e.into_inner());
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
    mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()).clear();

    let settings = settings_load();
    let config: Value = serde_json::from_str(settings.get("mcp").map(|s| s.as_str()).unwrap_or("{}"))
        .map_err(|e| format!("mcp config: {e}"))?;
    let empty = serde_json::Map::new();
    let servers_cfg = config["mcpServers"].as_object().unwrap_or(&empty);

    // One failing connector must not take the others down: each server is
    // started independently, failures are collected, and the tools of every
    // server that DID initialize are published regardless.
    let mut all_tools = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for (name, cfg) in servers_cfg {
        match mcp_start_server(name, cfg) {
            Ok((proc_, mut tools)) => {
                all_tools.append(&mut tools);
                mcp_pids().lock().unwrap_or_else(|e| e.into_inner()).push(proc_.child.id());
                mcp_state()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(name.clone(), Arc::new(Mutex::new(proc_)));
            }
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    *mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()) = all_tools.clone();
    if failures.is_empty() {
        Ok(all_tools)
    } else {
        // The healthy servers stay registered (mcp_tools serves their tools);
        // the error carries every failing connector for the UI.
        Err(failures.join("\n"))
    }
}

/// Spawn one MCP connector and run its initialize handshake. On any failure
/// past the spawn the child is killed and reaped: it must not linger as an
/// orphan behind the error.
pub(crate) fn mcp_start_server(name: &str, cfg: &Value) -> Result<(McpServerProc, Vec<McpToolInfo>), String> {
    let command = cfg["command"].as_str().ok_or("missing command".to_string())?;
    let args: Vec<String> = cfg["args"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let search_path = augmented_path();
    let bin = resolve_command(command, &search_path)?;
    let mut cmd = Command::new(bin);
    cmd.args(&args)
        // The child needs the full PATH too: npx must find node.
        .env("PATH", &search_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(env) = cfg["env"].as_object() {
        for (k, v) in env {
            if let Some(val) = v.as_str() {
                cmd.env(k, val);
            }
        }
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("no stdin".into());
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("no stdout".into());
        }
    };
    let pending: Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            // A line that does not decode is skipped, not fatal: this is a
            // child process's output, and one odd byte must not silence the
            // rest of it. Spelled out rather than written `.flatten()`, which
            // says the same thing and spins forever on a reader that fails
            // forever; a pipe reports EOF instead, so this loop ends.
            let Ok(line) = line else { continue };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = v["id"].as_u64() {
                    if let Some(tx) = pending_reader.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                        let _ = tx.send(v);
                    }
                }
            }
        }
    });

    let mut proc_ = McpServerProc { child, stdin, pending, next_id: 0 };
    let init_seq = (|| -> Result<Value, String> {
        mcp_request(
            &mut proc_,
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "galactus", "version": "0.1.0"}
            }),
        )?;
        mcp_notify(&mut proc_, "notifications/initialized", json!({}))?;
        mcp_request(&mut proc_, "tools/list", json!({}))
    })();
    let tools = match init_seq {
        Ok(t) => t,
        Err(e) => {
            let _ = proc_.child.kill();
            let _ = proc_.child.wait();
            return Err(e);
        }
    };
    let mut out = Vec::new();
    if let Some(list) = tools["result"]["tools"].as_array() {
        for tl in list {
            out.push(McpToolInfo {
                server: name.to_string(),
                name: tl["name"].as_str().unwrap_or("").to_string(),
                description: tl["description"].as_str().unwrap_or("").to_string(),
                input_schema: tl["inputSchema"].clone(),
            });
        }
    }
    Ok((proc_, out))
}

#[tauri::command]
pub fn mcp_tools() -> Vec<McpToolInfo> {
    mcp_tools_state().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub async fn mcp_call(server: String, tool: String, args: String) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(&args).unwrap_or(json!({}));
    // The map lock is held only long enough to find the server. Everything that
    // waits happens under that server's own lock, on a blocking thread, so a
    // connector taking its full minute blocks nothing but itself.
    let handle = {
        let servers = mcp_state().lock().unwrap_or_else(|e| e.into_inner());
        servers.get(&server).cloned().ok_or(format!("MCP server {server} not running"))?
    };
    let tool_for_call = tool.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut proc_ = handle.lock().unwrap_or_else(|e| e.into_inner());
        mcp_request(&mut proc_, "tools/call", json!({"name": tool_for_call, "arguments": parsed}))
    })
    .await
    .map_err(|e| format!("the connector thread died: {e}"))??;
    if let Some(err) = response.get("error") {
        return Err(err["message"].as_str().unwrap_or("MCP error").to_string());
    }
    // Concatenate text content blocks; pass through anything else as JSON.
    let content = &response["result"]["content"];
    if let Some(blocks) = content.as_array() {
        let texts: Vec<String> = blocks
            .iter()
            .filter_map(|b| b["text"].as_str().map(String::from))
            .collect();
        if !texts.is_empty() {
            return Ok(texts.join("\n"));
        }
    }
    Ok(response["result"].to_string())
}
