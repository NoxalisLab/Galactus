// CLI galactus : les workflows du depot sans les fichiers .command.
// Meme code que l'app (registre, planification, regimes moteur certifie).

use crate::*;
use serde_json::Value;
use std::io::Write as _;
use std::path::Path;
use std::process::Command;

fn ram_mode_from_args(args: &[String]) -> String {
    for w in args.windows(2) {
        if w[0] == "--ram" && matches!(w[1].as_str(), "eco" | "balanced" | "perf") {
            return w[1].clone();
        }
    }
    settings_load()
        .get("ram_mode")
        .cloned()
        .filter(|m| matches!(m.as_str(), "eco" | "balanced" | "perf"))
        .unwrap_or_else(|| "balanced".into())
}

fn print_models(root: &Path) -> Result<(), String> {
    let raw = std::fs::read_to_string(root.join("scripts/models-registry.json"))
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    println!("{:<20} {:>8} {:>10}  {}", "modele", "taille", "installe", "statut");
    for m in parsed["models"].as_array().cloned().unwrap_or_default() {
        let id = m["id"].as_str().unwrap_or("?");
        let (dir, pack, _) = model_paths(root, id);
        let installed = find_gguf(&dir).is_some() && pack.exists();
        println!(
            "{:<20} {:>7.0}G {:>10}  {}",
            id,
            m["gguf_bytes"].as_f64().unwrap_or(0.0) / 1e9,
            if installed { "oui" } else { "non" },
            m["status"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

fn serve(root: &Path, model_id: &str, args: &[String]) -> Result<(), String> {
    let entry = registry_entry(root, model_id)?;
    let (model_dir, pack, profile) = model_paths(root, model_id);
    let gguf = find_gguf(&model_dir).ok_or("GGUF introuvable : lance `galactus install` d'abord")?;
    if !pack.exists() {
        return Err("pack introuvable : lance `galactus install` d'abord".into());
    }
    let ram_mode = ram_mode_from_args(args);
    let ram_gb = hw_info().ram_gb.max(8);
    let (cache_bytes, fraction, ubatch) = plan_cache(&entry, ram_gb, None, &ram_mode)?;
    let cpu_moe = args.iter().any(|a| a == "--cpu-moe") || entry["cpu_moe"].as_bool().unwrap_or(false);
    let port: u16 = args
        .windows(2)
        .find(|w| w[0] == "--port")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(SERVER_PORT_BASE);

    let checkout = root.join("third_party/llama.cpp/build/bin/llama-server");
    let bin = if checkout.exists() { checkout } else { bundled_engine().ok_or("llama-server introuvable")? };

    let expert_total = entry["expert_bytes_total"].as_u64().unwrap_or(u64::MAX);
    let regime = if cpu_moe { "cpu-bit-exact" } else if cache_bytes >= expert_total { "resident-bit-exact" } else { "streamed-bit-exact" };
    println!("galactus serve {model_id}");
    println!("  regime  : {regime} (empreinte {ram_mode}, cache {:.1} Go, ubatch {ubatch})", cache_bytes as f64 / 1e9);
    println!("  endpoint: http://127.0.0.1:{port}/v1  (Ctrl+C pour arreter)\n");

    let mut cmd = Command::new(&bin);
    cmd.env("GALACTUS_H4", "1")
        .env("GALACTUS_PROFILE", &profile)
        .env("GALACTUS_H4_INTERNAL", &pack)
        .env("GALACTUS_H4_EXTERNAL", &pack)
        .env("GALACTUS_H4_CACHE_BYTES", cache_bytes.to_string())
        .env("GALACTUS_H4_PROTECTED", format!("{fraction:.2}"))
        .env("GALACTUS_H4_QD", "32")
        .env("LC_ALL", "C");
    if cpu_moe {
        cmd.env("GALACTUS_H4_CPU_MOE", "1").arg("--n-cpu-moe").arg("99");
    } else {
        cmd.env("GALACTUS_METAL_BITEXACT", "1");
    }
    let status = cmd
        .arg("--model").arg(&gguf)
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        .arg("--ctx-size").arg("8192")
        .arg("--n-gpu-layers").arg("99")
        .arg("--no-repack").arg("--fit").arg("off").arg("--no-mmap")
        .arg("--batch-size").arg("512")
        .arg("--ubatch-size").arg(ubatch.to_string())
        .arg("--parallel").arg("1")
        .arg("--jinja")
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("llama-server a quitte ({})", status.code().unwrap_or(-1)));
    }
    Ok(())
}

fn bench(args: &[String]) -> Result<(), String> {
    let port: u16 = args
        .windows(2)
        .find(|w| w[0] == "--port")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(SERVER_PORT_BASE);
    let body = r#"{"model":"galactus-local","messages":[{"role":"user","content":"Write a vivid two-paragraph description of a nebula."}],"temperature":0.7,"max_tokens":160,"stream":false}"#;
    println!("mesure sur http://127.0.0.1:{port} …");
    let out = Command::new("curl")
        .args(["-s", "-m", "300", "-H", "Content-Type: application/json", "-d", body])
        .arg(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .output()
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| "reponse illisible (serveur lance ?)".to_string())?;
    let tokens = v["usage"]["completion_tokens"].as_f64().unwrap_or(0.0);
    let tps = v["timings"]["predicted_per_second"].as_f64();
    match tps {
        Some(t) => println!("generation : {t:.1} tok/s ({tokens:.0} tokens, timings serveur)"),
        None => println!("{tokens:.0} tokens generes (pas de timings serveur)"),
    }
    Ok(())
}

fn status(root: &Path) {
    for offset in 0..SERVER_PORT_SPAN {
        let port = SERVER_PORT_BASE + offset;
        let ok = Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "1"])
            .arg(format!("http://127.0.0.1:{port}/health"))
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "200")
            .unwrap_or(false);
        if ok {
            println!("serveur actif : http://127.0.0.1:{port}/v1");
            return;
        }
    }
    let _ = root;
    println!("aucun serveur actif");
}

pub fn cli_main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    let rest = if args.len() > 1 { &args[1..] } else { &[] };

    let result: Result<(), String> = (|| {
        match cmd {
            "models" | "ls" => print_models(&galactus_root()?),
            "install" => {
                let id = rest.first().ok_or("usage : galactus install <modele>")?;
                let root = galactus_root()?;
                // Reutilise le pipeline de l'app avec un rendu de progression console.
                install_cli(&root, id)
            }
            "serve" | "run" => {
                let id = rest.first().ok_or("usage : galactus serve <modele> [--ram eco|balanced|perf] [--cpu-moe] [--port N]")?;
                serve(&galactus_root()?, id, rest)
            }
            "stop" => {
                let root = galactus_root()?;
                reap_orphan_servers(&root);
                println!("serveurs galactus arretes");
                Ok(())
            }
            "bench" => bench(rest),
            "status" => {
                status(&galactus_root()?);
                Ok(())
            }
            _ => {
                println!("galactus — moteur MoE local (Noxalis Lab)\n");
                println!("  galactus models                       liste des modeles certifies");
                println!("  galactus install <modele>             telecharge + profile + plan + pack");
                println!("  galactus serve <modele> [options]     sert le modele (API OpenAI locale)");
                println!("      --ram eco|balanced|perf           empreinte memoire (defaut : reglage app)");
                println!("      --cpu-moe                         experts CPU bit-exacts (contre-verification)");
                println!("      --port N                          port (defaut {SERVER_PORT_BASE})");
                println!("  galactus bench [--port N]             mesure la vitesse du serveur actif");
                println!("  galactus status                       serveur actif ?");
                println!("  galactus stop                         arrete les serveurs galactus");
                Ok(())
            }
        }
    })();

    if let Err(e) = result {
        eprintln!("erreur : {e}");
        std::process::exit(1);
    }
}

/// Pipeline d'installation avec progression console (meme logique que l'app).
fn install_cli(root: &Path, id: &str) -> Result<(), String> {
    let entry = registry_entry(root, id)?;
    let base = entry["download"]["base"].as_str().ok_or("pas d'URL de telechargement pour ce modele")?.to_string();
    let files: Vec<String> = entry["download"]["files"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return Err("pas de fichiers de telechargement pour ce modele".into());
    }
    for f in &files {
        if f.starts_with('/') || f.split('/').any(|c| c == "..") {
            return Err(format!("nom de fichier invalide dans le registre : {f}"));
        }
    }
    let total = entry["gguf_bytes"].as_u64().unwrap_or(0);
    let cancel = std::sync::atomic::AtomicBool::new(false);
    install_pipeline_with(root, id, &base, &files, total, &cancel, &|_phase, pct, label| {
        print!("\r  {pct:5.1}%  {label:<48}");
        let _ = std::io::stdout().flush();
    })?;
    println!("\ninstallation terminee : galactus serve {id}");
    Ok(())
}
