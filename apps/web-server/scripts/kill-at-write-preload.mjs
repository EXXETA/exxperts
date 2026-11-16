// Loaded by kill-at-write-smoke.ts into a child server: counts the write calls
// the server makes inside its data folder and, once armed, kills the process
// at one of them, as a power cut or `kill -9` would.
//
// KILL_ROOT   only writes under this folder count
// KILL_ARM    counting starts once this file exists, so boot writes stay out
// KILL_TRACE  each counted step is appended here as one line of JSON
//
// A call that cannot change the disk is no step: a folder that exists already,
// a file already gone. An fsync is traced, for its order, but a process kill
// cannot tell it from the step before, so it is never killed at.
// KILL_STEP   the step to die at; unset or 0 only traces
// KILL_HOW    before: the step never happens. after: it happens in full.
//             torn-empty, torn-half: a write gets none or half of its bytes.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const root = path.resolve(process.env.KILL_ROOT ?? "");
const armFile = process.env.KILL_ARM ?? "";
const traceFile = process.env.KILL_TRACE ?? "";
const killStep = Number(process.env.KILL_STEP ?? 0);
const how = process.env.KILL_HOW ?? "before";

const real = {};
for (const name of ["appendFileSync", "closeSync", "copyFileSync", "existsSync", "fsyncSync", "ftruncateSync", "linkSync", "mkdirSync", "openSync", "renameSync", "rmSync", "rmdirSync", "symlinkSync", "truncateSync", "unlinkSync", "writeFileSync", "writeSync"]) real[name] = fs[name];
const realPromises = {};
for (const name of ["appendFile", "copyFile", "mkdir", "rename", "rm", "unlink", "writeFile"]) realPromises[name] = fs.promises[name];

const openForWrite = new Map();
const openFolders = new Map();
let step = 0;

const inRoot = (target) => {
	if (typeof target !== "string" && !(target instanceof URL)) return false;
	const resolved = path.resolve(String(target));
	return resolved === root || resolved.startsWith(root + path.sep);
};

function die() {
	process.kill(process.pid, "SIGKILL");
	// A signal to itself lands at once; nothing may run on if it is late.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

/** The cut part of a write: none or half of its bytes, whatever they came as. */
function cut(data) {
	const bytes = Buffer.from(typeof data === "string" ? data : data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
	return how === "torn-half" ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes.subarray(0, 0);
}

/** Counts one step; `tear` writes the cut part of its bytes, for steps that carry bytes. */
function count(op, target, tear, from) {
	if (!real.existsSync(armFile)) return false;
	step += 1;
	if (traceFile) real.appendFileSync(traceFile, `${JSON.stringify({ step, op, target: String(target), bytes: tear !== undefined, ...(from ? { from: String(from) } : {}) })}\n`);
	if (step !== killStep) return false;
	if (how === "after") return true;
	if (how !== "before" && tear) tear();
	die();
	return false;
}

function pathStep(name) {
	fs[name] = function (...args) {
		const changes = name === "mkdirSync" ? !real.existsSync(args[0]) : real.existsSync(args[0]);
		const lands = inRoot(args[0]) && changes && count(name, args[0]);
		const result = real[name].apply(fs, args);
		if (lands) die();
		return result;
	};
}

function renameStep(name) {
	fs[name] = function (from, to, ...rest) {
		const lands = inRoot(to) && count(name, to, undefined, from);
		const result = real[name].call(fs, from, to, ...rest);
		if (lands) die();
		return result;
	};
}

for (const name of ["mkdirSync", "rmSync", "rmdirSync", "truncateSync", "unlinkSync"]) pathStep(name);
for (const name of ["copyFileSync", "linkSync", "renameSync", "symlinkSync"]) renameStep(name);

fs.openSync = function (target, flags = "r", ...rest) {
	const writes = typeof flags === "string" ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
	const counted = writes && inRoot(target);
	const lands = counted && count("openSync", target);
	const fd = real.openSync.call(fs, target, flags, ...rest);
	if (lands) die();
	if (counted) openForWrite.set(fd, String(target));
	else if (inRoot(target)) openFolders.set(fd, String(target));
	return fd;
};

fs.closeSync = function (fd) {
	openForWrite.delete(fd);
	openFolders.delete(fd);
	return real.closeSync.call(fs, fd);
};

fs.fsyncSync = function (fd) {
	const target = openForWrite.get(fd) ?? openFolders.get(fd);
	if (target !== undefined) count("fsyncSync", target);
	return real.fsyncSync.call(fs, fd);
};

fs.ftruncateSync = function (fd, ...rest) {
	const target = openForWrite.get(fd);
	const lands = target !== undefined && count("ftruncateSync", target);
	const result = real.ftruncateSync.call(fs, fd, ...rest);
	if (lands) die();
	return result;
};

fs.writeSync = function (fd, data, ...rest) {
	const target = openForWrite.get(fd);
	const lands = target !== undefined && count("writeSync", target, () => real.writeSync.call(fs, fd, cut(data)));
	const result = real.writeSync.call(fs, fd, data, ...rest);
	if (lands) die();
	return result;
};

fs.writeFileSync = function (target, data, options) {
	const known = typeof target === "number" ? openForWrite.get(target) : inRoot(target) ? String(target) : undefined;
	const lands = known !== undefined && count("writeFileSync", known, () => real.writeFileSync.call(fs, target, cut(data), options));
	const result = real.writeFileSync.call(fs, target, data, options);
	if (lands) die();
	return result;
};

fs.appendFileSync = function (target, data, options) {
	const known = typeof target === "number" ? openForWrite.get(target) : inRoot(target) ? String(target) : undefined;
	const lands = known !== undefined && count("appendFileSync", known, () => real.appendFileSync.call(fs, target, cut(data), options));
	const result = real.appendFileSync.call(fs, target, data, options);
	if (lands) die();
	return result;
};

// Promise writes: one step each, whole or not at all at this level.
for (const name of Object.keys(realPromises)) {
	fs.promises[name] = async function (target, ...rest) {
		const named = name === "rename" || name === "copyFile" ? rest[0] : target;
		const lands = inRoot(named) && count(`promises.${name}`, named);
		const result = await realPromises[name].call(fs.promises, target, ...rest);
		if (lands) die();
		return result;
	};
}

syncBuiltinESMExports();
