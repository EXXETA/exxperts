/**
 * Knowledge-base / second-brain tools for exxperts.
 *
 * Target: folder-based Markdown vaults, especially Obsidian-style vaults.
 * Reads are direct and source-cited. Writes are approval-gated and scoped to
 * configured vault roots.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

interface Vault {
	name: string;
	root: string;
	description?: string;
	source?: "config" | "env" | "auto";
}

// No auto-connect — vaults come only from ~/.exxperts/app/kb-vaults.json and EXXETA_KB_VAULTS env var.
const MAX_READ_BYTES = 180_000;
const IGNORE_DIRS = new Set([".git", ".obsidian", "node_modules", ".DS_Store", "dist", "build", "coverage"]);
const INDEX_FILE = "KB-INDEX.md";
const VAULT_CONFIG_FILE = productAppStatePath("kb-vaults.json");

function expandHome(p: string) {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function slugName(s: string) {
	return s.toLowerCase().replace(/^@[^/]+\//, "").replace(/-app$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}



function normalizeVault(v: Vault, source?: Vault["source"]): Vault {
	return {
		name: slugName(v.name),
		root: path.resolve(expandHome(v.root)),
		description: v.description ? String(v.description) : undefined,
		source: source ?? v.source,
	};
}

function loadVaultConfig(): Vault[] {
	if (!fs.existsSync(VAULT_CONFIG_FILE)) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(VAULT_CONFIG_FILE, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((v) => v?.name && v?.root)
			.map((v) => normalizeVault({ name: String(v.name), root: String(v.root), description: v.description ? String(v.description) : undefined }, "config"));
	} catch {
		return [];
	}
}

function saveVaultConfig(vaults: Vault[]) {
	const normalized = vaults.map((v) => normalizeVault(v)).map(({ name, root, description }) => ({ name, root, ...(description ? { description } : {}) }));
	fs.mkdirSync(path.dirname(VAULT_CONFIG_FILE), { recursive: true, mode: 0o700 });
	fs.writeFileSync(VAULT_CONFIG_FILE, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
}

function parseEnvVaults(raw: string): Vault[] {
	const out: Vault[] = [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const v of parsed) {
				if (v?.name && v?.root) out.push(normalizeVault({ name: String(v.name), root: String(v.root), description: v.description ? String(v.description) : undefined }, "env"));
			}
		} else if (typeof parsed === "object" && parsed) {
			for (const [name, root] of Object.entries(parsed)) out.push(normalizeVault({ name, root: String(root) }, "env"));
		}
	} catch {
		for (const part of raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
			const [name, ...rest] = part.split("=");
			const root = rest.join("=");
			if (name && root) out.push(normalizeVault({ name: name.trim(), root: root.trim() }, "env"));
		}
	}
	return out;
}



function parseVaults(): Vault[] {
	const out: Vault[] = [...loadVaultConfig()];
	const raw = process.env.EXXETA_KB_VAULTS?.trim();
	if (raw) out.push(...parseEnvVaults(raw));

	// No auto-connect. Users add vaults explicitly via kb_connect or EXXETA_KB_VAULTS.

	const byRoot = new Map<string, Vault>();
	for (const v of out) {
		const root = path.resolve(v.root);
		try {
			if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
		} catch {
			continue;
		}
		byRoot.set(root, { ...v, root });
	}
	return Array.from(byRoot.values());
}

function vaultByName(name?: string): Vault | null {
	const vaults = parseVaults();
	if (!name && vaults.length === 1) return vaults[0];
	if (!name) return vaults[0] ?? null;
	return vaults.find((v) => v.name === name) ?? null;
}

function safeResolve(vault: Vault, rel = ".") {
	const cleaned = rel.replace(/^\/+/, "");
	const full = path.resolve(vault.root, cleaned);
	const root = path.resolve(vault.root);
	if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path escapes vault root: ${rel}`);
	return full;
}

function relPath(vault: Vault, full: string) {
	return path.relative(vault.root, full) || ".";
}

function hasIndex(vault: Vault) {
	return fs.existsSync(path.join(vault.root, INDEX_FILE));
}

function isTextNote(file: string) {
	return /\.(md|markdown|txt)$/i.test(file);
}

function walk(vault: Vault, startRel = ".", limit = 500): string[] {
	const start = safeResolve(vault, startRel);
	const out: string[] = [];
	const visit = (dir: string) => {
		if (out.length >= limit) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (out.length >= limit) break;
			if (IGNORE_DIRS.has(e.name)) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) visit(full);
			else if (e.isFile() && isTextNote(e.name)) out.push(relPath(vault, full));
		}
	};
	if (fs.existsSync(start) && fs.statSync(start).isDirectory()) visit(start);
	else if (fs.existsSync(start) && fs.statSync(start).isFile()) out.push(relPath(vault, start));
	return out;
}

function listTree(vault: Vault, limit = 1000) {
	const dirs = new Set<string>();
	const files: string[] = [];
	const visit = (dir: string) => {
		if (files.length >= limit) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (files.length >= limit) break;
			if (IGNORE_DIRS.has(e.name)) continue;
			const full = path.join(dir, e.name);
			const rel = relPath(vault, full);
			if (e.isDirectory()) {
				dirs.add(rel);
				visit(full);
			} else if (e.isFile() && isTextNote(e.name) && e.name !== INDEX_FILE) {
				files.push(rel);
			}
		}
	};
	visit(vault.root);
	return { dirs: Array.from(dirs).sort(), files };
}

function readNote(vault: Vault, notePath: string) {
	const full = safeResolve(vault, notePath);
	if (!fs.existsSync(full)) throw new Error(`Not found: ${notePath}`);
	if (!fs.statSync(full).isFile()) throw new Error(`Not a file: ${notePath}`);
	const buf = fs.readFileSync(full);
	const truncated = buf.byteLength > MAX_READ_BYTES;
	return { text: buf.subarray(0, MAX_READ_BYTES).toString("utf-8"), truncated };
}

function notePreview(vault: Vault, notePath: string) {
	try {
		const text = readNote(vault, notePath).text;
		const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
		const title = lines.find((l) => l.startsWith("# "))?.replace(/^#\s+/, "") ?? path.basename(notePath);
		const paragraph = lines.find((l) => !l.startsWith("#") && !l.startsWith("---")) ?? "Add a short description.";
		return { title, description: paragraph.slice(0, 180) };
	} catch {
		return { title: path.basename(notePath), description: "Add a short description." };
	}
}

function titleSlug(s: string) {
	return s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 70) || "capture";
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

async function approve(ctx: any, title: string, detail: string) {
	if (!ctx.hasUI) return false;
	return await ctx.ui.confirm(title, detail);
}

async function approvalWrite(ctx: any, vault: Vault, notePath: string, content: string, reason: string) {
	const exists = fs.existsSync(safeResolve(vault, notePath));
	const ok = await approve(ctx, exists ? "Replace knowledge-base note?" : "Create knowledge-base note?", `Knowledge base: ${vault.name}\nFile: ${notePath}\nReason: ${reason}\n\nContent:\n${content.slice(0, 3000)}`);
	if (!ok) return { content: [{ type: "text" as const, text: "KB write not applied; user approval missing or declined." }], details: { saved: false } };
	const full = safeResolve(vault, notePath);
	fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
	fs.writeFileSync(full, content.trim() + "\n", { mode: 0o600 });
	ctx.ui.notify(`${exists ? "Replaced" : "Created"} KB note: ${vault.name}/${notePath}`, "info");
	return { content: [{ type: "text" as const, text: `${exists ? "Replaced" : "Created"} ${vault.name}/${notePath}` }], details: { saved: true, vault: vault.name, path: notePath, replaced: exists } };
}

function generateIndexDraft(vault: Vault) {
	const { dirs, files } = listTree(vault, 1200);
	const bySection = new Map<string, string[]>();
	for (const file of files) {
		const section = path.posix.dirname(file.split(path.sep).join(path.posix.sep));
		const key = section === "." ? "root" : `${section}/`;
		if (!bySection.has(key)) bySection.set(key, []);
		bySection.get(key)!.push(file.split(path.sep).join(path.posix.sep));
	}

	const lines = [`# ${vault.name} Knowledge Base`, "", "Generated draft. Edit descriptions over time as the vault evolves.", ""];
	if (!files.length && !dirs.length) {
		lines.push("No Markdown notes found yet.", "");
		return lines.join("\n");
	}

	for (const [section, sectionFiles] of Array.from(bySection.entries()).sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`## ${section}`);
		lines.push(section === "root" ? "Top-level notes and entry points." : `Notes under ${section}`);
		for (const file of sectionFiles.slice(0, 40)) {
			const preview = notePreview(vault, file);
			lines.push(`- ${path.posix.basename(file)} — ${preview.description}`);
		}
		if (sectionFiles.length > 40) lines.push(`- … ${sectionFiles.length - 40} more notes`);
		lines.push("");
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "kb_vaults",
		label: "Knowledge bases",
		description: "List the configured Markdown knowledge-base folders available to this agent.",
		parameters: Type.Object({}),
		async execute() {
			const vaults = parseVaults();
			const rows = vaults.map((v) => ({ ...v, hasIndex: hasIndex(v) }));
			return {
				content: [{ type: "text", text: rows.length ? rows.map((v) => `- ${v.name}: ${v.root}${v.description ? ` — ${v.description}` : ""} — knowledge index (${INDEX_FILE}): ${v.hasIndex ? "yes" : "no"}${v.source ? ` — source: ${v.source}` : ""}`).join("\n") : "No knowledge-base folders configured." }],
				details: { vaults: rows, configFile: VAULT_CONFIG_FILE },
			};
		},
	});

	pi.registerTool({
		name: "kb_connect",
		label: "Connect knowledge base",
		description: "Add a Markdown knowledge-base folder to the persistent ~/.exxperts/app/kb-vaults.json config. Requires user approval before writing.",
		parameters: Type.Object({
			path: Type.String({ description: "Folder path to connect as a knowledge base." }),
			name: Type.Optional(Type.String({ description: "Knowledge-base name. Defaults to a slug from the folder name." })),
			description: Type.Optional(Type.String({ description: "Short human description for the knowledge-base folder." })),
		}),
		async execute(_id, { path: inputPath, name, description }, _signal, _onUpdate, ctx) {
			try {
				const root = path.resolve(expandHome(String(inputPath)));
				if (!fs.existsSync(root)) throw new Error(`Path does not exist: ${root}`);
				if (!fs.statSync(root).isDirectory()) throw new Error(`Path is not a directory: ${root}`);
				const vaultName = slugName(name ? String(name) : path.basename(root));
				const config = loadVaultConfig();
				const existingSameName = config.find((v) => v.name === vaultName && path.resolve(v.root) !== root);
				if (existingSameName) throw new Error(`A configured knowledge base named "${vaultName}" already points to ${existingSameName.root}. Choose another name.`);
				const nextVault: Vault = { name: vaultName, root, description: description ? String(description) : undefined };
				const existingIndex = config.findIndex((v) => path.resolve(v.root) === root);
				const next = existingIndex >= 0 ? config.map((v, i) => i === existingIndex ? nextVault : v) : [...config, nextVault];
				const ok = await approve(ctx, existingIndex >= 0 ? "Update knowledge-base connection?" : "Connect knowledge-base folder?", `Config: ${VAULT_CONFIG_FILE}\nName: ${vaultName}\nPath: ${root}${description ? `\nDescription: ${description}` : ""}`);
				if (!ok) return { content: [{ type: "text", text: "Knowledge-base folder not connected; user approval missing or declined." }], details: { saved: false } };
				saveVaultConfig(next);
				ctx.ui.notify(`Connected knowledge base: ${vaultName}`, "info");
				return { content: [{ type: "text", text: `Connected knowledge-base folder "${vaultName}" at ${root}.` }], details: { saved: true, vault: { ...nextVault, source: "config", hasIndex: hasIndex(nextVault) }, configFile: VAULT_CONFIG_FILE } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "kb_disconnect",
		label: "Disconnect knowledge base",
		description: "Remove a Markdown knowledge-base folder from the persistent ~/.exxperts/app/kb-vaults.json config. Requires user approval before writing.",
		parameters: Type.Object({
			name: Type.String({ description: "Configured knowledge-base name to remove." }),
		}),
		async execute(_id, { name }, _signal, _onUpdate, ctx) {
			try {
				const vaultName = String(name).trim();
				const config = loadVaultConfig();
				const existing = config.find((v) => v.name === vaultName);
				if (!existing) {
					const runtimeVault = parseVaults().find((v) => v.name === vaultName);
					if (!runtimeVault) throw new Error(`No knowledge base named "${vaultName}" found in the persistent config.`);
					throw new Error(`No persistent knowledge base named "${vaultName}" in ${VAULT_CONFIG_FILE}.`);
				}
				const ok = await approve(ctx, "Disconnect knowledge-base folder?", `Config: ${VAULT_CONFIG_FILE}\nName: ${existing.name}\nPath: ${existing.root}`);
				if (!ok) return { content: [{ type: "text", text: "Knowledge-base folder not disconnected; user approval missing or declined." }], details: { saved: false } };
				const next = config.filter((v) => v.name !== vaultName);
				saveVaultConfig(next);
				ctx.ui.notify(`Disconnected knowledge base: ${vaultName}`, "info");
				return { content: [{ type: "text", text: `Disconnected knowledge-base folder "${vaultName}".` }], details: { saved: true, vault: existing, configFile: VAULT_CONFIG_FILE } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "kb_index",
		label: "KB index",
		description: "Read a knowledge-base folder's KB-INDEX.md knowledge index before searching so the agent can navigate targeted files.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String({ description: "Knowledge-base name. Omit to use default." })),
		}),
		async execute(_id, { vault: vaultName }) {
			try {
				const vault = vaultByName(vaultName);
				if (!vault) throw new Error("No matching knowledge-base folder.");
				const full = safeResolve(vault, INDEX_FILE);
				if (!fs.existsSync(full)) return { content: [{ type: "text", text: `Knowledge-base folder ${vault.name} has no knowledge index (${INDEX_FILE}) yet. Ask the user whether to generate a draft with kb_index_generate.` }], details: { vault: vault.name, path: INDEX_FILE, exists: false, truncated: false } };
				const r = readNote(vault, INDEX_FILE);
				return { content: [{ type: "text", text: r.text + (r.truncated ? "\n\n[truncated]" : "") }], details: { vault: vault.name, path: INDEX_FILE, exists: true, truncated: r.truncated } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "kb_index_generate",
		label: "KB index generate",
		description: "Generate a draft knowledge index (KB-INDEX.md) for a knowledge-base folder from folder/file names and first note lines. Requires user approval before writing.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String({ description: "Knowledge-base name. Omit to use default." })),
		}),
		async execute(_id, { vault: vaultName }, _signal, _onUpdate, ctx) {
			try {
				const vault = vaultByName(vaultName);
				if (!vault) throw new Error("No matching knowledge-base folder.");
				const draft = generateIndexDraft(vault);
				return await approvalWrite(ctx, vault, INDEX_FILE, draft, "Generate a draft knowledge index for targeted navigation.");
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "kb_list",
		label: "KB list",
		description: "List Markdown notes under a knowledge-base folder path. Ignores .obsidian, .git, node_modules, dist, build, and coverage.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String({ description: "Knowledge-base name. Omit to use default." })),
			path: Type.Optional(Type.String({ description: "Folder or file path inside the knowledge base. Default: root." })),
			limit: Type.Optional(Type.Number({ description: "Maximum notes to list. Default 200." })),
		}),
		async execute(_id, { vault: vaultName, path: p = ".", limit = 200 }) {
			const vault = vaultByName(vaultName);
			if (!vault) return { content: [{ type: "text", text: "No matching knowledge-base folder." }], details: undefined, isError: true };
			const notes = walk(vault, p, Math.min(limit, 1000));
			return { content: [{ type: "text", text: notes.length ? notes.map((n) => `- ${n}`).join("\n") : `No notes under ${p}.` }], details: { vault: vault.name, root: vault.root, notes } };
		},
	});

	pi.registerTool({
		name: "kb_read",
		label: "KB read",
		description: "Read one Markdown note from a configured knowledge-base folder. Use this for source-backed answers and cite the note path.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String()),
			path: Type.String({ description: "Note path inside the knowledge base." }),
		}),
		async execute(_id, { vault: vaultName, path: notePath }) {
			try {
				const vault = vaultByName(vaultName);
				if (!vault) throw new Error("No matching knowledge-base folder.");
				const r = readNote(vault, notePath);
				return { content: [{ type: "text", text: r.text + (r.truncated ? "\n\n[truncated]" : "") }], details: { vault: vault.name, path: notePath, truncated: r.truncated } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "kb_search",
		label: "KB search",
		description: "Search Markdown notes by case-insensitive substring. Prefer kb_index first, then targeted reads/searches in the relevant section.",
		parameters: Type.Object({
			query: Type.String(),
			vault: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, { query, vault: vaultName, path: p = ".", limit = 20 }) {
			const vault = vaultByName(vaultName);
			if (!vault) return { content: [{ type: "text", text: "No matching knowledge-base folder." }], details: undefined, isError: true };
			const q = query.toLowerCase();
			const matches: { path: string; line: number; snippet: string }[] = [];
			for (const note of walk(vault, p, 2000)) {
				if (matches.length >= limit) break;
				let text = "";
				try { text = readNote(vault, note).text; } catch { continue; }
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].toLowerCase().includes(q)) {
						matches.push({ path: note, line: i + 1, snippet: lines[i].trim().slice(0, 240) });
						break;
					}
				}
			}
			const text = matches.length ? matches.map((m) => `- ${m.path}:${m.line} — ${m.snippet}`).join("\n") : `No matches for "${query}".`;
			return { content: [{ type: "text", text }], details: { vault: vault.name, query, matches } };
		},
	});

	pi.registerTool({
		name: "kb_capture_raw",
		label: "Capture knowledge-base note",
		description: "Save a raw thought/capture into 99-Inbox of a Markdown knowledge-base folder. Requires user approval. Use before weaving transformed/summarized ideas.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String()),
			title: Type.String({ description: "Short human title for the capture." }),
			content: Type.String({ description: "Raw user thought or transcript to preserve." }),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, { vault: vaultName, title, content, tags }, _signal, _onUpdate, ctx) {
			const vault = vaultByName(vaultName);
			if (!vault) return { content: [{ type: "text", text: "No matching knowledge-base folder." }], details: undefined, isError: true };
			const rel = path.posix.join("99-Inbox", `${today()}-${titleSlug(title)}.md`);
			const body = [`# ${title}`, "", `Captured: ${new Date().toISOString()}`, tags?.length ? `Tags: ${tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ")}` : "", "", "## Raw capture", "", content.trim(), ""].filter((x) => x !== "").join("\n");
			const ok = await approve(ctx, "Save raw knowledge-base capture?", `Knowledge base: ${vault.name}\nFile: ${rel}\n\n${body.slice(0, 2000)}`);
			if (!ok) return { content: [{ type: "text", text: "Knowledge-base capture not saved; user approval missing or declined." }], details: { saved: false } };
			const full = safeResolve(vault, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
			fs.writeFileSync(full, body, { mode: 0o600 });
			ctx.ui.notify(`Saved KB capture: ${vault.name}/${rel}`, "info");
			return { content: [{ type: "text", text: `Saved raw capture to ${vault.name}/${rel}` }], details: { saved: true, vault: vault.name, path: rel } };
		},
	});

	pi.registerTool({
		name: "kb_append",
		label: "Append knowledge-base note",
		description: "Append content to an existing or new Markdown note in a knowledge-base folder. Requires user approval. Prefer for weaving decisions/open questions into existing notes.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String()),
			path: Type.String({ description: "Target note path inside the knowledge base." }),
			content: Type.String({ description: "Markdown content to append." }),
			reason: Type.String({ description: "Why this update belongs here." }),
		}),
		async execute(_id, { vault: vaultName, path: notePath, content, reason }, _signal, _onUpdate, ctx) {
			try {
				const vault = vaultByName(vaultName);
				if (!vault) throw new Error("No matching knowledge-base folder.");
				const ok = await approve(ctx, "Append to knowledge-base note?", `Knowledge base: ${vault.name}\nFile: ${notePath}\nReason: ${reason}\n\nAppend:\n${content.slice(0, 3000)}`);
				if (!ok) return { content: [{ type: "text", text: "Knowledge-base append not applied; user approval missing or declined." }], details: { saved: false } };
				const full = safeResolve(vault, notePath);
				fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
				fs.appendFileSync(full, `${fs.existsSync(full) ? "\n\n" : ""}${content.trim()}\n`, { mode: 0o600 });
				ctx.ui.notify(`Updated KB note: ${vault.name}/${notePath}`, "info");
				return { content: [{ type: "text", text: `Appended to ${vault.name}/${notePath}` }], details: { saved: true, vault: vault.name, path: notePath } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "kb_write",
		label: "Write knowledge-base note",
		description: "Create or replace a Markdown note in a knowledge-base folder. Requires user approval. Use for new synthesized notes; avoid replacing existing notes unless explicitly requested.",
		parameters: Type.Object({
			vault: Type.Optional(Type.String()),
			path: Type.String({ description: "Target note path inside the knowledge base." }),
			content: Type.String({ description: "Full Markdown note content." }),
			reason: Type.String({ description: "Why this write is needed." }),
		}),
		async execute(_id, { vault: vaultName, path: notePath, content, reason }, _signal, _onUpdate, ctx) {
			try {
				const vault = vaultByName(vaultName);
				if (!vault) throw new Error("No matching knowledge-base folder.");
				return await approvalWrite(ctx, vault, notePath, content, reason);
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerCommand("kb-vaults", {
		description: "List configured Markdown knowledge-base folders",
		handler: async (_args, ctx) => {
			const vaults = parseVaults();
			ctx.ui.notify(vaults.length ? vaults.map((v) => `${v.name}: ${v.root}`).join("\n") : "No knowledge-base folders configured.", "info");
		},
	});
}
