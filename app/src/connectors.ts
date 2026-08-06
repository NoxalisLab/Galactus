// Friendly MCP connector catalog. The user toggles connectors and fills a
// field or two; we compile everything to the mcpServers config the Rust side
// expects. Raw JSON is never shown.
import { api } from "./api";

export interface ConnectorField {
  key: string;
  label: { en: string; fr: string };
  placeholder?: string;
  kind: "text" | "folder" | "secret";
  target: "arg" | "env"; // substituted into args, or set as an env var
  envName?: string; // when target === "env"
}

export interface ConnectorPreset {
  id: string;
  name: string;
  desc: { en: string; fr: string };
  icon: string; // emoji glyph, kept minimal
  command: string;
  // args with {field} placeholders substituted from values
  args: string[];
  fields: ConnectorField[];
  note?: { en: string; fr: string };
}

export const CATALOG: ConnectorPreset[] = [
  {
    id: "filesystem",
    name: "Files",
    desc: { en: "Give the assistant a folder to work in", fr: "Donne un dossier de travail à l'assistant" },
    icon: "📁",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{path}"],
    fields: [
      { key: "path", label: { en: "Folder", fr: "Dossier" }, kind: "folder", target: "arg" },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    desc: { en: "Repos, issues and pull requests", fr: "Dépôts, issues et pull requests" },
    icon: "🐙",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    fields: [
      {
        key: "token",
        label: { en: "Personal access token", fr: "Token d'accès personnel" },
        kind: "secret",
        target: "env",
        envName: "GITHUB_PERSONAL_ACCESS_TOKEN",
        placeholder: "ghp_…",
      },
    ],
  },
  {
    id: "fetch",
    name: "Web",
    desc: { en: "Fetch and read web pages", fr: "Récupérer et lire des pages web" },
    icon: "🌐",
    command: "uvx",
    args: ["mcp-server-fetch"],
    fields: [],
    note: { en: "Requires uv (uvx) installed.", fr: "Nécessite uv (uvx) installé." },
  },
  {
    id: "sequential",
    name: "Deep reasoning",
    desc: { en: "Structured step-by-step thinking", fr: "Raisonnement structuré étape par étape" },
    icon: "🧠",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    fields: [],
  },
  {
    id: "memorygraph",
    name: "Knowledge graph",
    desc: { en: "A persistent knowledge graph memory", fr: "Une mémoire en graphe de connaissances" },
    icon: "🕸️",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    fields: [],
  },
];

export interface EnabledConnector {
  id: string; // preset id, or "custom:<name>"
  values: Record<string, string>;
  // For fully custom entries:
  custom?: { name: string; command: string; args: string[] };
}

export async function loadEnabled(): Promise<EnabledConnector[]> {
  const s = await api.settingsGet();
  try {
    const parsed = JSON.parse(s["connectors"] ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveEnabled(list: EnabledConnector[]): Promise<number> {
  await api.settingsSet("connectors", JSON.stringify(list));
  return compileAndReload(list);
}

// Build the mcpServers object and hand it to the Rust reloader.
export async function compileAndReload(list: EnabledConnector[]): Promise<number> {
  const servers: Record<string, any> = {};
  // Two connectors may share a name (two filesystem folders, a custom entry
  // named like a preset): suffix instead of silently overwriting.
  const uniqueKey = (base: string): string => {
    let k = base || "server";
    let n = 2;
    while (k in servers) k = `${base}-${n++}`;
    return k;
  };
  for (const c of list) {
    if (c.custom) {
      servers[uniqueKey(c.custom.name)] = { command: c.custom.command, args: c.custom.args };
      continue;
    }
    const preset = CATALOG.find((p) => p.id === c.id);
    if (!preset) continue;
    const args = preset.args.map((a) => {
      const m = a.match(/^\{(\w+)\}$/);
      return m ? c.values[m[1]] ?? "" : a;
    });
    const env: Record<string, string> = {};
    for (const f of preset.fields) {
      if (f.target === "env" && f.envName) env[f.envName] = c.values[f.key] ?? "";
    }
    servers[uniqueKey(preset.id)] = { command: preset.command, args, env };
  }
  const config = JSON.stringify({ mcpServers: servers }, null, 2);
  await api.settingsSet("mcp", config);
  const tools = await api.mcpReload();
  return tools.length;
}
