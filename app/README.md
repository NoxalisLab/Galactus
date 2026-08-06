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

The app is self-contained: the Galactus llama-server (with its dylibs and
OpenSSL, fully relocated), an isolated Python 3.12 runtime, the precompiled
document helper (PDF text + OCR), the model registry, the install scripts
and the curated skills all ship inside the bundle. Without any checkout,
data lives in `~/Library/Application Support/Galactus/data`.

No Command Line Tools, no Homebrew, no system Python required: the only
external tools used are the ones every macOS ships (`curl`, `shasum`,
`zsh`, `textutil`, `osascript`).

Developers can still point **Settings → Galactus folder** at a checkout: a
`third_party/llama.cpp/build/bin/llama-server` built there takes precedence
over the bundled engine.

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
