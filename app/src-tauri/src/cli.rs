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
        let (dir, _pack, _) = model_paths(root, id);
        // Meme regle que l'app : les packs resolus (registre, settings, mono)
        // doivent exister — le GLM double-pack compte comme installe.
        let installed = find_gguf(&dir).is_some()
            && resolve_packs(root, id, &m)
                .map(|(i, e)| i.is_file() && e.is_file())
                .unwrap_or(false);
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
    require_certified_model(&entry)?;
    require_compatible_hardware(&entry, hw_info_impl().ram_gb)?;
    let (model_dir, _pack, profile) = model_paths(root, model_id);
    let gguf = find_gguf(&model_dir).ok_or("GGUF introuvable : lance `galactus install` d'abord")?;
    // Double pack : deux chemins distincts font lire les deux SSD en
    // parallele (decoupe P0v2) ; identiques = pack mono-volume.
    let (pack_internal, pack_external) = resolve_packs(root, model_id, &entry)?;
    if !pack_internal.is_file() || !pack_external.is_file() {
        return Err("pack introuvable : lance `galactus install` d'abord".into());
    }
    let ram_mode = ram_mode_from_args(args);
    let ram_gb = hw_info_impl().ram_gb.max(8);
    // Same opt-in surface as the app: flag, registry entry, or the shared
    // setting — otherwise `galactus serve` would silently contradict the
    // regime the user picked in the app. Resolved before planning, since the
    // cross-check regime keeps a small micro-batch.
    let cpu_moe = args.iter().any(|a| a == "--cpu-moe")
        || entry["cpu_moe"].as_bool().unwrap_or(false)
        || settings_load().get("cpu_moe").map(|v| v == "1").unwrap_or(false);
    let (cache_bytes, fraction, ubatch) = plan_cache(&entry, ram_gb, None, &ram_mode, cpu_moe)?;
    let port: u16 = args
        .windows(2)
        .find(|w| w[0] == "--port")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(SERVER_PORT_BASE);

    let checkout = root.join("third_party/llama.cpp/build/bin/llama-server");
    let bin = if checkout.exists() { checkout } else { bundled_engine().ok_or("llama-server introuvable")? };
    // Un binaire llama.cpp d'origine accepte tous les drapeaux et ignore les
    // variables GALACTUS_H4_* : il servirait le modele en natif. Verifier le
    // cablage avant de lancer quoi que ce soit.
    engine_is_wired(&bin)?;

    // Memes creneaux que l'app : --parallel N avec une fenetre CTX_PER_SLOT
    // par creneau, pilote par le reglage partage "engine_slots". Un `serve` en
    // ligne de commande qui offrirait une concurrence differente de celle de
    // l'app mesurerait autre chose que ce que l'utilisateur execute.
    let slots = args
        .windows(2)
        .find(|w| w[0] == "--slots")
        .and_then(|w| w[1].parse::<u32>().ok())
        .map(|n| n.clamp(1, MAX_SLOTS))
        .unwrap_or_else(engine_slots);
    let ctx_total = CTX_PER_SLOT * slots;
    let expert_total = entry["expert_bytes_total"].as_u64().unwrap_or(u64::MAX);
    let regime = if cpu_moe { "cpu-bit-exact" } else if cache_bytes >= expert_total { "resident-bit-exact" } else { "streamed-bit-exact" };
    let dual = pack_internal != pack_external;
    println!("galactus serve {model_id}");
    println!("  regime  : {regime} (empreinte {ram_mode}, cache {:.1} Go, ubatch {ubatch})", cache_bytes as f64 / 1e9);
    println!("  creneaux: {slots} (fenetre {CTX_PER_SLOT} par creneau, contexte total {ctx_total})");
    println!("  packs   : {}", if dual { "double (deux SSD en parallele)" } else { "mono-volume" });
    println!("    interne : {}", pack_internal.display());
    println!("    externe : {}", pack_external.display());
    println!("  endpoint: http://127.0.0.1:{port}/v1  (Ctrl+C pour arreter)\n");

    let mut cmd = Command::new(&bin);
    cmd.env("GALACTUS_H4", "1")
        .env("GALACTUS_H4_INTERNAL", &pack_internal)
        .env("GALACTUS_H4_EXTERNAL", &pack_external)
        .env("GALACTUS_H4_CACHE_BYTES", cache_bytes.to_string())
        .env("GALACTUS_H4_PROTECTED", format!("{fraction:.2}"))
        .env("GALACTUS_H4_QD", "32")
        .env("LC_ALL", "C");
    // Sans GALACTUS_PROFILE le moteur prend sa geometrie GLM-5.2 integree :
    // juste pour GLM-5.2, faux pour tout autre modele. Des que l'installation
    // a produit un profil, le fichier devient obligatoire.
    if profile.is_file() {
        cmd.env("GALACTUS_PROFILE", &profile);
    } else if model_dir.join("profile.json").is_file() {
        return Err(format!(
            "profil moteur absent : {} (regenere-le avec scripts/moe-profile.py)",
            profile.display()
        ));
    }
    if cpu_moe {
        cmd.env("GALACTUS_H4_CPU_MOE", "1").arg("--n-cpu-moe").arg("99");
    } else {
        cmd.env("GALACTUS_METAL_BITEXACT", "1");
    }
    let status = cmd
        .arg("--model").arg(&gguf)
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        .arg("--ctx-size").arg(ctx_total.to_string())
        .arg("--n-gpu-layers").arg("99")
        .arg("--no-repack").arg("--fit").arg("off").arg("--no-mmap")
        .arg("--batch-size").arg("512")
        .arg("--ubatch-size").arg(ubatch.to_string())
        .arg("--parallel").arg(slots.to_string())
        .arg("--jinja")
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("llama-server a quitte ({})", status.code().unwrap_or(-1)));
    }
    Ok(())
}

/// Miroir CLI de la recherche d'historique que le modele utilise
/// (search_conversations / read_conversation). Meme code exactement : ce que
/// la commande imprime est ce que l'agent recoit.
fn history(args: &[String]) -> Result<(), String> {
    match args.first().map(|s| s.as_str()) {
        Some("read") => {
            let id = args.get(1).ok_or("usage : galactus history read <id> [--max N]")?;
            let cap = args
                .windows(2)
                .find(|w| w[0] == "--max")
                .and_then(|w| w[1].parse::<usize>().ok());
            println!("{}", conv_read(id.clone(), cap)?);
            Ok(())
        }
        Some("search") | None => {
            let terms: Vec<String> = args
                .iter()
                .skip(if args.first().map(|s| s == "search").unwrap_or(false) { 1 } else { 0 })
                .filter(|a| !a.starts_with("--"))
                .cloned()
                .collect();
            if terms.is_empty() {
                return Err("usage : galactus history search <termes> [-k N]".into());
            }
            let k = args
                .windows(2)
                .find(|w| w[0] == "-k")
                .and_then(|w| w[1].parse::<usize>().ok());
            let hits = conv_search(terms.join(" "), k);
            if hits.is_empty() {
                println!("aucune correspondance dans les discussions enregistrees");
            }
            println!("{}", serde_json::to_string_pretty(&hits).unwrap_or_default());
            Ok(())
        }
        Some(other) => Err(format!("sous-commande inconnue : history {other}")),
    }
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
                let id = rest.first().ok_or("usage : galactus serve <modele> [--ram eco|balanced|perf] [--cpu-moe] [--slots N] [--port N]")?;
                serve(&galactus_root()?, id, rest)
            }
            "remove" | "rm" => {
                let id = rest.first().ok_or("usage : galactus remove <modele>")?;
                remove_cli(id)
            }
            "stop" => {
                let root = galactus_root()?;
                reap_orphan_servers(&root);
                println!("serveurs galactus arretes");
                Ok(())
            }
            "bench" => bench(rest),
            "history" => history(rest),
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
                println!("      --slots N                         creneaux de decodage 1..{MAX_SLOTS} (defaut : reglage app)");
                println!("      --port N                          port (defaut {SERVER_PORT_BASE})");
                println!("  galactus bench [--port N]             mesure la vitesse du serveur actif");
                println!("  galactus remove <modele>              supprime le modele (confirmation par le nom)");
                println!("  galactus history search <termes>      cherche dans les discussions enregistrees");
                println!("  galactus history read <id>            lit une discussion enregistree");
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
    require_certified_model(&entry)?;
    require_compatible_hardware(&entry, hw_info_impl().ram_gb)?;
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
    require_download_space(root, id, &files, total)?;
    let cancel = std::sync::atomic::AtomicBool::new(false);
    install_pipeline_with(root, id, &base, &files, total, None, &cancel, &|_phase, pct, label| {
        print!("\r  {pct:5.1}%  {label:<48}");
        let _ = std::io::stdout().flush();
    })?;
    println!("\ninstallation terminee : galactus serve {id}");
    Ok(())
}

/// Suppression d'un modele : confirmation par saisie du nom exact, puis le
/// meme chemin que l'app (delete_model). Les packs hors depot sont epargnes.
fn remove_cli(id: &str) -> Result<(), String> {
    let root = galactus_root()?;
    let _ = registry_entry(&root, id)?; // erreur claire si le modele n'existe pas
    print!("supprimer {id} ? Tape le nom exact du modele pour confirmer : ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.trim() != id {
        return Err("confirmation refusee (nom different), rien n'a ete supprime".into());
    }
    let summary = delete_model_impl(id)?;
    println!("{summary}");
    Ok(())
}
