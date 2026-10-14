// The local search engine catches up with the pinned image and settings.
//
// Search sites keep changing their pages, so a SearXNG image left on an old
// pin slowly returns nothing. The helper pins a newer one and turns Bing and
// Yahoo on, and an engine set up before that has to follow without anyone
// opening a terminal: its next start, or the app's own update when it starts,
// replaces the container. This drives the real helper against a stub engine
// and proves that the new image is downloaded before the old container goes,
// that a failed download keeps the old one, that the settings keep their
// secret key, that a settings file someone wrote themselves and a container
// another data folder owns are left alone, and that update never starts an
// engine that is not running. Then it proves the app asks for the update only
// when its saved local engine answers, and that the screen waits long enough
// for an engine whose slowest search site takes SearXNG's full 3 s.
//
// Run: node scripts/run-smokes.mjs searxng-image-update

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const helper = path.join(repoRoot, "scripts", "searxng.mjs");

if (process.platform === "win32") {
	console.log("searxng image update smoke skipped: the stub engine is a shell script, which Windows cannot run");
	process.exit(0);
}

const OLD_SETTINGS = `use_default_settings: true

server:
  secret_key: "same-as-before"
  limiter: false
  public_instance: false

search:
  formats:
    - html
    - json
`;

// A stand-in engine: answers the search and health probes the helper and the
// app make, so "ready" means something was really asked.
let healthStatus = 200;
const engine = http.createServer((req, res) => {
	if (req.url?.startsWith("/healthz")) {
		res.writeHead(healthStatus);
		res.end("OK");
		return;
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ results: [] }));
});
await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
const enginePort = String((engine.address() as AddressInfo).port);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-searxng-update-"));

type Case = {
	home: string;
	state: string;
	settings: string;
	calls: () => string[];
};

/**
 * A data folder plus a stub engine whose state lives in files: exists,
 * running, the container's image id and settings mount, whether the pinned
 * image is already here, whether a download fails.
 */
function makeCase(name: string, setup: { container?: "running" | "stopped"; image?: "old" | "new"; pulled?: boolean; pullFails?: boolean; mount?: "ours" | "other" | "translated"; label?: "ours" | "other"; oldImageTagged?: boolean; settings?: string }): Case {
	const home = path.join(tempRoot, name);
	const state = path.join(home, "engine-state");
	fs.mkdirSync(state, { recursive: true });
	const settings = path.join(home, ".exxperts", "app", "searxng", "settings.yml");
	if (setup.settings !== undefined) {
		fs.mkdirSync(path.dirname(settings), { recursive: true });
		fs.writeFileSync(settings, setup.settings);
	}
	if (setup.container) {
		fs.writeFileSync(path.join(state, "exists"), "");
		if (setup.container === "running") fs.writeFileSync(path.join(state, "running"), "");
		fs.writeFileSync(path.join(state, "container-image"), `sha256:${setup.image ?? "old"}\n`);
		// "translated" is how an engine on Windows reports the file: a path its
		// Linux machine sees, which no comparison of paths can tell is ours.
		const source = setup.mount === "other" ? path.join(home, "someone-else.yml") : setup.mount === "translated" ? "/run/desktop/mnt/host/x/elsewhere/settings.yml" : settings;
		fs.writeFileSync(path.join(state, "mount"), `/var/lib/volume/_data\n${source}\n`);
		if (setup.label) fs.writeFileSync(path.join(state, "label"), `${setup.label === "ours" ? settings : path.join(home, "someone-else.yml")}\n`);
	}
	if (setup.oldImageTagged) fs.writeFileSync(path.join(state, "old-tags"), "1\n");
	if (setup.pulled) fs.writeFileSync(path.join(state, "pulled"), "");
	if (setup.pullFails) fs.writeFileSync(path.join(state, "pull-fails"), "");
	const S = `'${state}'`;
	fs.writeFileSync(path.join(state, "docker"), `#!/bin/sh
echo "$*" >> ${S}/calls
case "$1" in
	info) exit 0 ;;
	ps)
		if [ "$2" = "-a" ]; then [ -f ${S}/exists ] && echo exxperts-searxng; else [ -f ${S}/running ] && echo exxperts-searxng; fi
		exit 0 ;;
	container)
		[ -f ${S}/exists ] || exit 1
		case "$5" in *Labels*) cat ${S}/label 2>/dev/null || echo "<no value>" ;; esac
		case "$5" in
			*Mounts*) cat ${S}/mount ;;
			*Labels*) ;;
			*) cat ${S}/container-image ;;
		esac
		exit 0 ;;
	image)
		if [ "$2" = inspect ]; then
			case "$5" in *RepoTags*) cat ${S}/old-tags 2>/dev/null || echo 0; exit 0 ;; esac
			[ -f ${S}/pulled ] && { echo sha256:new; exit 0; }; exit 1
		fi
		exit 0 ;;
	pull)
		[ -f ${S}/pull-fails ] && { echo "network unreachable" >&2; exit 1; }
		: > ${S}/pulled; exit 0 ;;
	rm) rm -f ${S}/exists ${S}/running; exit 0 ;;
	run)
		: > ${S}/exists; : > ${S}/running; echo sha256:new > ${S}/container-image
		printf '%s\\n' '${settings}' > ${S}/mount
		for arg in "$@"; do case "$arg" in exxperts.searxng.settings=*) printf '%s\\n' "\${arg#exxperts.searxng.settings=}" > ${S}/label ;; esac; done
		exit 0 ;;
	start|restart) : > ${S}/running; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
	return {
		home,
		state,
		settings,
		calls: () => {
			const file = path.join(state, "calls");
			return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
		},
	};
}

function helperRun(c: Case, command: string): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [helper, command], {
			env: {
				HOME: c.home,
				EXXPERTS_STATE_HOME: c.home,
				PATH: "/usr/bin:/bin",
				SEARXNG_CONTAINER_CLI: path.join(c.state, "docker"),
				SEARXNG_PORT: enginePort,
			},
		});
		let out = "";
		child.stdout.on("data", (d) => { out += String(d); });
		child.stderr.on("data", (d) => { out += String(d); });
		child.on("close", (code) => resolve({ code, out }));
	});
}

const has = (calls: string[], prefix: string) => calls.some((line) => line.startsWith(prefix));
const pulls = (calls: string[]) => calls.filter((line) => line.startsWith("pull ")).length;

try {
	// An engine set up on the old pin, started from the app's button.
	{
		const c = makeCase("old-start", { container: "running", settings: OLD_SETTINGS });
		const { code, out } = await helperRun(c, "start");
		const calls = c.calls();
		assert(code === 0, `start on an old image exits 0, got ${code}: ${out}`);
		const pullAt = calls.findIndex((line) => line.startsWith("pull "));
		const rmAt = calls.findIndex((line) => line.startsWith("rm "));
		assert(pullAt >= 0 && rmAt > pullAt, `the new image is downloaded before the old container goes: ${calls.join(" | ")}`);
		assert(calls[pullAt].includes("sha256:cc026dbee25b864d7f9731957cd5ef36ba2e2d61abd2996d57f1b863483e7409"), `the pinned image is 2026.10.7: ${calls[pullAt]}`);
		assert(calls[rmAt] === "rm -f -v exxperts-searxng", `the old container goes with its unnamed volumes: ${calls[rmAt]}`);
		assert(has(calls, "run -d --name exxperts-searxng"), "a new container is created");
		assert(calls.some((line) => line.startsWith("run ") && line.includes(`--label exxperts.searxng.settings=${c.settings}`)), "the new container names its settings file in a label");
		assert(has(calls, "image rm sha256:old"), "the old image is cleaned up");
		const text = fs.readFileSync(c.settings, "utf8");
		assert(text.startsWith(OLD_SETTINGS), "the old settings, secret key included, are kept as they were");
		assert(/^engines:\n {2}- name: bing\n {4}disabled: false\n {2}- name: yahoo\n {4}disabled: false\n/m.test(text), `bing and yahoo are switched on:\n${text}`);
		assert(/ready at/i.test(out), "the helper says where search is ready");
	}

	// The same engine, updated by the app when it starts.
	{
		const c = makeCase("old-update", { container: "running", settings: OLD_SETTINGS });
		const { code, out } = await helperRun(c, "update");
		const calls = c.calls();
		assert(code === 0, `update exits 0, got ${code}: ${out}`);
		assert(pulls(calls) === 1 && has(calls, "rm -f -v") && has(calls, "run -d"), `update replaces an old container: ${calls.join(" | ")}`);
		assert(/ready at/i.test(out), "update says where search is ready");
		const again = await helperRun(c, "update");
		const after = c.calls().slice(calls.length);
		assert(again.code === 0 && !has(after, "pull ") && !has(after, "rm ") && !has(after, "run ") && !has(after, "restart"), `a second update finds nothing to do: ${after.join(" | ")}`);
		assert(/up to date/i.test(again.out) && !/ready at/i.test(again.out), `and says so without a test search: ${again.out}`);
		const once = fs.readFileSync(c.settings, "utf8").match(/^engines:/gm) ?? [];
		assert(once.length === 1, "the engines are added once, not again");
	}

	// The download fails: the old container keeps answering.
	{
		const c = makeCase("pull-fails", { container: "running", settings: OLD_SETTINGS, pullFails: true });
		const { code, out } = await helperRun(c, "start");
		const calls = c.calls();
		assert(code === 0, `a failed download still leaves a working start, got ${code}: ${out}`);
		assert(pulls(calls) === 1 && !has(calls, "rm ") && !has(calls, "run "), `nothing is removed when the download fails: ${calls.join(" | ")}`);
		assert(/keeping the current one/i.test(out), "the helper says it kept the current version");
	}

	// A stopped engine on the old pin: update leaves it alone, start replaces it.
	{
		const c = makeCase("stopped", { container: "stopped", settings: OLD_SETTINGS });
		const update = await helperRun(c, "update");
		assert(update.code === 0 && /nothing to update/i.test(update.out), `update leaves a stopped engine alone: ${update.out}`);
		assert(!has(c.calls(), "pull ") && !has(c.calls(), "run ") && !has(c.calls(), "start"), `update starts nothing: ${c.calls().join(" | ")}`);
		assert(fs.readFileSync(c.settings, "utf8") === OLD_SETTINGS, "update does not touch the settings of an engine it leaves alone");
		const start = await helperRun(c, "start");
		assert(start.code === 0 && has(c.calls(), "rm -f -v") && has(c.calls(), "run -d"), `start replaces a stopped old container: ${c.calls().join(" | ")}`);
	}

	// Never set up: update creates nothing.
	{
		const c = makeCase("none", {});
		const { code, out } = await helperRun(c, "update");
		assert(code === 0 && /nothing to update/i.test(out), `update with no container says so: ${out}`);
		assert(!has(c.calls(), "run ") && !fs.existsSync(c.settings), "update creates no container and no settings");
	}

	// A container that reads another data folder's settings is not taken over.
	{
		const c = makeCase("other-folder", { container: "running", mount: "other", settings: OLD_SETTINGS });
		const { code } = await helperRun(c, "update");
		const calls = c.calls();
		assert(code === 0 && !has(calls, "pull ") && !has(calls, "rm ") && !has(calls, "run ") && !has(calls, "restart"), `another folder's container is left alone: ${calls.join(" | ")}`);
		assert(fs.readFileSync(c.settings, "utf8") === OLD_SETTINGS, "and this folder's settings are not changed for it");
	}

	// A container whose mount the engine reports in another spelling (as on
	// Windows) is still recognised by its label.
	{
		const c = makeCase("label", { container: "running", mount: "translated", label: "ours", settings: OLD_SETTINGS });
		await helperRun(c, "update");
		assert(has(c.calls(), "rm -f -v") && has(c.calls(), "run -d"), `a labelled container is ours whatever its mount says: ${c.calls().join(" | ")}`);
	}
	{
		const c = makeCase("label-other", { container: "running", mount: "translated", label: "other", settings: OLD_SETTINGS });
		const { out } = await helperRun(c, "update");
		assert(!has(c.calls(), "pull ") && !has(c.calls(), "rm "), `another folder's label is not ours: ${c.calls().join(" | ")}`);
		assert(/another exxperts data folder/i.test(out), `and the helper says why it left it: ${out}`);
	}

	// An old image someone tagged for their own use stays.
	{
		const c = makeCase("tagged", { container: "running", oldImageTagged: true, settings: OLD_SETTINGS });
		await helperRun(c, "update");
		assert(has(c.calls(), "run -d") && !has(c.calls(), "image rm"), `a tagged old image is kept: ${c.calls().join(" | ")}`);
	}

	// Current image, settings from before the engines: the engine re-reads them.
	{
		const c = makeCase("restart", { container: "running", image: "new", pulled: true, settings: OLD_SETTINGS });
		await helperRun(c, "update");
		const calls = c.calls();
		assert(!has(calls, "pull ") && !has(calls, "rm ") && has(calls, "restart exxperts-searxng"), `new settings on a current image restart the container: ${calls.join(" | ")}`);
	}

	// Settings someone wrote themselves stay as they are.
	for (const [name, own] of [
		["own-engines", `${OLD_SETTINGS}\nengines:\n  - name: mojeek\n    disabled: false\n`],
		["own-defaults", OLD_SETTINGS.replace("use_default_settings: true", "use_default_settings: false")],
	] as const) {
		const c = makeCase(name, { container: "running", image: "new", pulled: true, settings: own });
		await helperRun(c, "update");
		assert(fs.readFileSync(c.settings, "utf8") === own, `${name}: the file is untouched`);
		assert(!has(c.calls(), "restart"), `${name}: nothing to re-read, no restart`);
	}

	// A fresh setup gets the engines and a secret of its own.
	{
		const c = makeCase("fresh", {});
		const { code, out } = await helperRun(c, "start");
		assert(code === 0, `a fresh start exits 0: ${out}`);
		const text = fs.readFileSync(c.settings, "utf8");
		assert(/secret_key: "[0-9a-f]{64}"/.test(text) && /- name: bing\n {4}disabled: false/.test(text) && /- name: yahoo\n {4}disabled: false/.test(text), `fresh settings:\n${text}`);
		assert(!has(c.calls(), "pull ") && has(c.calls(), "run -d"), "a fresh start just runs the pinned image");
	}

	// The app asks for the update only when its saved local engine answers.
	{
		const record = path.join(tempRoot, "app-asked");
		const stub = path.join(tempRoot, "helper-stub.mjs");
		fs.writeFileSync(stub, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(record)}, process.argv[2] + "\\n");\nconsole.log("SearXNG ready at http://127.0.0.1:${enginePort}");\n`);
		process.env.EXXPERTS_SEARXNG_SCRIPT = stub;
		process.env.SEARXNG_PORT = enginePort;
		const setup = await import("../src/searxng-setup.js");
		const asked = () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n") : []);
		const settle = async () => {
			for (let i = 0; i < 100; i++) {
				const status = await setup.searxngSetupStatus(repoRoot, null);
				if (!status.running) return status;
				await new Promise((r) => setTimeout(r, 50));
			}
			throw new Error("the update run did not finish");
		};
		const local = `http://127.0.0.1:${enginePort}`;
		assert(await setup.updateSearxngOnBoot(repoRoot, null) === null, "no saved local engine, no update");
		assert(await setup.updateSearxngOnBoot(repoRoot, "https://search.example.com") === null, "an engine elsewhere is not ours to update");
		assert(await setup.updateSearxngOnBoot(repoRoot, "http://127.0.0.1:1") === null, "a local engine on another port is not the helper's");
		healthStatus = 503;
		assert(await setup.updateSearxngOnBoot(repoRoot, local) === null, "an engine that does not answer is not touched");
		assert(asked().length === 0, `nothing was asked so far: ${asked().join(",")}`);
		healthStatus = 200;
		const started = await setup.updateSearxngOnBoot(repoRoot, local);
		assert(started !== null, "an answering local engine gets the update");
		const done = await settle();
		assert(asked().join(",") === "update", `the helper was asked to update, not start: ${asked().join(",")}`);
		assert(done.phase === "ready" && done.baseUrl === local, `the screen reads ready after an update: ${JSON.stringify(done)}`);
	}

	// An engine that takes SearXNG's full 3 s on a slow search site is healthy.
	{
		const slow = http.createServer((_req, res) => {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ results: [] }));
			}, 3100);
		});
		await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
		try {
			const setup = await import("../src/searxng-setup.js");
			const answered = await setup.probeSearxng(`http://127.0.0.1:${(slow.address() as AddressInfo).port}`);
			assert(answered, "an engine answering after 3 s reads as answering, not as silent");
		} finally {
			slow.closeAllConnections();
			slow.close();
		}
	}

	console.log("searxng image update smoke: ok");
} finally {
	engine.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
