// The tripwire's verdict on one run: each recorded touch read as a site in a
// tree, judged against the known list, and every registered route and offered
// tool checked as driven or named.
import path from "node:path";

import type { KnownSite, Run } from "./known-sites.js";
import { type Layout, type Tree, treeOf } from "./layout.js";
import { framesOf, type RecorderState, shortStack, siteOf } from "./records.js";

export interface Site {
	tree: Tree;
	file: string;
	fn: string;
	call: string;
	/** How often, at which paths (test-root relative), serving which routes, and one stack. */
	count: number;
	paths: Set<string>;
	routes: Set<string>;
	stack: string[];
}

const key = (site: { tree: string; file: string; fn: string; call: string }) => `${site.tree} | ${site.file} | ${site.fn} | ${site.call}`;

/** Every touch the run made, grouped by tree, site and call. The run's own planting and swapping (its scripts' frames) is left out. */
export function sitesOf(state: RecorderState, at: Layout, rooms: string[]): Site[] {
	const sites = new Map<string, Site>();
	for (const record of state.records) {
		const frames = framesOf(record.stack);
		const { file, fn } = siteOf(frames, record.route);
		if (file.startsWith("apps/web-server/scripts/") && !file.endsWith("tripwire/control.ts")) continue;
		for (const touched of record.paths) {
			const tree = treeOf(at, rooms, touched);
			const one = { tree: tree.name, file, fn, call: record.call };
			const site = sites.get(key(one)) ?? { tree, file, fn, call: record.call, count: 0, paths: new Set<string>(), routes: new Set<string>(), stack: shortStack(frames) };
			site.count += 1;
			if (site.paths.size < 6) site.paths.add(path.relative(at.root, touched) || ".");
			if (record.route) site.routes.add(record.route);
			sites.set(key(one), site);
		}
	}
	return [...sites.values()];
}

/** The fails: a touch in a listed tree at a site the known list doesn't name, and a known site this run no longer sees. */
export function judge(sites: Site[], known: readonly KnownSite[], run: Run): string[] {
	const fails: string[] = [];
	const ours = known.filter((site) => site.runs.includes(run));
	for (const site of sites) {
		if (!site.tree.listed) continue;
		const named = ours.some((one) => one.tree === site.tree.name && one.file === site.file && one.fn === site.fn && one.calls.includes(site.call));
		if (!named) fails.push(`a touch the list doesn't name: ${site.call} in ${site.tree.name} (${[...site.paths].join(", ")}) at ${site.file} ${site.fn}, ${site.count} time(s)${site.routes.size ? `, serving ${[...site.routes].join(", ")}` : ""}\n        ${site.stack.join("\n        ")}`);
	}
	for (const one of ours) {
		for (const call of one.calls) {
			if (!sites.some((site) => site.tree.name === one.tree && site.file === one.file && site.fn === one.fn && site.call === call)) fails.push(`a stale line: the list names ${call} in ${one.tree} at ${one.file} ${one.fn}, and this run never saw it`);
		}
	}
	return fails;
}

/** The registered routes, HEAD's own copies of GET left out. */
export function registeredRoutes(state: RecorderState): string[] {
	const all = new Set(state.routes.map((route) => `${route.method} ${route.url}`));
	return [...all].filter((route) => !(route.startsWith("HEAD ") && all.has(`GET ${route.slice(5)}`))).sort();
}

/** A route or tool the run never reached and the smoke doesn't name; and a name for one that no longer exists. */
export function uncovered(kind: string, present: string[], reached: Set<string>, named: Readonly<Record<string, string>>): string[] {
	const fails = present.filter((one) => !reached.has(one) && !(one in named)).map((one) => `a ${kind} the run never called and the smoke doesn't name: ${one}`);
	for (const one of Object.keys(named)) if (!present.includes(one)) fails.push(`the smoke names a ${kind} that no longer exists: ${one}`);
	return fails;
}
