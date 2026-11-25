import vm from "node:vm";

/**
 * Pattern matching for the room's own files on a shared server, where one
 * runaway pattern would hold the server's one thread for everyone. Each pattern
 * is compiled and run inside a context of its own that holds no object of the
 * server's: only strings and numbers go in and come out. Each run stops itself
 * after a slice of time and hands the thread back; a single line that runs away
 * is cut by the context's own timeout, and the search ends.
 */

/** A pattern that took too long: the search ends with what it found. */
export class SearchTooSlow extends Error {
	constructor() {
		super("Search stopped: this pattern is too slow on some lines. Use a simpler pattern.");
		this.name = "SearchTooSlow";
	}
}

/** How long one run may take before it hands the thread back. */
const SLICE_MS = 50;
/** Where one line that runs away is cut. */
const CUT_MS = 250;

const COMPILE = new vm.Script(`pattern = new RegExp(source, flags); lines = []; "ok"`);
// A Windows line's \r is not part of the line, so a pattern that ends in $ matches it.
const LOAD = new vm.Script(`lines = text.split("\\n").map((line) => (line.endsWith("\\r") ? line.slice(0, -1) : line)); text = ""; lines.length`);
// From line `from`, each line's first `probeChars` characters, until `maxHits` lines matched or the slice is spent: "<next line>:<hit,hit,...>".
const SCAN = new vm.Script(`(() => {
	const began = Date.now();
	const hits = [];
	let at = from;
	while (at < lines.length) {
		const line = lines[at];
		pattern.lastIndex = 0;
		if (pattern.test(line.length > probeChars ? line.slice(0, probeChars) : line)) hits.push(at);
		at += 1;
		if (hits.length >= maxHits || Date.now() - began > slice) break;
	}
	return at + ":" + hits.join(",");
})()`);

function run(script: vm.Script, context: vm.Context): unknown {
	try {
		return script.runInContext(context, { timeout: CUT_MS });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new SearchTooSlow();
		throw error;
	}
}

const handBack = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One pattern, compiled in its own context. Throws a SyntaxError of that context's for a pattern that isn't one. */
export class BoundedPattern {
	private readonly context: vm.Context;

	constructor(source: string, flags = "") {
		// A global of the context's own, not one of the server's objects: nothing in it reaches back into the server.
		this.context = vm.createContext(vm.constants.DONT_CONTEXTIFY);
		Object.assign(this.context, { source: String(source), flags: String(flags) });
		try {
			run(COMPILE, this.context);
		} catch (error) {
			if (error instanceof SearchTooSlow) throw error;
			throw new SyntaxError("not a valid regular expression");
		}
	}

	/**
	 * The indexes of the lines of `text` that match, the first `probeChars` of
	 * each, at most `maxHits`, handing the thread back between runs. Stops at
	 * `deadline` or when `stopped()` says so: `ended` says which; a runaway line
	 * throws SearchTooSlow.
	 */
	async matchLines(text: string, { maxHits, probeChars, deadline, stopped }: { maxHits: number; probeChars: number; deadline: number; stopped: () => boolean }): Promise<{ hits: number[]; ended: "done" | "limit" | "deadline" | "stopped" }> {
		this.context.text = text;
		const count = Number(run(LOAD, this.context));
		const hits: number[] = [];
		let from = 0;
		while (from < count) {
			if (stopped()) return { hits, ended: "stopped" };
			if (Date.now() > deadline) return { hits, ended: "deadline" };
			Object.assign(this.context, { from, maxHits: maxHits - hits.length, probeChars, slice: SLICE_MS });
			const [next, found] = String(run(SCAN, this.context)).split(":");
			for (const hit of found ? found.split(",") : []) hits.push(Number(hit));
			if (hits.length >= maxHits) return { hits, ended: "limit" };
			from = Number(next);
			await handBack();
		}
		return { hits, ended: "done" };
	}
}

// What holds the line: the running search itself, which a restart ends anyway.
const searching = new Map<string, Promise<void>>();

/** One search at a time in a room: a second one waits for the first to end. Its own deadline runs from when it joined, so the wait counts against it. */
export async function oneSearchAtATime<T>(roomId: string, search: () => Promise<T>): Promise<T> {
	const before = searching.get(roomId) ?? Promise.resolve();
	let finished!: () => void;
	const mine = before.then(() => new Promise<void>((resolve) => (finished = resolve)));
	searching.set(roomId, mine);
	try {
		await before;
		return await search();
	} finally {
		finished?.();
		if (searching.get(roomId) === mine) searching.delete(roomId);
	}
}
