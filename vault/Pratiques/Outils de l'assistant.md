---
title: Outils de l'assistant
tags: [pratique, outils, référence]
description: La liste exacte des outils de l'agent, leurs limites chiffrées et lequel prendre quand.
---

# Outils de l'assistant

Référence courte. Nommer le bon outil dans ta demande évite un détour
([[Bien demander]]).

## Toujours disponibles

| Outil | Rôle | Limite |
|---|---|---|
| `update_plan` | publie la checklist visible dans le fil | mode agent |
| `read_file` | lit un fichier texte, `offset` et `max_bytes` | 200 000 octets par appel |
| `write_file` | crée ou remplace un fichier entier | diff montré avant |
| `list_directory` | liste un dossier | |
| `read_document` | PDF, image, Word, PowerPoint, Excel, RTF, HTML, avec OCR | voir [[Documents et OCR]] |
| `run_command` | shell zsh sur ce Mac | 120 s, sortie 200 Ko |
| `fetch_url` | récupère une page ou une API en http(s) | 200 000 octets |
| `remember` | enregistre un fait durable sur toi | à utiliser rarement |
| `use_skill` | charge les instructions d'une skill | voir [[Skills et invocation]] |
| `search_conversations`, `read_conversation` | cherche et relit tes fils passés | 24 000 caractères par lecture |

## Selon le contexte

| Outil | Apparaît quand | Note |
|---|---|---|
| `search_knowledge` | des dossiers sont indexés | [[Base de connaissances locale]] |
| `search_workspace`, `find_files` | un dossier de code est ouvert | [[Vue Code]] |
| `obsidian_search`, `obsidian_read`, `obsidian_append`, `obsidian_update` | un coffre est configuré | [[Coffre et Constellation]] |
| `spawn_agent`, `list_agents`, `ask_agent` | mode agent | [[Équipes de sous-agents]] |
| outils MCP | un connecteur est actif | [[Connecteurs MCP]] |

## Choisir vite

- Chercher du texte dans du code ouvert : `search_workspace`, pas `grep`.
- Chercher dans tes dossiers indexés : `search_knowledge`.
- Lire un PDF ou un scan : `read_document`, jamais `read_file`.
- Lire un CSV, un log, du code : `read_file`.
- Aller sur le web : `fetch_url`, ou `curl` via `run_command` quand il faut des
  en-têtes ou un pipeline.
- Calculer : `run_command` avec `python3`. Le Python 3.12 embarqué est en tête
  du PATH, il existe même sur un Mac sans Command Line Tools.

## Ce qui n'existe pas

Pas d'envoi d'email, pas de navigateur piloté, pas d'accès à ton calendrier ni à
tes messages sans passer par un connecteur MCP ou une commande AppleScript que
tu valides ([[Skill automatisation-mac]]).

## Suite

[[Bien demander]] · [[Fenêtre de contexte]] · [[Niveaux d'autonomie]] ·
[[Skills et invocation]] · [[Vue Code]]
