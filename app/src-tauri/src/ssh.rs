//! Saved SSH hosts, and a terminal session on one of them.
//!
//! WHAT THIS IS. A list of machines the user works on, and a button that opens
//! a real terminal session on one. Nothing more: this is not remote
//! development, the editor stays local, and the files on the other side are
//! reached the way they always were, with the tools already on that machine.
//!
//! WHAT IT DELIBERATELY DOES NOT DO.
//!
//! It never stores a password, and it never types one. Authentication is
//! whatever the user's own ssh already does: keys, an agent, a `~/.ssh/config`
//! entry. That is not a limitation to work around later, it is the design. A
//! password in a settings file is a password in a settings file, and an app
//! that types one has to hold it in memory in cleartext.
//!
//! It never runs a command the webview supplied. The frontend names a saved
//! host by its id; this module builds the argv. An arbitrary command crossing
//! that boundary would be a way to run anything with no permission dialog,
//! which is exactly what the gate on model actions exists to prevent.
//!
//! It never disables host key checking. A prompt about an unknown host is the
//! one moment ssh protects the user from talking to the wrong machine, and it
//! appears in the terminal where they can read and answer it.

use crate::settings_load;
use crate::settings_update;
use serde::{Deserialize, Serialize};

/// One machine the user has saved.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SshHost {
    /// Stable id, minted here, used by the frontend to ask for a session.
    pub id: String,
    /// What the user calls this machine.
    pub label: String,
    /// `user@hostname`, or a plain alias from the user's ~/.ssh/config.
    pub target: String,
    /// Optional; ssh's own default and any config entry apply when absent.
    pub port: Option<u16>,
}

const KEY: &str = "ssh_hosts";

/// Whether a target is one this module will hand to ssh.
///
/// ssh's own argument grammar is the reason this is strict. A target beginning
/// with a dash is an option; one containing whitespace or a shell metacharacter
/// is a sentence heading for a process. The accepted shape is written down
/// rather than assumed, exactly as it is for a clone URL.
pub fn is_valid_target(target: &str) -> bool {
    let t = target.trim();
    if t.is_empty() || t.len() > 255 || t.starts_with('-') {
        return false;
    }
    if t.chars().any(|c| c.is_whitespace() || "\"'`$;|&<>()[]{}\\*?!#".contains(c)) {
        return false;
    }
    // At most one @, and a non-empty host after it.
    let host = match t.split_once('@') {
        Some((user, rest)) => {
            if user.is_empty() || rest.is_empty() || rest.contains('@') {
                return false;
            }
            rest
        }
        None => t,
    };
    // A hostname, an IPv4, or a config alias: letters, digits, dot, dash,
    // underscore. Colons are refused, since a port belongs in its own field
    // where it can be checked as a number.
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// The saved machines, or an error when the stored value cannot be read.
///
/// Absent is an empty list, which is a first run. Present and unreadable is
/// NOT an empty list: it used to become one, and the next save wrote that
/// emptiness over the original, so every machine the user had entered
/// disappeared with no message. Written by a newer version, or edited by hand,
/// both end the same way.
fn read_hosts() -> Result<Vec<SshHost>, String> {
    match settings_load().get(KEY) {
        None => Ok(Vec::new()),
        Some(raw) if raw.trim().is_empty() => Ok(Vec::new()),
        Some(raw) => serde_json::from_str::<Vec<SshHost>>(raw)
            .map_err(|e| format!("the saved machines could not be read ({e}); nothing was changed")),
    }
}

fn load() -> Vec<SshHost> {
    read_hosts().unwrap_or_default()
}

fn store(hosts: &[SshHost]) -> Result<(), String> {
    let encoded = serde_json::to_string(hosts).map_err(|e| e.to_string())?;
    settings_update(|m| {
        m.insert(KEY.to_string(), encoded);
    })
}

#[tauri::command]
pub fn ssh_hosts() -> Vec<SshHost> {
    load()
}

/// Save a host, or update the one with this id.
#[tauri::command]
pub fn ssh_host_save(
    id: Option<String>,
    label: String,
    target: String,
    port: Option<u16>,
) -> Result<Vec<SshHost>, String> {
    let target = target.trim().to_string();
    if !is_valid_target(&target) {
        return Err("that address cannot be used: write user@host, or a name from your ~/.ssh/config".into());
    }
    if let Some(p) = port {
        if p == 0 {
            return Err("a port must be between 1 and 65535".into());
        }
    }
    let label = {
        let l = label.trim();
        if l.is_empty() { target.clone() } else { l.to_string() }
    };
    let mut hosts = read_hosts()?;
    match id.filter(|s| !s.is_empty()) {
        Some(existing) => {
            let slot = hosts
                .iter_mut()
                .find(|h| h.id == existing)
                .ok_or("no saved machine with that id")?;
            slot.label = label;
            slot.target = target;
            slot.port = port;
        }
        None => {
            // Minted from the target plus a counter, so two entries for the
            // same machine do not collide and an id never contains user text
            // that could confuse a lookup.
            let mut n = hosts.len();
            let mut fresh = format!("h{n}");
            while hosts.iter().any(|h| h.id == fresh) {
                n += 1;
                fresh = format!("h{n}");
            }
            hosts.push(SshHost { id: fresh, label, target, port });
        }
    }
    store(&hosts)?;
    Ok(hosts)
}

#[tauri::command]
pub fn ssh_host_remove(id: String) -> Result<Vec<SshHost>, String> {
    let mut hosts = read_hosts()?;
    hosts.retain(|h| h.id != id);
    store(&hosts)?;
    Ok(hosts)
}

/// The argv for a saved host.
///
/// Separated from the spawn so it can be tested without opening a pty, and so
/// the exact flags are visible in one place rather than spread through a
/// builder.
pub fn ssh_argv(host: &SshHost) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = host.port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    // Ask for a tty explicitly: ssh only allocates one when its own stdin is a
    // tty, and a pty master is not always enough to convince it. Without this a
    // remote shell comes up with no prompt and no line editing, which reads as
    // a broken connection.
    args.push("-t".into());
    // Stop parsing options. Belt and braces on top of is_valid_target: the
    // target can never be read as a flag even if that check is ever loosened.
    args.push("--".into());
    args.push(host.target.clone());
    args
}

/// Open a terminal session on a saved machine.
#[tauri::command]
pub async fn ssh_spawn(
    app: tauri::AppHandle,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<crate::pty::SpawnedSession, String> {
    let host = load().into_iter().find(|h| h.id == id).ok_or("no saved machine with that id")?;
    // Re-validated at the point of use, not only at the point of saving: a
    // settings file is a text file, and somebody may have edited it.
    if !is_valid_target(&host.target) {
        return Err("that saved address is not usable".into());
    }
    crate::pty::spawn_program(
        app,
        cwd,
        cols,
        rows,
        // A remote session is the user's, never the model's: the terminal gate
        // that asks before a model writes into a session applies unchanged.
        "user".to_string(),
        Some(("ssh".to_string(), ssh_argv(&host))),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{is_valid_target, ssh_argv, SshHost};

    fn host(target: &str, port: Option<u16>) -> SshHost {
        SshHost { id: "h0".into(), label: "x".into(), target: target.into(), port }
    }

    #[test]
    fn the_shapes_people_actually_type_are_accepted() {
        for t in ["deploy@example.com", "example.com", "prod-1", "10.0.0.4", "user@10.0.0.4", "my_box"] {
            assert!(is_valid_target(t), "{t} should be usable");
        }
    }

    #[test]
    fn nothing_that_could_become_an_option_or_a_command() {
        // ssh takes options before its target, and a shell takes everything.
        // This is user-typed text on its way to a process.
        for t in [
            "-oProxyCommand=touch /tmp/pwned",
            "-l root",
            "host; rm -rf /",
            "host && whoami",
            "host $(whoami)",
            "host `id`",
            "a b",
            "user@@host",
            "@host",
            "user@",
            "",
        ] {
            assert!(!is_valid_target(t), "{t} must be refused");
        }
    }

    #[test]
    fn the_argv_ends_with_a_double_dash_before_the_target() {
        // So the target can never be read as a flag, even if the check above is
        // ever loosened by someone who did not read this file.
        let argv = ssh_argv(&host("deploy@example.com", None));
        let dashdash = argv.iter().position(|a| a == "--").expect("-- is present");
        assert_eq!(argv.last().unwrap(), "deploy@example.com");
        assert_eq!(dashdash, argv.len() - 2, "nothing between -- and the target");
    }

    #[test]
    fn a_port_is_passed_as_a_number_and_only_when_set() {
        let with = ssh_argv(&host("h", Some(2222)));
        assert!(with.windows(2).any(|w| w == ["-p", "2222"]));
        let without = ssh_argv(&host("h", None));
        assert!(!without.iter().any(|a| a == "-p"), "no port, no flag");
    }

    #[test]
    fn no_flag_ever_weakens_host_key_checking() {
        // An unknown host prompt is the one moment ssh protects the user from
        // talking to the wrong machine. It belongs in the terminal, answered by
        // a person, and nothing here may switch it off for convenience.
        let argv = ssh_argv(&host("deploy@example.com", Some(22)));
        let joined = argv.join(" ");
        assert!(!joined.contains("StrictHostKeyChecking"));
        assert!(!joined.contains("UserKnownHostsFile"));
        assert!(!joined.contains("-o"));
    }
}
