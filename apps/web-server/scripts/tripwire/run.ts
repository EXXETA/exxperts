// One tripwire run, in one process: `mac` (the Mac box on), `win32` (Windows
// mode, the server's fence) or `moved` (Windows mode with the agent folder, the
// connector settings and the rooms' data moved by their settings). Started by
// server-touch-tripwire-smoke.ts with the recorder loaded by --import and
// TRIPWIRE_ROOT naming the fresh test computer.
//
// In order: the positive control (each planted call must be recorded at the
// room, or the run is blind and stops), the server in this process, the drive,
// the sweep of every route the drive didn't reach, then the verdict.
import fs from "node:fs";
import path from "node:path";

import { freePort, SMOKE_SERVER_AUTH_ENV } from "../smoke-server-process.js";
import { assert, client, waitUntil } from "./client.js";
import { defaultImportNative, namedPromisesImport, namedSyncImports, startInFolder } from "./control.js";
import { drive } from "./drive.js";
import { RUN_NAMES } from "./inventory.js";
import { KNOWN_SITES, type Run } from "./known-sites.js";
import { layout, plant } from "./layout.js";
import { startGateway } from "./model.js";
import { framesOf, recorder, siteOf } from "./records.js";
import { NAMED_ROUTES, NAMED_TOOLS, NOT_ON_MAIN, SWEPT_ROUTES, sweep } from "./routes.js";
import { judge, registeredRoutes, sitesOf, uncovered } from "./verdict.js";

const run = process.argv[2] as Run;
if (run !== "mac" && run !== "win32" && run !== "moved") throw new Error(`a run is mac, win32 or moved, got ${run}`);
const at = layout(process.env.TRIPWIRE_ROOT ?? "", run);
const state = recorder();
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const fails: string[] = [];
const label = RUN_NAMES[run];
const say = (line: string) => console.log(`    [${label}] ${line}`);

plant(at);

// --- The positive control: blind here means blind everywhere, so nothing else is judged.
const planted = path.join(at.live, "planted.txt");
// Each planted call, by the import form it uses, and where the recorder must see it.
const CONTROL = [
	{ call: "existsSync", fn: "namedSyncImports" },
	{ call: "readFileSync", fn: "namedSyncImports" },
	{ call: "promises.stat", fn: "namedPromisesImport" },
	{ call: "realpathSync.native", fn: "defaultImportNative" },
	{ call: "child_process.spawn", fn: "startInFolder" },
];
state.records.length = 0;
namedSyncImports(planted);
await namedPromisesImport(planted);
defaultImportNative(planted);
await startInFolder(planted);
const seen = (one: (typeof CONTROL)[number]) => state.records.some((record) => record.call === one.call && siteOf(framesOf(record.stack), record.route).fn === one.fn && record.paths.some((touched) => touched === planted || touched === at.live));
const blind = CONTROL.filter((one) => !seen(one));
if (blind.length > 0) {
	console.log(`    [${label}] FAIL the positive control: the recorder never saw ${blind.map((one) => `${one.call} (${one.fn})`).join(", ")} at the test room, so it is blind and nothing else is judged`);
	process.exit(1);
}
say(`ok   the positive control: all ${CONTROL.length} planted calls recorded at the test room`);
state.records.length = 0;

// --- The server, in this process, on the test computer.
const gateway = await startGateway(at.agentDir, at.appRoot);
const port = await freePort();
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_REAL_HOME", "EXXPERTS_TEST_SHELL_PLATFORM", "PI_CODING_AGENT_DIR"]) delete process.env[name];
// Windows mode finds Git Bash where Windows keeps it, `<ProgramFiles>\Git\bin\bash.exe`: on a Mac, one file beside the folder.
fs.symlinkSync("/bin/bash", `${at.programFiles}\\Git\\bin\\bash.exe`);
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, {
	HOME: at.home,
	USERPROFILE: at.home,
	// The move's intent goes to the login home, which is otherwise the account's real one, outside the test computer.
	EXXPERTS_LOGIN_HOME: at.home,
	TMPDIR: at.sharedTemp,
	PORT: String(port),
	EXXETA_HOME: repoRoot,
	EXXPERTS_CODING_AGENT_DIR: at.agentDir,
	EXXETA_PERSISTENT_AGENTS_ROOT: at.agentsRoot,
	EXXPERTS_TEST_INTROSPECTION: "1",
	EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1",
	EXXPERTS_SKILLS_FEATURED_SOURCES: JSON.stringify([{ source: at.skillRepo, author: "tripwire" }]),
	EXXPERTS_SWITCH_SUPERVISED: "1",
	EXXPERTS_HOME_MOVE_SUPERVISED: "1",
	EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS: "1000",
	EXXPERTS_SCHEDULER_EXECUTION_LOOP_INTERVAL_MS: "1000",
	LOG_LEVEL: "fatal",
	...(run === "mac" ? {} : { EXXPERTS_TEST_SHELL_PLATFORM: "win32", ProgramFiles: at.programFiles }),
	...(run === "moved" ? { PI_CODING_AGENT_DIR: at.connectorDir } : {}),
});
await import("../../src/index.js");
await waitUntil(() => fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok, () => false), "the server is up", 60_000);
const api = client(port, gateway);

// --- The drive, then the sweep.
const startedAt = Date.now();
const step = async (name: string, body: () => Promise<void>) => {
	const began = Date.now();
	try {
		await body();
		say(`ok   ${name} (${((Date.now() - began) / 1000).toFixed(1)} s)`);
	} catch (error) {
		fails.push(`a drive step failed, so it drove nothing: ${name}: ${(error as Error).message}`);
		say(`FAIL ${name}: ${(error as Error).message}`);
	}
};
const driven = await drive(run, at, api, gateway, step);
for (const line of NOT_ON_MAIN) say(`not driven: ${line}: comes with the Windows step that builds it`);
for (const line of driven.placeRooms) say(`a room set ${line}`);
const routes = registeredRoutes(state);
const swept = await sweep(api, SWEPT_ROUTES.filter((route) => routes.includes(route) && !state.reached.has(route)), driven.params);
say(`the sweep called ${swept.length} more routes: ${swept.join(", ")}`);

// Last, since it ends the server: a data folder move applied to a room's folder, which adopts the `.exxperts` planted there.
// The exit it asks for is held, so the verdict still runs; the route's own work is all done before it answers.
const exit = process.exit.bind(process);
const askedExit: number[] = [];
process.exit = ((code?: number) => void askedExit.push(code ?? 0)) as typeof process.exit;
await step("a data folder move applied to a room's folder, adopting the data planted there", async () => {
	await api.must("POST", "/api/settings/state-home/apply", { dir: at.live });
	await waitUntil(() => askedExit.length > 0, "the server asked to end", 5_000);
	const intent = JSON.parse(fs.readFileSync(path.join(at.home, ".exxperts.home-move.json"), "utf8"));
	assert(intent.mode === "adopt" && intent.to === at.live, `the move's intent in the test home: ${JSON.stringify(intent)}`);
});
say(`the drive took ${Math.round((Date.now() - startedAt) / 1000)} s`);

// --- The verdict.
const rooms = driven.roomFolders;
const sites = sitesOf(state, at, rooms);
fails.push(...uncovered("route", routes, state.reached, NAMED_ROUTES));
for (const route of SWEPT_ROUTES) if (!routes.includes(route)) fails.push(`the sweep names a route that no longer exists: ${route}`);
fails.push(...uncovered("tool", [...gateway.offered].sort(), gateway.called, NAMED_TOOLS));
fails.push(...judge(sites, KNOWN_SITES, run));
if (process.env.TRIPWIRE_SITES) fs.writeFileSync(process.env.TRIPWIRE_SITES, JSON.stringify(sites.map((site) => ({ ...site, tree: site.tree.name, listed: site.tree.listed, why: site.tree.why, paths: [...site.paths], routes: [...site.routes] }))));
for (const fail of fails) say(`FAIL ${fail}`);
say(`${sites.length} sites recorded, ${sites.filter((site) => site.tree.listed).length} in a listed tree; ${fails.length} fail(s)`);
gateway.close();
exit(fails.length > 0 ? 1 : 0);
