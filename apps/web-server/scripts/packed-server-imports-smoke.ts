// Releases bundle the server inside the packed install, so a file it imports by
// path breaks them unless "files" in the root package.json packs it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
// @ts-expect-error -- the release bundler has no type declarations
import { loadRewritesPlugin } from "../../../scripts/bundle-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_SOURCE = "apps/web-server/src";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function serverSourceFiles(dir = SERVER_SOURCE, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const file = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name !== "scripts") serverSourceFiles(file, found);
		} else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			found.push(file);
		}
	}
	return found;
}

function packedFiles(): Set<string> {
	// A shell on Windows, where npm is npm.cmd.
	const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
	assert(pack.status === 0, `npm pack --dry-run failed (exit ${pack.status}):\n${pack.stderr}`);
	// npm 11 prints an array of pack reports, npm 12 an object keyed by package name.
	const report = JSON.parse(pack.stdout);
	const packed = (Array.isArray(report) ? report[0] : Object.values(report)[0]) as { files: { path: string }[] };
	return new Set(packed.files.map((file) => file.path.replace(/\\/g, "/")));
}

const entries = serverSourceFiles();
assert(entries.length > 0, `found no server source files under ${SERVER_SOURCE}`);
let metafile: esbuild.Metafile;
try {
	const build = await esbuild.build({
		absWorkingDir: root,
		entryPoints: entries,
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		splitting: true,
		outdir: path.join(os.tmpdir(), "packed-server-imports"),
		write: false,
		metafile: true,
		logLevel: "silent",
		// As in scripts/bundle-server.mjs: no tsconfig.json on disk applies.
		tsconfigRaw: { compilerOptions: { target: "ES2022" } },
		plugins: [loadRewritesPlugin()],
	});
	metafile = build.metafile;
} catch (error) {
	const errors = (error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors ?? [];
	throw new Error(`esbuild could not follow the server's imports:\n${errors.map((e) => `  ${e.location ? `${e.location.file}:${e.location.line}: ` : ""}${e.text}`).join("\n") || String(error)}`);
}

const inputs = metafile.inputs;
const packed = packedFiles();
for (const entry of entries) {
	assert(entry in inputs, `esbuild did not read ${entry}`);
	assert(packed.has(entry), `the package does not pack the server source file ${entry}`);
}

const outside = Object.keys(inputs).filter((file) => !file.startsWith(`${SERVER_SOURCE}/`) && !file.split("/").includes("node_modules"));
const notPacked = outside.filter((file) => !packed.has(file));
const importers = (file: string) => Object.keys(inputs).filter((importer) => inputs[importer].imports.some((imported) => imported.path === file));
assert(
	notPacked.length === 0,
	`the release does not pack ${notPacked.length} file(s) that the server imports; add each to "files" in the root package.json:\n${notPacked.map((file) => `  ${file}, imported by ${importers(file).join(", ")}`).join("\n")}`,
);

console.log(`packed-server-imports smoke: ok (${entries.length} server files, ${outside.length} files they import from outside the server folder, all packed)`);
