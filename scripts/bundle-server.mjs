#!/usr/bin/env node
// Bundles the web server into one file, apps/web-server/dist/server.mjs, so
// the desktop app and the launchers start it with plain node instead of
// compiling its TypeScript through tsx at every launch. The runtime packages,
// the MCP adapter and the other dependencies are inlined; the packages that
// must stay real files are external (EXTERNAL_PACKAGES). The bundle sits at
// the same depth as apps/web-server/src, so every "three folders up" root
// lookup in the sources still lands on the install root.
//
//   node scripts/bundle-server.mjs [--map <file>]
//
// bundle-release.mjs runs it inside the installed app tree, after npm install
// and the MCP adapter patch, so the bundle inlines exactly the dependency
// versions that ship. --map moves the source map out of the tree, since it is
// never shipped; without it the map stays next to the bundle for local runs.
// Tested by scripts/bundle-server.test.mjs.
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ENTRY = "apps/web-server/src/index.ts";
const OUT_DIR = ["apps", "web-server", "dist"];
export const LICENCES_FILE = "server.mjs.licenses.txt";

// The runtime package folder as seen from the bundle file; getPackageDir() in
// runtime/packages/coding-agent/src/config.ts reads it, so VERSION, APP_NAME,
// the themes and the export template come from the runtime, not the app.
const PACKAGE_DIR_FROM_BUNDLE = "../../../runtime/packages/coding-agent";

// Packages left out of the bundle. `ships` says whether the bundled server
// needs the package as files at run time.
export const EXTERNAL_PACKAGES = [
	{ name: "jsdom", ships: true, reason: "fetch_url parses pages with it, and it loads its own worker and data files through require" },
	{ name: "playwright", ships: true, reason: "fetch_url and the artifacts extension import it on demand to render pages and slides" },
	{ name: "playwright-core", ships: true, reason: "playwright drives the browser through its files and driver" },
	{ name: "pdfjs-dist", ships: true, reason: "the shelf worker, a separate forked file, reads PDFs with it" },
	{ name: "@napi-rs/canvas", ships: true, reason: "the shelf worker renders PDF pages with it; native binary" },
	{ name: "recheck", ships: true, reason: "the MCP adapter checks regex search queries with checkSync, which starts ./synckit-worker and the native checker from recheck's own folder" },
	{ name: "esbuild", ships: false, reason: "only tsx uses it, and the bundled server never runs tsx" },
	{ name: "tsx", ships: false, reason: "the TypeScript loader the bundle replaces" },
	{ name: "koffi", ships: false, reason: "only the CLI's native clipboard reaches it" },
	{ name: "@mariozechner/clipboard", ships: false, reason: "only the CLI's terminal clipboard reaches it" },
	{ name: "fsevents", ships: false, reason: "optional macOS file watcher, never reached by the server" },
	{ name: "bufferutil", ships: false, reason: "optional native speedup for ws, never installed" },
	{ name: "utf-8-validate", ships: false, reason: "optional native speedup for ws, never installed" },
];

// Packages the bundled server loads as files although esbuild never sees an
// import of them, so they are not externals.
export const FILE_PACKAGES = [
	{ name: "qrcode-terminal", reason: "remote-qr.ts loads it through createRequire, which esbuild cannot follow" },
	{ name: "jszip", reason: "the shelf worker, a separate forked file, opens docx and xlsx with it" },
];

// A file of one of our runtime packages, whether esbuild reached it through
// the workspace folder npm links (runtime/packages/<dir>) or a copy in
// node_modules/@exxeta/<name>. `file` is a regular expression source.
const RUNTIME_PACKAGE_NAMES = { ai: "exxperts-ai", agent: "exxperts-core", "coding-agent": "exxperts-runtime", tui: "exxperts-tui" };
const runtimeFile = (dir, file) => new RegExp(`(^|/)(runtime/packages/${dir}|node_modules/@exxeta/${RUNTIME_PACKAGE_NAMES[dir]})/${file}$`);

// Reviewed places in the bundled code that load a module by a computed name
// (REVIEWED_DYNAMIC_LOADS) or find files through their own location, with
// __dirname, __filename, import.meta or require.resolve
// (REVIEWED_OWN_LOCATION_READS). Inside the bundle both resolve against the
// bundle's folder, not the original package, and esbuild gives no warning, so
// each place is listed with why it is safe; a new one fails the build until
// it is reviewed here. `file` matches the source path esbuild writes above
// each module; "(preamble)" is the code before the first module. `sites` is
// how many places the files an entry matches hold, so a new place in a
// reviewed file fails the build as a new file does. It is a ceiling, not an
// exact count: the release install resolves dependency versions without the
// lockfile, so its copy of a package can hold fewer places than the
// checkout's (measured 2026-09-30: the Mistral SDK's telemetry has 1 in the
// release and 0 in the checkout, the AWS user agent helper 0 and 2).
export const REVIEWED_DYNAMIC_LOADS = [
	{ file: runtimeFile("ai", "dist/(env-api-keys|providers/openai-codex-responses)\\.js"), sites: 2, reason: "imports node builtins by name, which resolve the same from any folder" },
	{ file: /(^|\/)node_modules\/@earendil-works\/pi-ai\/dist\/(env-api-keys|providers\/openai-codex-responses)\.js$/, sites: 2, reason: "the MCP adapter's copy of the same code: node builtins by name" },
	{ file: /(^|\/)node_modules\/jiti\//, sites: 3, reason: "jiti loads extensions for the CLI; the server passes noExtensions and never starts it" },
	{ file: /(^|\/)node_modules\/pi-mcp-adapter\/glimpse-ui\.ts$/, sites: 1, reason: "imports a separately installed glimpseui by absolute path or package name, which resolve the same from the bundle's folder" },
	{ file: /(^|\/)node_modules\/@mistralai\/mistralai\/esm\/extra\/observability\/telemetry\.js$/, sites: 1, reason: "loads OpenTelemetry packages only when a client turns telemetry on; they are optional peers that are not installed, so the SDK's own fallback runs, as unbundled" },
];

const installRootReason = "finds the install root three folders up or in EXXETA_HOME, which the bundle keeps by sitting at the same depth as src";

export const REVIEWED_OWN_LOCATION_READS = [
	{ file: /^\(preamble\)$/, sites: 5, reason: "the bundle's banner defines require, __filename and __dirname for the inlined CommonJS code" },
	{ file: /(^|\/)apps\/web-server\/src\/index\.ts$/, sites: 3, reason: `${installRootReason}; loads room-lock.cjs and state-profiles.cjs from there` },
	{ file: /(^|\/)apps\/web-server\/src\/persistent-agents\.ts$/, sites: 2, reason: `${installRootReason}; loads room-lock.cjs from there` },
	{ file: /(^|\/)apps\/web-server\/src\/persistent-room-background-execution\.ts$/, sites: 1, reason: installRootReason },
	{ file: /(^|\/)apps\/web-server\/src\/scheduled-prompt-background-execution\.ts$/, sites: 2, reason: `${installRootReason}; loads room-lock.cjs from there` },
	{ file: /(^|\/)apps\/web-server\/src\/whats-new\.ts$/, sites: 1, reason: installRootReason },
	{ file: /(^|\/)apps\/web-server\/src\/persistent-room-shelf-reading\.ts$/, sites: 1, reason: "forks shelf-parse-worker.mjs, copied beside the bundle (BUNDLE_ASSETS)" },
	{ file: /(^|\/)apps\/web-server\/src\/remote-qr\.ts$/, sites: 1, reason: "loads qrcode-terminal through createRequire; it ships as files (FILE_PACKAGES)" },
	{ file: /(^|\/)pi-package\/extensions\/fetch_url\/index\.ts$/, sites: 1, reason: "loads jsdom through createRequire on the first page it parses; jsdom ships as files (EXTERNAL_PACKAGES)" },
	{ file: runtimeFile("coding-agent", "dist/config\\.js"), sites: 4, reason: "finds its package folder through the build-time define" },
	{ file: runtimeFile("coding-agent", "dist/utils/photon\\.js"), sites: 1, reason: "creates a require for node builtins only" },
	{ file: /(^|\/)node_modules\/@silvia-odwyer\/photon-node\/photon_rs\.js$/, sites: 1, reason: "reads photon_rs_bg.wasm, copied beside the bundle (BUNDLE_ASSETS)" },
	{ file: /(^|\/)node_modules\/pi-mcp-adapter\/ui-server\.ts$/, sites: 1, reason: "reads app-bridge.bundle.js, copied beside the bundle (BUNDLE_ASSETS)" },
	{ file: /(^|\/)node_modules\/pi-mcp-adapter\/glimpse-ui\.ts$/, sites: 1, reason: "creates a require to find a separately installed glimpseui" },
	{ file: runtimeFile("ai", "dist/utils/oauth/oauth-page\\.js"), sites: 1, reason: "finds the logo under EXXETA_HOME before walking up from its own folder" },
	{ file: runtimeFile("tui", "dist/terminal\\.js"), sites: 1, reason: "terminal handling for the CLI; its require is for koffi, which the server never reaches" },
	{ file: /(^|\/)node_modules\/@earendil-works\/pi-tui\/dist\/terminal\.js$/, sites: 1, reason: "the MCP adapter's copy of the CLI terminal handling; its require is for koffi, never reached" },
	{ file: runtimeFile("coding-agent", "dist/utils/clipboard-native\\.js"), sites: 1, reason: "the CLI's native clipboard, never reached by the server" },
	{ file: runtimeFile("coding-agent", "dist/core/extensions/loader\\.js"), sites: 3, reason: "the extension loader runs jiti, which the server never starts" },
	{ file: /(^|\/)node_modules\/jiti\//, sites: 9, reason: "jiti loads extensions for the CLI; the server passes noExtensions and never starts it" },
	{ file: /(^|\/)node_modules\/(pino\/lib\/transport|thread-stream\/index)\.js$/, sites: 4, reason: "starts worker files only for a log transport; the server's logger has none" },
	{ file: /(^|\/)node_modules\/@aws-sdk\/core\/.*\/getTypeScriptUserAgentPair\.js$/, sites: 2, reason: "looks for a TypeScript install to name in the user agent, inside a try, and leaves it out when none is found" },
	{ file: /(^|\/)node_modules\/@tootallnate\/quickjs-emscripten\//, sites: 3, reason: "its wasm is embedded as a data URI, so the file path it computes is never read" },
	{ file: /(^|\/)node_modules\/undici\/index\.js$/, sites: 2, reason: "uses its own file name only to recognise its frames in stack traces" },
	{ file: /(^|\/)node_modules\/open\/index\.js$/, sites: 1, reason: "on Linux falls back to the system xdg-open when its own copy is not beside it; macOS and Windows never use it" },
];

// Packages the bundled code names in a literal require, require.resolve or
// createRequire call that neither ship as files (EXTERNAL_PACKAGES,
// FILE_PACKAGES) nor are builtins, each with why it is safe. The trimmed
// desktop payload keeps only the shipped packages, so any other name would
// fail there alone; a new one fails the build until it is reviewed here.
export const REVIEWED_BARE_REQUIRES = [
	{ name: "fast-json-stringify", reason: "text of the standalone code fastify's serializer can generate; the server never generates it" },
	{ name: "google-auth-library", reason: "an example in a documentation comment of the Google GenAI SDK" },
	{ name: "@aws-sdk/signature-v4-crt", reason: "text of an AWS SDK error message" },
	{ name: "@aws-sdk/signature-v4a", reason: "text of an AWS SDK error message" },
	{ name: "glimpseui", reason: "the MCP adapter looks for a separately installed glimpseui inside a try; none is installed" },
	{ name: "typebox", reason: "the extension loader resolves it for extensions run through jiti, which the server never starts" },
];

// Files the bundled code reads from its own folder at run time, copied beside
// the bundle. `source` is a path in the tree; `package` names the inlined
// package whose folder holds `file`, so the copy matches the inlined version.
export const BUNDLE_ASSETS = [
	{ file: "shelf-parse-worker.mjs", source: "apps/web-server/src/shelf-parse-worker.mjs", reason: "persistent-room-shelf-reading.ts forks it from its own folder" },
	{ file: "photon_rs_bg.wasm", package: "@silvia-odwyer/photon-node", reason: "photon-node reads its wasm from its own __dirname" },
	{ file: "app-bridge.bundle.js", package: "pi-mcp-adapter", reason: "the adapter's ui-server.ts reads it from import.meta.dirname" },
];

// CommonJS dependencies inlined into an ES module still call require and read
// __filename and __dirname; these give them the bundle's own.
const BANNER = [
	"import { createRequire as __bundleCreateRequire } from 'node:module';",
	"import { fileURLToPath as __bundleFileURLToPath } from 'node:url';",
	"import { dirname as __bundleDirname } from 'node:path';",
	"const require = __bundleCreateRequire(import.meta.url);",
	"const __filename = __bundleFileURLToPath(import.meta.url);",
	"const __dirname = __bundleDirname(__filename);",
].join("\n");

// esbuild inlines only what a literal specifier names and gives no warning
// for the rest, which would then resolve against the bundle's folder at run
// time and fail. These rewrites apply while a file loads, so the sources and
// the type check stay untouched.
const SPECIFIER_CONSTANT = /const (\w+) = ("[^"\n]+") as string;/g;
const BEDROCK_CALL = 'importNodeOnlyProvider("./amazon-bedrock.js")';
const LOAD_REWRITES = [
	{
		// The web server and the MCP extension keep the adapter's TypeScript
		// specifiers (and the extension's own panel) in `"..." as string`
		// constants, so tsc never follows them into raw sources.
		filter: /[\\/](?:apps[\\/]web-server[\\/]src|pi-package)[\\/].*\.ts$/,
		rewrite(source) {
			if (!source.includes(" as string;")) return source;
			let out = source;
			for (const [, name, literal] of source.matchAll(SPECIFIER_CONSTANT)) {
				out = out.replaceAll(`import(${name})`, `import(${literal})`);
			}
			return out;
		},
	},
	{
		// The ai package loads its Bedrock provider through a helper so browser
		// builds skip it; the specifier is relative to the ai package.
		filter: /[\\/]providers[\\/]register-builtins\.[cm]?[jt]s$/,
		rewrite(source, file) {
			if (!source.includes(BEDROCK_CALL)) {
				throw new Error(`${file} no longer loads the Bedrock provider through ${BEDROCK_CALL}; update the rewrite in scripts/bundle-server.mjs`);
			}
			return source.replaceAll(BEDROCK_CALL, 'import("./amazon-bedrock.js")');
		},
	},
];

function loadRewritesPlugin() {
	return {
		name: "exxperts-load-rewrites",
		setup(build) {
			for (const rule of LOAD_REWRITES) {
				build.onLoad({ filter: rule.filter }, async (args) => {
					const source = await fs.promises.readFile(args.path, "utf8");
					const contents = rule.rewrite(source, args.path);
					if (contents === source) return undefined;
					return { contents, loader: /\.[cm]?ts$/.test(args.path) ? "ts" : "js" };
				});
			}
		},
	};
}

// A dependency may declare a peer as optional and load the code that needs it
// inside a try; the Mistral SDK does this for OpenTelemetry. Unbundled, the
// missing peer fails only when that code loads, while esbuild would fail the
// whole build. For an optional peer that is not installed, the bundle gets a
// module that throws the same "not found" error when it loads, so the
// dependency's own fallback runs. Any other unresolved import still fails.
const MISSING_PEER_NAMESPACE = "exxperts-missing-optional-peer";

function owningPackage(file) {
	const match = file.replace(/\\/g, "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
	if (!match) return null;
	try {
		return JSON.parse(fs.readFileSync(path.join(match[1], "package.json"), "utf8"));
	} catch {
		return null;
	}
}

function missingOptionalPeersPlugin(missing) {
	return {
		name: "exxperts-missing-optional-peers",
		setup(build) {
			build.onResolve({ filter: /^[^./]/ }, async (args) => {
				if (args.pluginData?.missingPeerCheck || !args.importer) return undefined;
				const resolved = await build.resolve(args.path, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: { missingPeerCheck: true },
				});
				if (resolved.errors.length === 0) return undefined;
				const packageName = args.path.match(/^(@[^/]+\/[^/]+|[^/]+)/)[1];
				const owner = owningPackage(args.importer);
				if (!owner?.peerDependenciesMeta?.[packageName]?.optional) return undefined;
				missing.add(`${packageName} (optional peer of ${owner.name})`);
				return { path: args.path, namespace: MISSING_PEER_NAMESPACE };
			});
			build.onLoad({ filter: /.*/, namespace: MISSING_PEER_NAMESPACE }, (args) => ({
				contents: `throw Object.assign(new Error(${JSON.stringify(`Cannot find package '${args.path}'`)}), { code: "ERR_MODULE_NOT_FOUND" });\nmodule.exports = {};\n`,
				loader: "js",
			}));
		},
	};
}

// The folder of every package with inlined code, keyed by name and version:
// the last node_modules segment of an input path, or a runtime workspace
// package. esbuild writes input paths with forward slashes on every platform.
function inlinedPackages(root, metafile) {
	const roots = new Set();
	for (const input of Object.keys(metafile.inputs)) {
		const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//) ?? input.match(/^(runtime\/packages\/[^/]+)\//);
		if (match) roots.add(match[1]);
	}
	const packages = new Map();
	for (const rel of [...roots].sort()) {
		const dir = path.join(root, ...rel.split("/"));
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		const key = `${pkg.name}@${pkg.version}`;
		if (!packages.has(key)) packages.set(key, { name: pkg.name, version: pkg.version, license: pkg.license, dir });
	}
	return packages;
}

// The same licence and notice file names the payload prune keeps.
const LICENCE_FILE = /^(licen[cs]e|notice|copying)/i;

function licenceText(packages) {
	const rule = "=".repeat(72);
	const parts = [
		"Third-party software inlined into server.mjs, with the licence and notice",
		"files each package ships. Generated by scripts/bundle-server.mjs.",
	];
	const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
	for (const pkg of sorted) {
		const files = fs.readdirSync(pkg.dir).filter((name) => LICENCE_FILE.test(name)).sort();
		parts.push("", rule, `${pkg.name} ${pkg.version} (${pkg.license ?? "no license field"})`, rule);
		if (files.length === 0) parts.push("", "This package ships no licence file.");
		for (const name of files) parts.push("", `--- ${name}`, "", fs.readFileSync(path.join(pkg.dir, name), "utf8").trimEnd());
	}
	return `${parts.join("\n")}\n`;
}

const isBuiltin = (specifier) =>
	specifier.startsWith("node:") || builtinModules.includes(specifier) || builtinModules.includes(specifier.split("/")[0]);
const packageName = (specifier) => specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/)[1];

// The source path esbuild writes on its own line above each inlined module
// (forward slashes, but a backslash is accepted so Windows can never turn
// every match into the reviewed preamble).
const MODULE_COMMENT = /^\/\/ ((?:[\w@.+-]+[\\/])+[\w@.+-]+\.\w+)$/gm;
// A load by a computed name: import( or __require( not followed by a string.
const DYNAMIC_LOAD = /(?<![.\w$])(?:import|__require)\(\s*(?![\s"'`)])/g;
const OWN_LOCATION_READ =
	/\b__dirname\b|\b__filename\b|\bimport\.meta\.(?:url|dirname|filename)\b|\bimport_meta\d*\.(?:url|dirname|filename)\b|\b(?:__)?require\.resolve\(/g;

// Every match of pattern with the file it sits in (the module whose source
// comment comes before it) and its bundle line.
function sitesOf(text, pattern) {
	const modules = [...text.matchAll(MODULE_COMMENT)].map((m) => [m.index, m[1].replaceAll("\\", "/")]);
	const sites = [];
	let next = 0;
	let line = 1;
	let counted = 0;
	for (const match of text.matchAll(pattern)) {
		while (next < modules.length && modules[next][0] <= match.index) next++;
		for (; counted < match.index; counted++) if (text.charCodeAt(counted) === 10) line++;
		sites.push({ file: next === 0 ? "(preamble)" : modules[next - 1][1], line });
	}
	return sites;
}

// What a scan finds beyond its reviewed list: a file no entry matches, named
// with its first place, and an entry whose files hold more places than it
// reviews, named with every place so the new one can be found.
function siteProblems(text, pattern, reviewed, { list, one, many }) {
	const unreviewed = new Map();
	const byEntry = new Map();
	for (const site of sitesOf(text, pattern)) {
		const entry = reviewed.find((candidate) => candidate.file.test(site.file));
		if (!entry) {
			if (!unreviewed.has(site.file)) unreviewed.set(site.file, site.line);
			continue;
		}
		if (!byEntry.has(entry)) byEntry.set(entry, []);
		byEntry.get(entry).push(site);
	}
	const problems = [...unreviewed].map(([file, line]) => `${file} (server.mjs line ${line}) ${one}; review it and list it in ${list} with the reason it is safe`);
	for (const [entry, sites] of byEntry) {
		if (sites.length <= entry.sites) continue;
		const files = [...new Set(sites.map((site) => site.file))].join(", ");
		const lines = sites.map((site) => site.line).join(", ");
		problems.push(`${files} has ${sites.length} places that ${many} (server.mjs lines ${lines}), ${entry.sites} reviewed; review the new one and raise the count in ${list} with the reason it is safe`);
	}
	return problems;
}

// Packages the bundled code names literally in require, __require,
// require.resolve or a createRequire result, with the text offset of the
// first. Most are loads; some are text that only looks like one (code a
// library can generate, comments, error messages), which the review sorts.
const CREATE_REQUIRE_CALL = String.raw`(?:__bundleCreateRequire|createRequire\d*)\((?:[^()]|\([^()]*\))*\)`;
function bareRequires(text) {
	const callees = new Set(["require", "__require"]);
	for (const match of text.matchAll(new RegExp(String.raw`([\w$]+)\s*=\s*${CREATE_REQUIRE_CALL}\s*(?=[;,\n])`, "g"))) callees.add(match[1]);
	const names = [...callees].map((name) => name.replaceAll("$", "\\$")).join("|");
	const call = new RegExp(String.raw`(?<![\w$.'"\`])(?:${names}|${CREATE_REQUIRE_CALL})(?:\.resolve)?\(\s*(["'])([^"'\n]+)\1\s*[,)]`, "g");
	const found = new Map();
	for (const match of text.matchAll(call)) {
		const specifier = match[2];
		if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) continue;
		const name = packageName(specifier);
		if (!found.has(name)) found.set(name, { specifier, index: match.index });
	}
	return found;
}

// Walks up node_modules folders from `from` the way node does, but never above
// root: a payload is checked for what it carries itself, not for what a
// checkout or a home folder around it happens to hold.
function resolvePackageDir(name, from, root) {
	for (let dir = from; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", ...name.split("/"));
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		if (dir === root || path.dirname(dir) === dir) return null;
	}
}

// The folders of every package the bundled server loads as files, with the
// packages they depend on, resolved the way node does from the bundle's
// folder: what a payload that drops everything else must keep. `missing`
// names what could not be found. `exclude` names optional dependencies a
// trimmed payload leaves out on purpose; a package that a kept package
// requires is kept all the same.
export function shippedPackageDirs(root, { exclude = [] } = {}) {
	const base = path.resolve(root);
	const outDir = path.join(base, ...OUT_DIR);
	const dirs = new Set();
	const missing = [];
	const queue = [...EXTERNAL_PACKAGES.filter((pkg) => pkg.ships), ...FILE_PACKAGES].map(({ name }) => ({ name, from: outDir }));
	while (queue.length > 0) {
		const { name, from, neededBy, optional } = queue.shift();
		const dir = resolvePackageDir(name, from, base);
		if (!dir) {
			if (!optional) missing.push(neededBy ? `${name} (needed by ${neededBy}) is missing` : `${name} is missing`);
			continue;
		}
		if (dirs.has(dir)) continue;
		dirs.add(dir);
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		const optionalNames = new Set([...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
		for (const dep of new Set([...Object.keys(pkg.dependencies ?? {}), ...optionalNames])) {
			const optional = optionalNames.has(dep);
			if (optional && exclude.includes(dep)) continue;
			queue.push({ name: dep, from: dir, neededBy: pkg.name, optional });
		}
	}
	return { dirs, missing };
}

// What a payload holding the bundled server lacks: the bundle, its licences
// and assets, and the packages it loads as files. Empty when complete. Run
// after every build and again on any payload trimmed around the bundle.
export function checkServerFiles(root) {
	const outDir = path.join(root, ...OUT_DIR);
	const problems = [];
	for (const file of ["server.mjs", LICENCES_FILE, ...BUNDLE_ASSETS.map((asset) => asset.file)]) {
		if (!fs.existsSync(path.join(outDir, file))) problems.push(`apps/web-server/dist/${file} is missing`);
	}
	return [...problems, ...shippedPackageDirs(root).missing];
}

// Packages the forked shelf worker imports; it runs as its own file, so each
// must ship as files.
async function workerPackages(root) {
	const worker = BUNDLE_ASSETS.find((asset) => asset.file === "shelf-parse-worker.mjs").source;
	const result = await esbuild.build({
		absWorkingDir: root,
		entryPoints: [worker],
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	const specifiers = Object.values(result.metafile.outputs).flatMap((out) => out.imports.filter((imp) => imp.external).map((imp) => imp.path));
	return [...new Set(specifiers.filter((specifier) => !isBuiltin(specifier)))];
}

async function bundleProblems(root, text, metafile, packages) {
	const problems = [];
	problems.push(
		...siteProblems(text, DYNAMIC_LOAD, REVIEWED_DYNAMIC_LOADS, { list: "REVIEWED_DYNAMIC_LOADS", one: "loads a module by a computed name", many: "load a module by a computed name" }),
		...siteProblems(text, OWN_LOCATION_READ, REVIEWED_OWN_LOCATION_READS, { list: "REVIEWED_OWN_LOCATION_READS", one: "finds files through its own location", many: "find files through their own location" }),
	);
	const loadable = new Set([...EXTERNAL_PACKAGES, ...FILE_PACKAGES, ...REVIEWED_BARE_REQUIRES].map((pkg) => pkg.name));
	for (const [name, { specifier, index }] of bareRequires(text)) {
		if (loadable.has(name)) continue;
		const line = text.slice(0, index).split("\n").length;
		problems.push(`the bundle loads ${specifier} by name at run time (server.mjs line ${line}), but ${name} neither ships as files nor is reviewed, so a trimmed payload would lack it; add it to FILE_PACKAGES with the reason, or to REVIEWED_BARE_REQUIRES with the reason it is safe`);
	}

	const output = Object.entries(metafile.outputs).find(([file]) => file.endsWith("server.mjs"))[1];
	for (const imp of output.imports) {
		if (!imp.external || isBuiltin(imp.path)) continue;
		const entry = EXTERNAL_PACKAGES.find((pkg) => pkg.name === packageName(imp.path));
		if (entry && !entry.ships && imp.kind === "import-statement") {
			problems.push(`the bundle imports ${imp.path} at its top, but ${entry.name} does not ship, so the server would not start without it`);
		}
	}

	const shipped = new Set([...EXTERNAL_PACKAGES.filter((pkg) => pkg.ships), ...FILE_PACKAGES].map((pkg) => pkg.name));
	for (const specifier of await workerPackages(root)) {
		if (!shipped.has(packageName(specifier))) {
			problems.push(`the shelf worker imports ${specifier}, but ${packageName(specifier)} does not ship as files; add it to FILE_PACKAGES with the reason`);
		}
	}

	for (const pkg of packages.values()) {
		const hasLicenceFile = fs.readdirSync(pkg.dir).some((name) => LICENCE_FILE.test(name));
		if (!hasLicenceFile && !pkg.license) problems.push(`${pkg.name} ${pkg.version} is inlined but has neither a licence file nor a license field`);
	}
	return [...problems, ...checkServerFiles(root)];
}

export async function bundleServer({ root, mapFile = null, log = (msg) => console.log(`[bundle-server] ${msg}`) }) {
	const outDir = path.join(root, ...OUT_DIR);
	fs.rmSync(outDir, { recursive: true, force: true });
	const missingPeers = new Set();
	const options = {
		absWorkingDir: root,
		entryPoints: { server: ENTRY },
		outdir: outDir,
		outExtension: { ".js": ".mjs" },
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: EXTERNAL_PACKAGES.map((pkg) => pkg.name),
		// Explicit, so no tsconfig.json on disk applies: the runtime's `paths`
		// would otherwise pull its packages from src/ instead of the built dist/.
		tsconfigRaw: { compilerOptions: { target: "ES2022" } },
		define: { __EXXPERTS_BUNDLED_PACKAGE_DIR__: JSON.stringify(PACKAGE_DIR_FROM_BUNDLE) },
		banner: { js: BANNER },
		metafile: true,
		logLevel: "warning",
		plugins: [loadRewritesPlugin(), missingOptionalPeersPlugin(missingPeers)],
	};
	// Two builds from the same inputs. The checks read the first, kept in
	// memory, because it names each module's source path in a comment above
	// it. The second ships: without whitespace and comments it is about a
	// quarter smaller, and node holds the whole source in memory while the
	// server runs. Licence headers stay at its end, since for some packages
	// (the Google GenAI SDK, SheetJS) they hold the only copyright notice.
	const inspected = await esbuild.build({ ...options, write: false });
	const result = await esbuild.build({ ...options, minifyWhitespace: true, legalComments: "eof", sourcemap: "external" });
	const outFile = path.join(outDir, "server.mjs");
	const packages = inlinedPackages(root, result.metafile);

	const byName = new Map([...packages.values()].map((pkg) => [pkg.name, pkg]));
	for (const asset of BUNDLE_ASSETS) {
		if (asset.package && !byName.has(asset.package)) {
			throw new Error(`${asset.file}: ${asset.package} is no longer inlined; drop the entry from BUNDLE_ASSETS in scripts/bundle-server.mjs`);
		}
		const from = asset.source ? path.join(root, ...asset.source.split("/")) : path.join(byName.get(asset.package).dir, asset.file);
		fs.copyFileSync(from, path.join(outDir, asset.file));
	}
	fs.writeFileSync(path.join(outDir, LICENCES_FILE), licenceText(packages));

	const inspectedText = inspected.outputFiles.find((file) => file.path.endsWith("server.mjs")).text;
	const problems = await bundleProblems(root, inspectedText, result.metafile, packages);
	const sameInputs = (build) => JSON.stringify(Object.keys(build.metafile.inputs).sort());
	if (sameInputs(inspected) !== sameInputs(result)) problems.push("the checked build and the shipped build inlined different files");
	if (problems.length > 0) {
		throw new Error(`the bundled server failed its checks:\n  - ${problems.join("\n  - ")}`);
	}

	const builtMap = `${outFile}.map`;
	if (mapFile) {
		fs.mkdirSync(path.dirname(mapFile), { recursive: true });
		fs.copyFileSync(builtMap, mapFile);
		fs.rmSync(builtMap);
	}

	const megabytes = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
	log(`${path.relative(root, outFile)}: ${megabytes} MB from ${Object.keys(result.metafile.inputs).length} files, ${packages.size} packages inlined`);
	for (const peer of [...missingPeers].sort()) log(`not installed, fails only when loaded: ${peer}`);
	return { outFile, metafile: result.metafile, packages, missingPeers };
}

// Run from the command line. Real paths on both sides: the temp install lives
// under /var on macOS, which the module URL reports as /private/var.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const mapIndex = process.argv.indexOf("--map");
	const mapFile = mapIndex !== -1 && process.argv[mapIndex + 1] ? path.resolve(process.argv[mapIndex + 1]) : null;
	await bundleServer({ root, mapFile });
}
