# Galactus — desktop assistant

A native macOS assistant (Tauri 2) for the Galactus MoE acceleration engine.
It runs certified open-source Mixture-of-Experts models fully on-device, at
useful speeds on machines that cannot hold them in RAM, and gives the model
gated access to your files and shell so it can actually get work done.

## What it does

- **Chat** with any installed model, streamed, with tool use.
- **Tools behind a permission gate**: read/write files, list folders, run shell
  commands. Every call raises a permission dialog — Allow once, Always allow
  (stores a standing rule), or Deny. Commands that can modify the system
  (`sudo`, `rm -rf`, `diskutil`, writes under `/System`, `/Library`, …) are
  flagged as *elevated* and require typing `ALLOW` to confirm; they are never
  granted a standing rule.
- **Model gallery**: the certified models from `scripts/models-registry.json`,
  each with the speed expected on *this* machine (interpolated from the
  measured benches), one-click download → profile → plan → pack install, and
  Start/Stop of the local server.
- **MCP connectors**: paste a `claude_desktop_config.json`-style `mcpServers`
  block in Settings; their tools appear to the model automatically.
- **Bilingual** (English / French), switchable in Settings.

## Requirements

This app is a front-end for an existing Galactus checkout. It needs:

- The Galactus repo folder (containing `scripts/models-registry.json`,
  `models/`, `artifacts/`, and a built `third_party/llama.cpp/build/bin/llama-server`).
  Set it in **Settings → Galactus folder**.
- `python3`, `curl`, `shasum` on PATH (stock macOS has all three).

## Develop

```bash
cd app
npm install
npm run tauri dev
```

## Build a .app / .dmg

```bash
cd app
npm run tauri build
```

The engine itself (the `GALACTUS_H4_*` wiring in `third_party/llama.cpp`) is
built separately; see the repository root.

Noxalis Lab.
