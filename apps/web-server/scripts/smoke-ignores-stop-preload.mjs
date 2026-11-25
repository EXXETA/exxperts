// Loaded with --import into a server the stop smokes start, so that Stop meets
// what it can't end: a model call whose message carries DEAF_STREAM_MARKER
// or DEAF_JOB_MARKER never hears its abort, and once the file SMOKE_KILLS_OFF_FILE names exists,
// the kills of a Stop do nothing, so a command runs on. Only for a while after
// the first one: what ends with the turn is ended, and nothing is left running.
// While the file SMOKE_PARSER_HELD_FILE names exists, a document's parser has
// answered and nobody has heard it yet.
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => (typeof init?.body === "string" && /DEAF_(STREAM|JOB)_MARKER/.test(init.body) ? realFetch(input, { ...init, signal: undefined }) : realFetch(input, init));

const killsOff = process.env.SMOKE_KILLS_OFF_FILE;
const KILLS_OFF_MS = 3_500;
let firstIgnoredAt = 0;
const killHeld = () => {
	if (!killsOff || !fs.existsSync(killsOff) || (firstIgnoredAt && Date.now() - firstIgnoredAt >= KILLS_OFF_MS)) return false;
	firstIgnoredAt ||= Date.now();
	return true;
};
const realKill = process.kill.bind(process);
process.kill = (pid, signal) => (pid < 0 && signal !== 0 && killHeld() ? true : realKill(pid, signal));
// On Windows a Stop ends a command's tree with taskkill, not a process-group kill.
if (killsOff) {
	const realSpawn = childProcess.spawn;
	childProcess.spawn = (command, ...rest) => (command === "taskkill" && killHeld() ? new EventEmitter() : realSpawn(command, ...rest));
	syncBuiltinESMExports();
}

const parserHeld = process.env.SMOKE_PARSER_HELD_FILE;
if (parserHeld) {
	const realFork = childProcess.fork;
	childProcess.fork = (script, ...rest) => {
		const child = realFork(script, ...rest);
		if (!String(script).includes("shelf-parse-worker")) return child;
		const realOnce = child.once.bind(child);
		const heard = (call) => (fs.existsSync(parserHeld) ? setTimeout(() => heard(call), 20) : call());
		child.once = (event, listener) => realOnce(event, (...args) => {
			if (event === "message") fs.writeFileSync(`${parserHeld}.answered`, "");
			if (event === "message" || event === "exit") heard(() => listener(...args));
			else listener(...args);
		});
		return child;
	};
	syncBuiltinESMExports();
}
