// What the recorder (recorder.mjs) kept, read as touches: each call's path,
// the tree it lies in, and the site that made it, as file and function.
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RecorderState {
	records: RawRecord[];
	routes: { method: string; url: string }[];
	reached: Set<string>;
	wrapped: string[];
}

export interface RawRecord {
	kind: "fs" | "start";
	call: string;
	paths: string[];
	program?: string;
	cwd?: string;
	route?: string;
	stack: string;
}

export function recorder(): RecorderState {
	const state = (globalThis as Record<symbol, RecorderState | undefined>)[Symbol.for("exxperts.tripwire")];
	if (!state) throw new Error("the tripwire recorder is not loaded: start this run with --import scripts/tripwire/recorder.mjs");
	return state;
}

export interface Frame {
	fn: string;
	file: string;
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

/** A stack's frames below the recorder's own, each with its function name and its file, repo-relative where it can be. */
export function framesOf(stack: string): Frame[] {
	const frames: Frame[] = [];
	for (const line of stack.split("\n").slice(1)) {
		const match = /^\s*at (?:(.*?) \()?(.*?)(?::\d+){0,2}\)?$/.exec(line);
		if (!match) continue;
		let file = match[2];
		if (file.startsWith("file://")) file = fileURLToPath(file);
		if (path.isAbsolute(file)) file = path.relative(repoRoot, file).split(path.sep).join("/");
		frames.push({ fn: (match[1] ?? "").replace(/^async /, "").replace(/ \[as [^\]]+\]$/, ""), file });
	}
	const own = frames.map((frame) => frame.file.endsWith("tripwire/recorder.mjs")).lastIndexOf(true);
	return frames.slice(own + 1);
}

const internal = (frame: Frame) => frame.file.startsWith("node:") || frame.file === "native" || frame.file === "<anonymous>" || frame.file === "";
const ours = (frame: Frame) => !internal(frame) && !frame.file.startsWith("..") && !frame.file.split("/").includes("node_modules");

/**
 * The site of a touch: the first frame in this repo's own code (outside node_modules), as file and function.
 * A frame in a library comes first only when no code of ours is on the stack. An unnamed function is named
 * by the route it served, when the request is known: route handlers are unnamed.
 */
export function siteOf(frames: Frame[], route: string | undefined): Frame {
	const frame = frames.find(ours) ?? frames.find((one) => !internal(one)) ?? { fn: "", file: "(no frame outside Node)" };
	const fn = frame.fn === "" || frame.fn === "Object.<anonymous>" || frame.fn.endsWith("<anonymous>") ? `(unnamed${route ? `, serving ${route}` : ""})` : frame.fn;
	return { fn, file: frame.file };
}

/** The few frames that say how a touch came about: ours and the libraries', with Node's own left out. */
export function shortStack(frames: Frame[]): string[] {
	return frames.filter((frame) => !internal(frame)).slice(0, 14).map((frame) => `${frame.fn || "(unnamed)"} ${frame.file}`);
}
