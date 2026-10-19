// Portability lint: flags smoke code that past Windows and Linux CI breaks came
// from, so the break shows on the Mac before the push. Each rule is one shape
// that broke a release check once:
// - file-mode: an assert on POSIX mode bits (Windows has none).
// - posix-shell: a /bin/sh command or a #! script (Windows cannot start them).
// - chmod-refusal: a chmod that takes the owner's write away to force a failure
//   (it has no effect on Windows, nor as root, which the Linux check runs as).
// - relative-path: a path.relative result collected into a list without
//   being turned into forward slashes, the list later compared to names.
// A line counts as guarded when an if on process.platform and win32 (or the
// shared canForceFsRefusal) sits within the 60 lines above it, or a column-0
// win32 if above it ends the smoke with process.exit within three lines. A
// ternary on win32 picks a value and guards nothing. A reviewed line that is
// fine as it is carries "portability-ok: <why>", with its reason, on the line
// or the line above. The lint first checks its own patterns on the cases
// below, so an edit that breaks one fails here instead of passing silently.
// Usage: this smoke checks every other smoke in its folder; given file paths,
// it checks only those (how the pre-fix versions of the past breaks are tried).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Rule = { id: string; pattern: RegExp; needs: RegExp[]; fineOnLine?: RegExp };

const LOOKBACK = 60;
const platformTest = /\bif \(.*process\.platform [!=]== "win32"|canForceFsRefusal/;
const rules: Rule[] = [
	{ id: "file-mode", pattern: /\.mode\s*&\s*0o[0-7]+/, needs: [platformTest] },
	{ id: "posix-shell", pattern: /["'`](?:\/usr)?\/bin\/(?:ba|z)?sh["'`]|#!\/(?:usr\/)?bin\//, needs: [platformTest] },
	{ id: "chmod-refusal", pattern: /chmodSync\([^;]*,\s*0o[0-5][0-7]{2}\s*\)/, needs: [platformTest, /getuid|canForceFsRefusal/] },
	{ id: "relative-path", pattern: /\.push\(path\.relative\(/, needs: [platformTest], fineOnLine: /split\(path\.sep\)|path\.posix|\.sep\b/ },
];
const allowed = /portability-ok:\s*\S/;

// Each hit as "<line number>: <rule>: <line>".
function findingsIn(lines: string[]): string[] {
	const smokeEnds = lines.findIndex((line, i) => /^if \(process\.platform === "win32"\)/.test(line) && lines.slice(i, i + 4).some((next) => next.includes("process.exit(")));
	const found: string[] = [];
	lines.forEach((line, i) => {
		if (allowed.test(line) || allowed.test(lines[i - 1] ?? "")) return;
		if (smokeEnds !== -1 && i > smokeEnds) return;
		for (const rule of rules) {
			if (!rule.pattern.test(line) || rule.fineOnLine?.test(line)) continue;
			const context = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n");
			if (rule.needs.every((need) => need.test(context))) continue;
			found.push(`${i + 1}: ${rule.id}: ${line.trim().slice(0, 160)}`);
		}
	});
	return found;
}

// The lint's own cases: the lines each case must flag, by line number.
const filler = Array.from({ length: LOOKBACK + 1 }, () => "doSomething();");
const cases: Array<{ name: string; lines: string[]; flags: number[] }> = [
	{ name: "each shape alone", flags: [1, 2, 3, 4, 5], lines: [
		'assert((fs.statSync(file).mode & 0o777) === 0o600);',
		'spawn("/bin/sh", ["-c", "true"]);',
		'"#!/bin/sh",',
		"fs.chmodSync(dir, 0o500);",
		"found.push(path.relative(home, file));",
	] },
	{ name: "a ternary on win32 guards nothing", flags: [2], lines: [
		'const exe = process.platform === "win32" ? "node.exe" : "node";',
		'assert((fs.statSync(file).mode & 0o777) === 0o600);',
	] },
	{ name: "forward slashes pass", flags: [], lines: [
		'found.push(path.relative(home, file).split(path.sep).join("/"));',
	] },
	{ name: "an allow line needs a reason", flags: [2], lines: [
		"// portability-ok:",
		"fs.chmodSync(dir, 0o500);",
		"// portability-ok: the case says why",
		"fs.chmodSync(dir, 0o500);",
	] },
	{ name: "an if on win32 and root guards", flags: [], lines: [
		'if (process.platform !== "win32" && process.getuid?.() !== 0) {',
		"	fs.chmodSync(dir, 0o500);",
		'	assert((fs.statSync(file).mode & 0o777) === 0o600);',
		"}",
	] },
	{ name: "a chmod needs a root test too", flags: [2], lines: [
		'if (process.platform !== "win32") {',
		"	fs.chmodSync(dir, 0o500);",
		"}",
	] },
	{ name: "a column-0 win32 if that goes on guards only its window", flags: [LOOKBACK + 5], lines: [
		'if (process.platform === "win32") {',
		'	console.log("one part skipped");',
		"}",
		...filler,
		'spawn("/bin/sh", ["-c", "true"]);',
	] },
	{ name: "a column-0 win32 if that exits guards the rest", flags: [], lines: [
		'if (process.platform === "win32") {',
		'	console.log("smoke skipped on Windows");',
		"	process.exit(0);",
		"}",
		...filler,
		'spawn("/bin/sh", ["-c", "true"]);',
	] },
];
for (const { name, lines, flags } of cases) {
	const got = findingsIn(lines).map((finding) => Number(finding.split(":")[0]));
	if (got.join(",") !== flags.join(",")) {
		console.error(`portability lint: its own case "${name}" flags lines [${got.join(", ")}], expected [${flags.join(", ")}]; a pattern is broken`);
		process.exit(1);
	}
}

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const self = path.basename(fileURLToPath(import.meta.url));
const files = process.argv.length > 2
	? process.argv.slice(2)
	: fs.readdirSync(scriptsDir).filter((name) => name.endsWith("-smoke.ts") && name !== self).sort().map((name) => path.join(scriptsDir, name));
const all = files.flatMap((file) => findingsIn(fs.readFileSync(file, "utf8").split("\n")).map((finding) => `${file}:${finding}`));
if (all.length > 0) {
	console.error(`portability lint: ${all.length} line(s) would break on Windows or as root. Guard each one, or mark a reviewed line with "portability-ok: <why>":`);
	for (const finding of all) console.error(`  ${finding}`);
	process.exit(1);
}
console.log(`portability lint smoke passed (${cases.length} own cases, ${files.length} files)`);
