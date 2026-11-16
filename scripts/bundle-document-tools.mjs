#!/usr/bin/env node
// Builds the document packages the app carries beside its Node: each package
// of apps/document-tools/package.json becomes one CommonJS file, so a script
// run with NODE_PATH=<out>/node_modules finds it by name. A package folder
// would not do: the list installs thousands of files, over the file ceilings
// of the release archive and the desktop app.
//
//   node scripts/bundle-document-tools.mjs --out <folder>
//
// Writes <folder>/node_modules/<name>/index.js and, beside it, LICENSES.txt
// with the licence of every package inlined into that file. The packages are
// installed from the list's own lockfile, the one the release scan and the
// bill of materials read, in a temporary folder, with no install script run.
// The list forces three versions: without them it fails the scan (image-size,
// uuid) or holds a package with no licence (buffers, through unzipper).
//
// bundle-release.mjs runs it once for each archive. It fails on a native file
// in the install, and on an inlined package with no licence. Tested by
// scripts/bundle-document-tools.test.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

export const LICENCES_FILE = "LICENSES.txt";

// Left as a plain require, which fails only where it is called. Any other
// package that cannot be found fails the build, unless its require sits in a
// try: esbuild leaves that one for the package's own fallback.
const NOT_INLINED = [
	{ name: "@aws-sdk/client-s3", reason: "unzipper's reading of a zip straight from S3; exceljs never calls it" },
];

const NATIVE_FILE = /\.(node|dll|dylib|exe)$|\.so(\.\d+)*$/i;

function nativeFiles(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...nativeFiles(full));
		else if (NATIVE_FILE.test(entry.name)) found.push(full);
	}
	return found;
}

// The licence rules below are scripts/bundle-server.mjs's: change them together.
// The folder of every package with code in a built file: the last
// node_modules segment of an input path. esbuild writes input paths with
// forward slashes on every platform.
function inlinedPackages(root, metafile) {
	const dirs = new Set();
	for (const input of Object.keys(metafile.inputs)) {
		const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
		if (match) dirs.add(path.join(root, ...match[1].split("/")));
	}
	return [...dirs].map((dir) => {
		const { name, version, license } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		const licenceFiles = fs.readdirSync(dir).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file)).sort();
		return { name, version, license, dir, licenceFiles };
	}).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function licenceText(name, packages) {
	const rule = "=".repeat(72);
	const parts = [`Software inlined into ${name}'s index.js, with the licence and notice files each package ships.`];
	for (const pkg of packages) {
		parts.push("", rule, `${pkg.name} ${pkg.version} (${pkg.license ?? "no license field"})`, rule);
		if (pkg.licenceFiles.length === 0) parts.push("", "This package ships no licence file.");
		for (const file of pkg.licenceFiles) parts.push("", `--- ${file}`, "", fs.readFileSync(path.join(pkg.dir, file), "utf8").trimEnd());
	}
	return `${parts.join("\n")}\n`;
}

// Builds every package of the list at root, which holds its package.json and
// its installed node_modules, into outDir. Returns one row per package.
export async function bundleInstalled(root, outDir) {
	const natives = nativeFiles(path.join(root, "node_modules"));
	if (natives.length > 0) {
		throw new Error(`the document packages must be plain JavaScript, but the install holds native files:\n  - ${natives.map((file) => path.relative(root, file)).join("\n  - ")}`);
	}
	const names = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies);
	fs.rmSync(outDir, { recursive: true, force: true });
	const rows = [];
	for (const name of names) {
		const dir = path.join(outDir, "node_modules", ...name.split("/"));
		const outfile = path.join(dir, "index.js");
		// A require, not an entry point: esbuild then takes the file Node's
		// require takes, so a .cjs sees the package's real shape. As an entry
		// point it can take the package's ES build, where the same export
		// sits on `.default`.
		const result = await esbuild.build({
			absWorkingDir: root,
			stdin: { contents: `module.exports = require(${JSON.stringify(name)});`, resolveDir: root, loader: "js" },
			outfile,
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node22",
			external: NOT_INLINED.map((pkg) => pkg.name),
			metafile: true,
			logLevel: "silent",
		});
		const packages = inlinedPackages(root, result.metafile);
		const unlicensed = packages.filter((pkg) => pkg.licenceFiles.length === 0 && !pkg.license);
		if (unlicensed.length > 0) {
			throw new Error(`${name} inlines packages with neither a licence file nor a license field: ${unlicensed.map((pkg) => `${pkg.name} ${pkg.version}`).join(", ")}`);
		}
		fs.writeFileSync(path.join(dir, LICENCES_FILE), licenceText(name, packages));
		rows.push({ name, bytes: fs.statSync(outfile).size, licenceBytes: fs.statSync(path.join(dir, LICENCES_FILE)).size, packages: packages.length });
	}
	return rows;
}

// Installs the list from its lockfile into dir. npm is npm.cmd on Windows,
// where a shell is required to spawn it; no argument here needs quoting.
export function installList(listDir, dir) {
	for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(listDir, file), path.join(dir, file));
	const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
	if (install.status !== 0) throw new Error(`npm ci failed for the document packages (exit ${install.status ?? "signal"})`);
}

// Run from the command line. Real paths on both sides, as in bundle-server.mjs.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const outIndex = process.argv.indexOf("--out");
	if (outIndex === -1 || !process.argv[outIndex + 1]) {
		console.error("Usage: node scripts/bundle-document-tools.mjs --out <folder>");
		process.exit(2);
	}
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-document-tools-"));
	try {
		installList(path.join(repoRoot, "apps", "document-tools"), work);
		const rows = await bundleInstalled(work, path.resolve(process.argv[outIndex + 1]));
		for (const row of rows) console.log(`[bundle-document-tools] ${row.name}: ${(row.bytes / 1e6).toFixed(2)} MB, ${row.packages} packages, licences ${(row.licenceBytes / 1e3).toFixed(0)} KB`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
