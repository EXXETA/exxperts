// The smoke runner skips the drive flush in the smokes and the processes they
// start (smoke-no-flush-preload.mjs says why and how). This smoke fails when a
// run loses it, so a slower battery shows, and holds its walls: a home outside
// the smokes' temp folder refuses it, the smokes on the list keep the real
// flush, and neither the bundled server, the files shipped beside it nor the
// built page name it. Run it through the runner:
// `npm run smokes -- smoke-no-flush`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
// @ts-expect-error -- the release bundler has no type declarations
import { BUNDLE_ASSETS, EXTERNAL_PACKAGES, loadRewritesPlugin } from "../../../scripts/bundle-server.mjs";
// @ts-expect-error -- a plain JavaScript preload, without type declarations
import { KEEP_REAL_FLUSH, noFlushNodeOptions, SKIPPED_FLUSHES } from "./smoke-no-flush-preload.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..", "..", "..");
const PRELOAD = "smoke-no-flush-preload";
const SMOKE = "smoke-no-flush-smoke.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const skippedNow = (): number | undefined => (globalThis as Record<symbol, { calls: number } | undefined>)[SKIPPED_FLUSHES]?.calls;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-no-flush-"));

try {
	// 1. On in this smoke: a safe write and a flushed append land their bytes,
	// and each of their flushes was skipped (Windows flushes no folder).
	{
		const before = skippedNow();
		assert(before !== undefined, `no flush is skipped in this smoke: run it through the runner (npm run smokes -- smoke-no-flush), which loads ${PRELOAD}.mjs into every smoke not on its list`);
		const { appendFileFlushed, writeFileAtomic } = await import("@exxeta/exxperts-runtime");
		const saved = path.join(tempRoot, "saved.json");
		const log = path.join(tempRoot, "log.jsonl");
		writeFileAtomic(saved, "the saved bytes");
		appendFileFlushed(log, "a line\n");
		assert(fs.readFileSync(saved, "utf-8") === "the saved bytes" && fs.readFileSync(log, "utf-8") === "a line\n", "the writes landed their bytes");
		const flushes = process.platform === "win32" ? 2 : 3;
		assert(skippedNow() === before + flushes, `the file, its folder and the append skip their ${flushes} flushes, skipped ${skippedNow()! - before}`);
		let closed: string | undefined;
		try {
			fs.fsyncSync(1_000_000);
		} catch (error) {
			closed = (error as NodeJS.ErrnoException).code;
		}
		assert(closed === "EBADF", `a flush of no open file fails as the real one does, got ${closed}`);
		console.log("on: this smoke skips its flushes, and the bytes land");
	}

	// 2. A process the smoke starts with its own home, as a smoke's server
	// does, gets the no-op from the smoke's NODE_OPTIONS. With the temp folder
	// named in the option, a home inside it skips its flushes and a home beside
	// it refuses to start; the smoke makes both, wherever the checkout sits.
	{
		const probe = `import fs from "node:fs"; const fd = fs.openSync(process.argv[1], "w"); fs.fsyncSync(fd); fs.closeSync(fd); console.log("skipped " + globalThis[Symbol.for("exxperts.smoke-no-flush.skipped")]?.calls);`;
		const start = (home: string, nodeOptions = process.env.NODE_OPTIONS) => spawnSync(process.execPath, ["--input-type=module", "-e", probe, path.join(tempRoot, "probe")], { env: { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: nodeOptions }, encoding: "utf-8" });
		const child = start(fs.mkdtempSync(path.join(tempRoot, "home-")));
		assert(child.status === 0 && child.stdout.trim() === "skipped 1", `a process the smoke starts skips its flush, got ${child.status}: ${child.stdout}${child.stderr}`);
		const smokesTemp = fs.mkdtempSync(path.join(tempRoot, "temp-"));
		const elsewhere = fs.mkdtempSync(path.join(tempRoot, "elsewhere-"));
		const options = noFlushNodeOptions("", SMOKE, smokesTemp);
		const inside = start(fs.mkdtempSync(path.join(smokesTemp, "home-")), options);
		assert(inside.status === 0 && inside.stdout.trim() === "skipped 1", `a process with its home in the temp folder skips its flush, got ${inside.status}: ${inside.stdout}${inside.stderr}`);
		const outside = start(elsewhere, options);
		assert(outside.status !== 0 && outside.stderr.includes(`${PRELOAD}.mjs refused: the home ${elsewhere} is not inside the smokes' temp folder ${smokesTemp}`), `a process with its home outside the temp folder refuses to start, got ${outside.status}: ${outside.stdout}${outside.stderr}`);
		console.log("homes: a started process skips the flush; a home in the temp folder skips it, one beside it refuses");
	}

	// 3. The list: these smokes run with the real flush, and every other one,
	// this one too, gets the no-op.
	{
		assert(JSON.stringify(KEEP_REAL_FLUSH) === JSON.stringify(["folder-contract-smoke.ts", "folder-contract-faults-smoke.ts", "room-state-message-smoke.ts"]), `the list of smokes with the real flush changed: ${KEEP_REAL_FLUSH.join(", ")}`);
		for (const name of KEEP_REAL_FLUSH as string[]) {
			assert(fs.existsSync(path.join(scriptDir, name)), `${name} is on the list but is no smoke`);
			assert(noFlushNodeOptions("--stack-trace-limit=0", name, os.tmpdir()) === "--stack-trace-limit=0", `${name} keeps its NODE_OPTIONS as they are`);
		}
		const options: string = noFlushNodeOptions("--stack-trace-limit=0", SMOKE, os.tmpdir());
		const loaded = new URL(options.split("--import=")[1] ?? "file:///none");
		assert(options.startsWith("--stack-trace-limit=0 --import=") && fileURLToPath(loaded) === path.join(scriptDir, `${PRELOAD}.mjs`) && loaded.searchParams.get("temp") === os.tmpdir(), `any other smoke keeps its NODE_OPTIONS and loads the no-op with the temp folder: ${options}`);
		console.log(`list: ${KEEP_REAL_FLUSH.length} smokes keep the real flush`);
	}

	// 4. Neither the server, bundled as the release bundles it, nor the files
	// shipped beside it, nor the built page name the preload.
	{
		const assets = BUNDLE_ASSETS as { file: string; entry?: string; source?: string; outside?: string[] }[];
		const build = await esbuild.build({
			absWorkingDir: root,
			entryPoints: { server: "apps/web-server/src/index.ts", ...Object.fromEntries(assets.filter((asset) => asset.entry).map((asset) => [asset.file.replace(/\.mjs$/, ""), asset.entry!])) },
			outdir: path.join(tempRoot, "bundle"),
			outExtension: { ".js": ".mjs" },
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			tsconfigRaw: { compilerOptions: { target: "ES2022" } },
			external: [...(EXTERNAL_PACKAGES as { name: string }[]).map((pkg) => pkg.name), ...assets.flatMap((asset) => asset.outside ?? [])],
			plugins: [loadRewritesPlugin()],
			write: false,
			logLevel: "silent",
		});
		const shipped = [
			...build.outputFiles.map((file) => ({ name: path.basename(file.path), text: file.text })),
			...assets.filter((asset) => asset.source).map((asset) => ({ name: asset.file, text: fs.readFileSync(path.join(root, asset.source!), "utf-8") })),
		];
		const page = path.join(root, "apps", "web-ui", "dist");
		assert(fs.existsSync(path.join(page, "index.html")), "the page is not built: run the root npm run build first");
		for (const entry of fs.readdirSync(page, { recursive: true, withFileTypes: true })) {
			if (entry.isFile() && /\.(html|js|mjs|css|json|webmanifest|map)$/.test(entry.name)) shipped.push({ name: path.relative(root, path.join(entry.parentPath, entry.name)), text: fs.readFileSync(path.join(entry.parentPath, entry.name), "utf-8") });
		}
		const server = shipped.find((file) => file.name === "server.mjs");
		assert(server?.text.includes("function writeFileAtomic("), "the bundled server holds the safe write, so this scan reads the real thing");
		const naming = shipped.filter((file) => file.text.includes(PRELOAD)).map((file) => file.name);
		assert(naming.length === 0, `the release would ship the name ${PRELOAD}: ${naming.join(", ")}`);
		console.log(`shipped: none of ${shipped.length} bundled, shipped-beside or page files names the preload`);
	}
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("smoke-no-flush smoke: passed");
