// A stand-in for Microsoft's sandbox kit (@microsoft/mxc-sdk), in plain Node,
// so the Windows box's process runs on any computer: the worker smoke drives
// it, and so does the Windows PC check's dry walk. It is no box: it reads the
// request's grants and refuses by them, and runs only a few PowerShell
// commands, by name: Write-Output, Write-Host [-NoNewline], Write-Error, Start-Sleep, exit, Set-Content,
// Get-Content, Remove-Item, Invoke-WebRequest,
// `[Console]::Error.Write([IO.File]::ReadAllText('<file>'))`, which writes the
// file to the error stream as it is, and `& <...>\curl.exe` for an
// http:// address, through the proxy the environment names unless
// `--noproxy '*'`, with `--max-time <seconds>` and `-A <user agent>`, failing
// as curl.exe does with (52) when the proxy ends the connection with no answer;
// a command that is stopped drops curl's connection, as a real one's end does. Anything
// else fails, saying so.
//
// Load it before the worker with `--import <this file's URL>?config=<file>&register`:
// it then answers the kit's imports in that process. The config file, read at
// each call so a test can change it between turns, says how it answers:
//   version, contract: what the kit says it is ("1.0.1", "1.0.0");
//   platform: "ok" | "unsupported" | "no-container" | "throws";
//   probe: "ok" | "throws" | "error" | "appcontainer" | "dacl" | "no-deny";
//   crash: "check" | "run": the process ends there, as a crash in native code;
//   box: "holds" | "leaks" | "spawn-fails": whether file commands keep to the grants;
//   net: "holds" | "direct-open" | "through-leaks" | "proxy-ignored": whether a
//     connection that skips the proxy gets out, a request sent through the proxy
//     also reaches its target directly, or curl ignores the proxy;
//   log: a file each call is noted in, one JSON line each.
// Paths: a request names C:\a\b where this computer has /a/b (requestPath, nativePath).
import fs from "node:fs";
import http from "node:http";
import module from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const query = new URL(import.meta.url).searchParams;
const configFile = query.get("config");

function readConfigOnce() {
	try {
		return JSON.parse(fs.readFileSync(configFile, "utf8"));
	} catch {
		return {};
	}
}

const config = () => ({ version: "1.0.1", contract: "1.0.0", platform: "ok", probe: "ok", box: "holds", net: "holds", ...readConfigOnce() });

function note(entry) {
	const { log } = config();
	if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

const KIT_HOOKS = `
let kit;
export function initialize(data) {
	kit = data;
}
export function resolve(specifier, context, next) {
	if (specifier === "@microsoft/mxc-sdk/v1") return { url: kit.sdk, shortCircuit: true };
	if (specifier === "@microsoft/mxc-sdk/package.json") return { url: kit.pkg, format: "json", shortCircuit: true };
	return next(specifier, context);
}
`;

if (query.has("register")) {
	const sdk = new URL(import.meta.url);
	sdk.searchParams.delete("register");
	// A URL that ends in .json reads as JSON to a TypeScript loader: the config's name never comes last.
	sdk.searchParams.set("as", "sdk");
	// The package's version is the config's when the process starts, in a file beside the config: a loader may not read the package's JSON from a data: URL.
	const pkgFile = `${configFile}.package.json`;
	fs.writeFileSync(pkgFile, JSON.stringify({ name: "@microsoft/mxc-sdk", version: config().version }));
	// Hooks given to module.register run in a module of their own, as on every Node from 20.6, so they come as text, with both addresses as their data.
	module.register(`data:text/javascript,${encodeURIComponent(KIT_HOOKS)}`, { data: { sdk: sdk.href, pkg: pathToFileURL(pkgFile).href } });
}

/** A path on this computer as a request names it, and back. */
export const requestPath = (native) => `C:${native.replaceAll("/", "\\")}`;
export const nativePath = (requested) => requested.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");

export const SDK_CONTRACT_VERSION = config().contract;

export function getPlatformSupport() {
	const { platform, crash } = config();
	note({ call: "getPlatformSupport" });
	if (crash === "check") process.exit(70);
	if (platform === "throws") throw new Error("the native library did not load");
	if (platform === "unsupported") return { isSupported: false, reason: "not supported here", availableMethods: [] };
	return { isSupported: true, reason: "", availableMethods: platform === "no-container" ? ["windows_sandbox"] : ["processcontainer"], isolationTier: "base-container" };
}

const FACTS = {
	baseContainerApiPresent: true,
	baseContainerSupportsDenyPaths: true,
	baseContainerSupportsEnumeratePaths: true,
	baseContainerSupportsIngressHostLoopbackAllow: true,
	baseContainerSupportsIdentitylessLoopbackProxy: true,
};

export function probe(request) {
	const { probe: answer } = config();
	note({ call: "probe", request });
	if (answer === "throws") throw new Error("the native probe failed");
	if (answer === "error") return { warnings: [], probes: FACTS, error: "detection failed" };
	if (answer === "appcontainer") return { tier: "appcontainer-dacl", needsDaclAugmentation: false, warnings: [], probes: FACTS };
	if (answer === "dacl") return { tier: "base-container", needsDaclAugmentation: true, warnings: [], probes: FACTS };
	if (answer === "no-deny") return { tier: "base-container", needsDaclAugmentation: false, warnings: [], probes: { ...FACTS, baseContainerSupportsDenyPaths: false } };
	return { tier: "base-container", needsDaclAugmentation: false, warnings: [], probes: FACTS };
}

// ---- Commands -----------------------------------------------------------------------------

const win = path.win32;
const atOrInside = (inner, outer) => {
	const relative = win.relative(outer.toLowerCase(), inner.toLowerCase());
	return relative === "" || (!relative.startsWith("..") && !win.isAbsolute(relative));
};

/** PowerShell words: bare, '...' with '' inside, or "...". */
function words(statement) {
	const out = [];
	const pattern = /'((?:[^']|'')*)'|"([^"]*)"|(\S+)/g;
	for (const match of statement.matchAll(pattern)) out.push(match[1] !== undefined ? match[1].replaceAll("''", "'") : match[2] ?? match[3]);
	return out;
}

const flag = (args, name) => {
	const at = args.findIndex((word) => word.toLowerCase() === name.toLowerCase());
	return at === -1 ? undefined : args[at + 1];
};

class Denied extends Error {}

/** One running command: its streams, its end, and how it is stopped. */
class StandInProcess {
	constructor(request) {
		this.id = 0;
		this.standardInput = null;
		this.standardOutput = new PassThrough();
		this.standardError = new PassThrough();
		this.warnings = [];
		this.request = request;
		this.stopped = null;
		this.wakers = new Set();
		this.ended = this.execute();
		if (request.timeoutMs > 0) this.limit = setTimeout(() => this.stop("timeout"), request.timeoutMs);
	}

	stop(why) {
		this.stopped ??= why;
		for (const wake of this.wakers) wake();
	}

	sleep(ms) {
		return new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			const wakers = this.wakers;
			function done() {
				clearTimeout(timer);
				wakers.delete(done);
				resolve();
			}
			wakers.add(done);
		});
	}

	place(given, access) {
		const { filesystem, workingDirectory } = this.request;
		const full = win.resolve(workingDirectory, given);
		if (config().box === "holds") {
			const inAny = (list) => list.some((root) => atOrInside(full, root));
			const allowed = access === "write" ? inAny(filesystem.readwritePaths) : inAny([...filesystem.readwritePaths, ...filesystem.readonlyPaths]);
			if (!allowed || inAny(filesystem.deniedPaths)) throw new Denied(`Access to the path '${full}' is denied.`);
		}
		return nativePath(full);
	}

	async statement(args, out, err) {
		const [name, ...rest] = args;
		switch (name.toLowerCase()) {
			case "write-output":
				out(`${rest.join(" ")}\n`);
				return true;
			case "write-host": {
				const bare = rest.filter((word) => word.toLowerCase() !== "-nonewline");
				out(`${bare.join(" ")}${bare.length === rest.length ? "\n" : ""}`);
				return true;
			}
			case "write-error":
				err(`${rest.join(" ")}\n`);
				return false;
			case "start-sleep":
				await this.sleep(Number(flag(rest, "-Seconds") ?? 0) * 1000 + Number(flag(rest, "-Milliseconds") ?? 0));
				return true;
			case "set-content":
				fs.writeFileSync(this.place(flag(rest, "-LiteralPath"), "write"), `${flag(rest, "-Value") ?? ""}\r\n`);
				return true;
			case "get-content":
				out(fs.readFileSync(this.place(flag(rest, "-LiteralPath"), "read"), "utf8"));
				return true;
			case "remove-item":
				fs.rmSync(this.place(flag(rest, "-LiteralPath"), "write"), { recursive: true });
				return true;
			case "invoke-webrequest": {
				const uri = flag(rest, "-Uri");
				if (config().box !== "leaks") throw new Denied(`Unable to connect to the remote server: ${uri}`);
				await fetch(uri, { signal: AbortSignal.timeout(10_000) });
				return true;
			}
			case "&":
				if (/(^|\\)curl\.exe$/i.test(rest[0] ?? "")) return this.curl(rest.slice(1), out);
				err(`stand-in: can't run ${rest[0]}\n`);
				return false;
			default: {
				const toErrors = /^\[Console\]::Error\.Write\(\[IO\.File\]::ReadAllText\('([^']+)'\)\)$/.exec(name);
				if (toErrors) {
					err(fs.readFileSync(this.place(toErrors[1], "read"), "utf8"));
					return true;
				}
				err(`stand-in: can't run ${name}\n`);
				return false;
			}
		}
	}

	/** curl.exe for an http:// address: through the environment's proxy, or straight out with `--noproxy '*'`. It prints the answer's body. */
	async curl(args, out) {
		const environment = this.request.environment ?? {};
		let target;
		let proxy = environment.http_proxy ?? environment.HTTP_PROXY;
		let noProxy;
		let maxTime;
		let agent;
		for (let at = 0; at < args.length; at++) {
			if (args[at] === "--max-time") maxTime = Number(args[++at]);
			else if (args[at] === "-A") agent = args[++at];
			else if (args[at] === "--noproxy") noProxy = args[++at];
			else if (!args[at].startsWith("-")) target = args[at];
		}
		const { net } = config();
		if (net === "proxy-ignored") proxy = undefined;
		const direct = () => {
			if (config().box !== "leaks" && net !== "direct-open") throw new Denied(`curl: (7) Failed to connect to ${new URL(target).host}`);
			return fetch(target, { signal: AbortSignal.timeout(10_000) }).then((answer) => answer.text());
		};
		if (!proxy || noProxy === "*") {
			out(await direct());
			return true;
		}
		// The box lets a command reach the request's own proxy and nothing else.
		if (this.request.network?.runtimeConfig?.networkProxy !== proxy) throw new Denied(`curl: (7) Failed to connect to the proxy ${proxy}`);
		const through = new URL(proxy);
		let drop = () => {};
		const body = new Promise((resolve, reject) => {
			const asked = http.request({ host: through.hostname, port: through.port, path: target, headers: { host: new URL(target).host, ...(agent ? { "user-agent": agent } : {}) }, agent: false }, (answer) => {
				let text = "";
				answer.on("data", (chunk) => { text += chunk; });
				answer.on("end", () => resolve(text));
			});
			// As curl.exe says it when the proxy ends the connection with no answer.
			asked.on("error", (error) => reject(error.code === "ECONNRESET" ? new Denied("curl: (52) Empty reply from server") : error));
			asked.setTimeout(maxTime ? maxTime * 1000 : 10_000, () => asked.destroy(new Error("curl: (28) timed out")));
			drop = () => asked.destroy(new Error("curl: stopped"));
			this.wakers.add(drop);
			asked.end();
		}).finally(() => this.wakers.delete(drop));
		// The leak reaches the target whatever the proxy answered.
		if (net === "through-leaks") await Promise.allSettled([body, fetch(target, { signal: AbortSignal.timeout(10_000) })]);
		out(await body);
		return true;
	}

	async execute() {
		const text = this.request.environment?.EXXPERTS_COMMAND ?? "";
		const out = (chunk) => this.standardOutput.write(chunk);
		const err = (chunk) => this.standardError.write(chunk);
		let ok = true;
		let exitCode;
		for (const statement of text.split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean)) {
			if (this.stopped) break;
			const args = words(statement);
			if (args[0].toLowerCase() === "exit") {
				exitCode = Number(args[1] ?? 0);
				break;
			}
			try {
				ok = await this.statement(args, out, err);
			} catch (error) {
				err(`${error instanceof Denied ? error.message : `stand-in: ${error.message}`}\n`);
				ok = false;
			}
		}
		clearTimeout(this.limit);
		this.standardOutput.end();
		this.standardError.end();
		if (this.stopped) return { exitCode: 1, timedOut: this.stopped === "timeout" };
		return { exitCode: exitCode ?? (ok ? 0 : 1), timedOut: false };
	}

	wait() {
		return this.ended;
	}

	kill() {
		note({ call: "kill" });
		this.stop("kill");
	}

	dispose() {}
}

export async function spawn(request, ...more) {
	const { box, crash } = config();
	note({ call: "spawn", request, more });
	if (crash === "run") process.exit(71);
	if (box === "spawn-fails") throw new Error("CreateProcess failed");
	return new StandInProcess(request);
}
