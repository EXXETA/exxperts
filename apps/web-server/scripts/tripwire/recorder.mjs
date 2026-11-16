// The tripwire's recorder: loaded with --import before anything of the server
// or the runtime, it wraps every function `node:fs`, `fs.promises` and
// `node:fs/promises` export, the `.native` realpaths included, and
// child_process's starts. Each call whose path, `cwd` or arguments fall under
// TRIPWIRE_WATCH is kept with its stack; every other call passes through
// untouched. TRIPWIRE_WATCH and TRIPWIRE_IGNORE are folder lists joined by the
// path delimiter, where a `*` segment stands for any one name; the longest
// entry a path falls under decides, so an ignored tree can hold a watched one. The list is walked, never typed,
// so a function Node adds is wrapped too. Then module.syncBuiltinESMExports()
// points named imports (`import { existsSync } from "node:fs"`) at the
// wrappers.
//
// It also watches every Fastify instance the process makes, through Fastify's
// own "fastify.initialization" channel: the routes it registers (onRoute) and
// the routes a request reached (onRequest), and each record names the route
// it was made serving, if any.
//
// TRIPWIRE_LEAVE names one wrapper to leave out (such as `existsSync` or
// `child_process.spawn`): the positive control's proof that a blind spot turns
// the smoke red.
//
// What it kept is on globalThis under Symbol.for("exxperts.tripwire"), read by
// scripts/tripwire/run.ts in the same process. It imports only Node's own
// modules, so nothing it loads can reach a path before the wrappers are in.
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const folders = (name) => (process.env[name] ?? "").split(path.delimiter).filter(Boolean).map((root) => path.resolve(root));
const watched = folders("TRIPWIRE_WATCH");
if (watched.length === 0) throw new Error("the tripwire recorder needs TRIPWIRE_WATCH: the folders whose touches it keeps");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rules = [...watched.map((root) => ({ root, keep: true })), ...folders("TRIPWIRE_IGNORE").map((root) => ({ root, keep: false }))]
	.map((rule) => ({ ...rule, test: new RegExp(`^${rule.root.split(path.sep).map((name) => (name === "*" ? `[^${escape(path.sep)}]+` : escape(name))).join(escape(path.sep))}(?:${escape(path.sep)}|$)`) }))
	.sort((a, b) => b.root.length - a.root.length);
const leftOut = process.env.TRIPWIRE_LEAVE ?? "";

const state = { records: [], routes: [], reached: new Set(), wrapped: [] };
globalThis[Symbol.for("exxperts.tripwire")] = state;

const under = (target) => rules.find((rule) => rule.test.test(target))?.keep === true;

/** A path argument as the call reads it: a string, a Buffer or a file URL. A descriptor, a FileHandle or data is none. */
function asPath(value) {
	try {
		if (typeof value === "string") return path.resolve(value);
		if (Buffer.isBuffer(value)) return path.resolve(value.toString("utf8"));
		if (value instanceof URL) return value.protocol === "file:" ? path.resolve(fileURLToPath(value)) : undefined;
	} catch {}
	return undefined;
}

function stack() {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 60;
	const trace = new Error().stack ?? "";
	Error.stackTraceLimit = limit;
	return trace;
}

// The calls whose second argument is a path too: the far end of a copy, a move
// or a link. Every other call's later arguments are data or options.
const TWO_PATHS = new Set(["rename", "copyFile", "link", "symlink", "cp"]);

/** The paths one fs call names; `key` is the export's own name, `glob` reading its options' cwd. */
function fsPaths(key, args) {
	const bare = key.replace(/Sync$/, "");
	const named = [asPath(args[0])];
	if (TWO_PATHS.has(bare)) named.push(asPath(args[1]));
	if (bare === "glob" && args[1] && typeof args[1] === "object") named.push(asPath(args[1].cwd));
	return named.filter((one) => one !== undefined && under(one));
}

// The route whose request led to a call, carried along everything the request starts: a route handler is often an unnamed function.
const serving = new AsyncLocalStorage();

function keep(record) {
	state.records.push({ ...record, route: serving.getStore(), stack: stack() });
}

function wrapFs(original, key, label) {
	const wrapper = new Proxy(original, {
		apply(target, self, args) {
			const touched = fsPaths(key, args);
			if (touched.length > 0) keep({ kind: "fs", call: label, paths: touched });
			return Reflect.apply(target, self, args);
		},
		construct(target, args, newTarget) {
			const touched = fsPaths(key, args);
			if (touched.length > 0) keep({ kind: "fs", call: `new ${label}`, paths: touched });
			return Reflect.construct(target, args, newTarget === wrapper ? target : newTarget);
		},
	});
	return wrapper;
}

/** Every function an object exports, data and accessor alike, with its `.native` form. */
function wrapAll(owner, prefix) {
	for (const key of Object.getOwnPropertyNames(owner)) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		// An accessor with no setter is a constant or the promises API, never a call; reading F_OK's warns.
		if (descriptor.get && !descriptor.set) continue;
		const value = descriptor.get ? descriptor.get.call(owner) : descriptor.value;
		if (typeof value !== "function") continue;
		const label = `${prefix}${key}`;
		if (typeof value.native === "function" && leftOut !== `${label}.native`) {
			value.native = wrapFs(value.native, key, `${label}.native`);
			state.wrapped.push(`${label}.native`);
		}
		if (leftOut === label) continue;
		const wrapper = wrapFs(value, key, label);
		// The stream classes are accessors with a setter, which the fs module itself reads back.
		if (descriptor.set) owner[key] = wrapper;
		else Object.defineProperty(owner, key, { configurable: true, enumerable: descriptor.enumerable, writable: true, value: wrapper });
		state.wrapped.push(label);
	}
}

wrapAll(fs, "");
wrapAll(fs.promises, "promises.");

/** A start's program, its options' cwd, and each argument that names a watched place. */
function startDetails(args) {
	const program = typeof args[0] === "string" ? args[0] : String(asPath(args[0]) ?? args[0]);
	const list = Array.isArray(args[1]) ? args[1].map(String) : [];
	const options = args.find((arg, index) => index > 0 && arg && typeof arg === "object" && !Array.isArray(arg));
	const cwd = options?.cwd === undefined ? undefined : asPath(options.cwd);
	// An argument names a place when the path it holds from its first separator on (`--git-dir=/x`, `cd /x && ls`) is watched.
	const naming = [program, ...list].filter((arg) => arg.includes(path.sep)).map((arg) => path.resolve(arg.slice(arg.indexOf(path.sep)))).filter(under);
	return { program, cwd: cwd !== undefined && under(cwd) ? cwd : undefined, naming };
}

for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	const label = `child_process.${key}`;
	if (leftOut === label) continue;
	childProcess[key] = new Proxy(childProcess[key], {
		apply(target, self, args) {
			const { program, cwd, naming } = startDetails(args);
			if (cwd !== undefined || naming.length > 0) keep({ kind: "start", call: label, program, cwd, paths: [...(cwd === undefined ? [] : [cwd]), ...naming] });
			return Reflect.apply(target, self, args);
		},
	});
	state.wrapped.push(label);
}

module.syncBuiltinESMExports();

diagnostics.subscribe("fastify.initialization", ({ fastify }) => {
	fastify.addHook("onRoute", (route) => {
		for (const method of [route.method].flat()) state.routes.push({ method: String(method), url: route.url });
	});
	fastify.addHook("onRequest", (request, _reply, done) => {
		const route = `${request.method} ${request.routeOptions.url}`;
		state.reached.add(route);
		serving.run(route, done);
	});
});
