// The tripwire's inventory: every site the runs recorded, grouped by tree,
// each matched to its row in the Windows design's table of server touches or
// marked NEW. Written as
// Markdown when the smoke runs with TRIPWIRE_INVENTORY=<file.md>.
import { KNOWN_SITES, type Run } from "./known-sites.js";

export interface RecordedSite {
	tree: string;
	listed: boolean;
	why: string;
	file: string;
	fn: string;
	call: string;
	count: number;
	paths: string[];
	routes: string[];
}
export interface RunSites {
	run: Run;
	sites: RecordedSite[];
}

export const RUN_NAMES: Readonly<Record<Run, string>> = { mac: "Mac box", win32: "Windows mode", moved: "Windows mode with the places moved" };

export function inventory(runs: RunSites[]): string {
	type Row = { tree: string; listed: boolean; why: string; file: string; fn: string; calls: Set<string>; runs: Set<Run>; paths: Set<string>; routes: Set<string> };
	const rows = new Map<string, Row>();
	for (const { run, sites } of runs) {
		for (const site of sites) {
			const key = `${site.tree}|${site.file}|${site.fn}`;
			const row = rows.get(key) ?? { tree: site.tree, listed: site.listed, why: site.why, file: site.file, fn: site.fn, calls: new Set(), runs: new Set(), paths: new Set(), routes: new Set() };
			row.calls.add(site.call);
			row.runs.add(run);
			for (const one of site.paths) if (row.paths.size < 3) row.paths.add(one);
			for (const one of site.routes) if (row.routes.size < 3) row.routes.add(one);
			rows.set(key, row);
		}
	}
	const rowOf = (row: Row) => KNOWN_SITES.find((known) => known.tree === row.tree && known.file === row.file && known.fn === row.fn);
	const lines = ["# The tripwire's inventory", "", `Runs: ${runs.map((one) => RUN_NAMES[one.run]).join(", ")}. A site is file and function; paths are relative to the test computer.`, ""];
	const listed = [...rows.values()].filter((row) => row.listed);
	const fresh = listed.filter((row) => rowOf(row)?.row === "NEW" || !rowOf(row));
	lines.push("## NEW: touches no row of 5.1 explains", "");
	for (const row of fresh) lines.push(`- **${row.tree}**: \`${row.file}\` ${row.fn}: ${[...row.calls].join(", ")} (${[...row.runs].map((run) => RUN_NAMES[run]).join(", ")}). ${rowOf(row)?.why ?? "not on the known list"}`);
	if (fresh.length === 0) lines.push("None.");
	for (const tree of [...new Set([...rows.values()].map((row) => row.tree))].sort()) {
		const inTree = [...rows.values()].filter((row) => row.tree === tree).sort((a, b) => `${a.file} ${a.fn}`.localeCompare(`${b.file} ${b.fn}`));
		lines.push("", `## ${tree}`, "", `${inTree[0].listed ? "On 5.1's list" : "Outside the rule"}: ${inTree[0].why}.`, "", "| Site | Calls | Runs | 5.1 row | Paths, routes |", "|---|---|---|---|---|");
		for (const row of inTree) {
			const known = rowOf(row);
			const matched = !row.listed ? "outside" : known ? (known.row === "NEW" ? "**NEW**" : String(known.row)) : "**not listed**";
			lines.push(`| \`${row.file}\` ${row.fn.replace(/\|/g, "\\|")} | ${[...row.calls].join(", ")} | ${[...row.runs].map((run) => RUN_NAMES[run]).join(", ")} | ${matched} | ${[...row.paths, ...row.routes].join("; ").replace(/\|/g, "\\|")} |`);
		}
	}
	return `${lines.join("\n")}\n`;
}
