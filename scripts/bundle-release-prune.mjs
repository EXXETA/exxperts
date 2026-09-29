// Trims the staged app/node_modules tree of files the app never reads at run
// time, before bundle-release.mjs archives it. The count matters more than the
// bytes: an installer writes every file, and a virus scanner checks each new
// file on its own, so a Windows install or update slows down with every file
// shipped. Only app/node_modules is trimmed; app/ outside it holds the
// TypeScript sources the server and the extensions run through tsx and jiti.
//
// Removed: source maps (*.map), declaration files (*.d.ts, *.d.mts, *.d.cts),
// third-party TypeScript sources (*.ts, *.mts, *.cts) and markdown (*.md,
// *.markdown). Tested by scripts/bundle-release.test.mjs.
import fs from "node:fs";
import path from "node:path";

// Packages the prune never touches, as path prefixes relative to
// app/node_modules. Everything inside them ships as installed.
export const PROTECTED_PACKAGES = [
	// Our own runtime packages. The runtime reads its own README, CHANGELOG,
	// docs and examples at run time (getPackageDir in
	// runtime/packages/coding-agent/src/config.ts).
	"@exxeta/",
	// The MCP extension is a pi package whose TypeScript sources the runtime
	// imports by name at run time.
	"pi-mcp-adapter/",
];

// We redistribute these packages, so their licence and notice files must
// travel with every copy, whatever their case or extension.
const LICENCE_FILE = /^(licen[cs]e|notice|copying)/i;

const JS_FILE = /\.[cm]?js$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

// A relative import, dynamic import, require or re-export whose specifier
// names a TypeScript file.
const RELATIVE_TS_SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+?\.[cm]?ts)\1/g;

function pruneKind(name) {
	if (LICENCE_FILE.test(name)) return null;
	const lower = name.toLowerCase();
	if (lower.endsWith(".map")) return "maps";
	if (DECLARATION_FILE.test(lower)) return "declarations";
	if (/\.[cm]?ts$/.test(lower)) return "typescript";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	return null;
}

function isProtected(rel) {
	return PROTECTED_PACKAGES.some((prefix) => `${rel}/`.startsWith(prefix));
}

// Calls visit(fullPath, relPosixPath, name) for every file under dir.
function walkFiles(dir, visit, rel = "") {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walkFiles(full, visit, childRel);
		else visit(full, childRel, entry.name);
	}
}

export function pruneNodeModules(nodeModulesDir) {
	const removed = new Set();
	const counts = { maps: 0, declarations: 0, typescript: 0, markdown: 0 };
	let filesBefore = 0;
	walkFiles(nodeModulesDir, (full, rel, name) => {
		filesBefore++;
		if (isProtected(rel)) return;
		const kind = pruneKind(name);
		if (!kind) return;
		fs.rmSync(full);
		removed.add(full);
		counts[kind]++;
	});
	return { filesBefore, filesAfter: filesBefore - removed.size, removed, counts };
}

// The static gate: every remaining JavaScript file that imports or requires a
// TypeScript file the prune removed, as { file, specifier }. Empty when the
// trimmed tree is safe to ship. A declaration file holds no run-time code, so
// a reference to one is a type annotation (JSDoc such as
// `@type {import('./list.d.ts').X}`, seen in undici and side-channel-list)
// and never fails the gate.
export function findPrunedTypeScriptImports(nodeModulesDir, removed) {
	const broken = new Map();
	walkFiles(nodeModulesDir, (full) => {
		if (!JS_FILE.test(full)) return;
		const text = fs.readFileSync(full, "utf8");
		for (const match of text.matchAll(RELATIVE_TS_SPECIFIER)) {
			const specifier = match[2];
			if (DECLARATION_FILE.test(specifier)) continue;
			if (removed.has(path.resolve(path.dirname(full), specifier))) broken.set(`${full}\0${specifier}`, { file: full, specifier });
		}
	});
	return [...broken.values()];
}
