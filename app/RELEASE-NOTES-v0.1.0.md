# Galactus Desktop v0.1.0

First public build of the Galactus desktop assistant for macOS (Apple Silicon).
Designed and developed by Noxalis Lab.

A native Tauri 2 app for the Galactus MoE acceleration engine: run certified
open-weight Mixture-of-Experts models fully on-device, including models that do
not fit in RAM, and let them work on your files and shell behind a strict
permission gate.

## Highlights

- Chat with any installed model: streaming, tool use, live plan panel,
  Markdown rendering with code preview (HTML / SVG / Mermaid).
- Permission gate on every action (Allow once / Always / Deny), with a
  Cursor-style diff preview before any file write. System-modifying commands
  require typing `ALLOW` and never receive a standing rule.
- Model gallery with per-machine speed estimates interpolated from real
  benchmarks, and a one-click download, profile, plan and pack pipeline.
- MCP connectors, gated persistent memory, Obsidian vault tools, workspace
  skills, automatic task detection with model routing.
- Bilingual interface (Français / English), fonts bundled, fully offline.

## Hardening in this build

This build follows a full audit of the app (frontend TypeScript and Rust
backend): 34 confirmed defects fixed, including pipe deadlocks that froze
shell and document tools on outputs over 64 KB, orphaned llama-server
processes surviving app exit, a broken pptx/xlsx reader, a permission-gate
bypass for chained shell commands, conversation-store data loss windows, and
an ungated persistent-memory write. Details in the commit history.

## Requirements

- macOS on Apple Silicon.
- A Galactus checkout with a built engine (`third_party/llama.cpp` with the
  `GALACTUS_H4_*` patches). See the repository README.
- `python3`, `curl`, `shasum` (stock macOS).

## Install

Download `Galactus_0.1.0_aarch64.dmg`, drag Galactus to Applications, then
point the app at your Galactus folder on first launch. The build is not
notarized: on first open, right-click then Open, or run
`xattr -dr com.apple.quarantine /Applications/Galactus.app`.

## License

Apache License 2.0. If you use or redistribute this software, keep the NOTICE
file credit to Noxalis Lab (Apache 2.0, section 4).
