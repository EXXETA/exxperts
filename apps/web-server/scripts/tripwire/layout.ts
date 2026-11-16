// The tripwire's test computer: one folder holding a home, a shared temp, the
// rooms' folders and the connector files, and the trees of the Windows design
// they make. Each run gets a fresh one, made by the smoke and named in
// TRIPWIRE_ROOT, since the recorder needs the folders it watches before the
// run's code loads.
import fs from "node:fs";
import path from "node:path";

import type { Run } from "./known-sites.js";

/** The folders the recorder watches and leaves out, for TRIPWIRE_WATCH and TRIPWIRE_IGNORE. */
export function recorderFolders(root: string, run: Run): { watch: string[]; ignore: string[] } {
	const at = layout(root, run);
	// The app's own data is left out, all but each room's box folder, which holds the turn's temp and caches.
	return { watch: [root, path.join(at.agentsRoot, "*", "runtime", "box")], ignore: [path.join(at.home, ".exxperts"), ...at.moved] };
}

/** The moved run points the agent folder, the connector settings folder and the rooms' data outside `.exxperts`. */
export function layout(root: string, run: Run) {
	const home = path.join(root, "home");
	// In the home: a room in a shared place such as `/tmp` is refused, but a home there is still the person's.
	const work = path.join(home, "work");
	const live = path.join(work, "live-room");
	const elsewhere = path.join(root, "moved");
	const moved = run === "moved";
	const agentDir = moved ? path.join(elsewhere, "agent") : path.join(home, ".exxperts", "agent");
	const connectorDir = moved ? path.join(elsewhere, "connectors") : agentDir;
	const agentsRoot = moved ? path.join(elsewhere, "rooms") : path.join(home, ".exxperts", "app", "personalized-agents");
	return {
		root,
		home,
		agentDir,
		connectorDir,
		appRoot: path.join(home, ".exxperts", "app"),
		agentsRoot,
		/** The app's own places a setting moved, and the folder that holds them. */
		moved: moved ? [agentDir, connectorDir, agentsRoot] : [],
		movedParent: elsewhere,
		sharedTemp: path.join(root, "shared-temp"),
		programFiles: path.join(root, "program-files"),
		/** The ancestor every test room sits in, with a planted `.git` the runtime's walk up from the live and background rooms reaches. */
		work,
		live,
		/** A room whose folder sits inside the live room's, with its own `.git` for the box's git scan. */
		child: path.join(live, "child-room"),
		background: path.join(work, "background-room"),
		/** A room whose commands are off but may be asked for, on its own folder. */
		asks: path.join(work, "asks-room"),
		/** The folder the stood-in folder window picks when the room asks for one, and a folder on the room's list it can only read. */
		picked: path.join(home, "picked"),
		readOnly: path.join(home, "read-only"),
		/** The folder the Folder pane's Add a folder… picks in the stood-in window. */
		added: path.join(home, "added"),
		/** In the home: a folder in a shared place such as `/tmp` can't be allowed, but a home there is still the person's. */
		alsoAllowed: path.join(home, "also-allowed"),
		/** Save…'s destination: a folder inside the live room. */
		saveTo: path.join(live, "saved"),
		vault: path.join(live, "vault"),
		/** The shared skill store, which no room may have as its folder. */
		skillStore: path.join(home, ".agents", "skills"),
		skillTargets: path.join(root, "skill-targets"),
		skillRepo: path.join(root, "skill-repo"),
		/** Other tools' connector files, one per import kind the adapter reads in a home. */
		connectorFiles: [
			path.join(home, ".cursor", "mcp.json"),
			path.join(home, ".claude", "mcp.json"),
			path.join(home, ".claude.json"),
			path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
			path.join(home, ".codex", "config.json"),
			path.join(home, ".windsurf", "mcp.json"),
			path.join(home, ".config", "mcp", "mcp.json"),
		],
	};
}
export type Layout = ReturnType<typeof layout>;

/** The connector a room's own connector files name: no room may load it. */
export const PLANTED_CONNECTOR = "planted-in-room";
const plantedConnectors = `${JSON.stringify({ mcpServers: { [PLANTED_CONNECTOR]: { command: "/usr/bin/true", args: [] } } })}\n`;

/** The files planted in a room and its ancestor for the runtime's lookup, project settings and project connectors. */
const PROJECT_FILES: Record<string, string> = {
	".agents/skills/planted/SKILL.md": "---\nname: planted\ndescription: A planted skill the room must not load.\n---\nPlanted.\n",
	".exxperts/settings.json": "{\"theme\":\"planted\"}\n",
	".exxperts/SYSTEM.md": "Planted system prompt.\n",
	".exxperts/APPEND_SYSTEM.md": "Planted appended prompt.\n",
	".mcp.json": plantedConnectors,
	".pi/mcp.json": plantedConnectors,
	".vscode/mcp.json": plantedConnectors,
};

export function plant(at: Layout): void {
	for (const dir of [at.agentDir, at.connectorDir, at.appRoot, at.agentsRoot, at.sharedTemp, at.programFiles, at.child, at.background, at.asks, at.picked, at.readOnly, at.added, at.alsoAllowed, at.saveTo, at.vault, at.skillStore, at.skillTargets]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const folder of [at.work, at.live, at.child, at.background]) {
		for (const [name, text] of Object.entries(PROJECT_FILES)) {
			fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
			fs.writeFileSync(path.join(folder, name), text);
		}
		fs.writeFileSync(path.join(folder, "notes.txt"), "line one\nneedle here\n");
	}
	for (const folder of [at.work, at.child]) {
		fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
		fs.writeFileSync(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
	}
	// A hooks path in the child room's own settings, so a write there reads them and judges the place they name.
	fs.writeFileSync(path.join(at.child, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\thooksPath = .githooks\n");
	fs.writeFileSync(path.join(at.alsoAllowed, "also.txt"), "also allowed\n");
	fs.writeFileSync(path.join(at.asks, "notes.txt"), "line one\nneedle here\n");
	fs.writeFileSync(path.join(at.live, "planted.txt"), "planted\n");
}

/** A tree of the Windows design, and whether a server-side touch there fails a protected run. */
export interface Tree {
	name: string;
	/** On the list: a protected run fails on any touch here, beyond what the tree allows. */
	listed: boolean;
	why: string;
}

export function treeOf(at: Layout, rooms: string[], target: string): Tree {
	const inside = (folder: string) => target === folder || target.startsWith(folder + path.sep);
	const box = target.startsWith(at.agentsRoot + path.sep) ? /^[^/]+\/runtime\/box(?:\/([^/]+))?/.exec(target.slice(at.agentsRoot.length + 1)) : null;
	if (box) {
		if (box[1] === "caches" || box[1]?.startsWith("temp-")) return { name: "a room's turn temp and caches", listed: true, why: "the box's turn temp: only an exclusive create under a fresh random name and the link-safe delete" };
		return { name: "the box root's own places", listed: false, why: "written only by the server" };
	}
	if (inside(at.skillStore)) return { name: "the shared skill store", listed: true, why: "read only in the box" };
	if (rooms.some(inside) || inside(at.alsoAllowed)) return { name: "a room's folders", listed: true, why: "nothing at all" };
	// What the room's ancestor holds for the runtime's walk up from a room's cwd: a command in a room above could plant it.
	if ([".git", ".agents", ".exxperts"].some((name) => inside(path.join(at.work, name)))) return { name: "the planted files in a room's ancestor", listed: true, why: "the runtime's walk up from a room's cwd (row 4)" };
	// The rest of the folders on the way to a room: no boxed command writes there, unless it is another room's, which the nested child room covers.
	if (rooms.some((room) => room.startsWith(target + path.sep)) || inside(at.work)) return { name: "a room's ancestors", listed: false, why: "the folders on the way to a room, outside the rule unless they lie in another room's folders" };
	if (inside(at.sharedTemp)) return { name: "the shared temp", listed: true, why: "the server keeps nothing there" };
	// A file right in the home (`~/.claude.json`) is a place of its own; the others' folders are.
	if (at.connectorFiles.some((file) => inside(path.dirname(file) === at.home ? file : path.dirname(file)))) {
		return { name: "other tools' connector files", listed: false, why: "outside the rule once no room may sit in, on or above them (row 25)" };
	}
	if (inside(path.join(at.home, ".exxperts")) || at.moved.some(inside) || (path.dirname(target) === at.home && path.basename(target).startsWith(".exxperts"))) return { name: "the app's own places", listed: false, why: "written only by the server (row 22, and row 26 where a setting moved them)" };
	if (target.startsWith(at.programFiles)) return { name: "the stand-in Program Files", listed: false, why: "written only by an installer (row 22)" };
	if (inside(at.skillTargets)) return { name: "the linked skills' targets", listed: true, why: "reached only through a link in the shared store (row 6)" };
	if (inside(at.skillRepo)) return { name: "the test skill repository", listed: false, why: "the source a person names for an import, read by git" };
	if (inside(at.home)) return { name: "her own files in her home", listed: false, why: "written only by her and her own tools (row 22)" };
	if (inside(at.movedParent)) return { name: "the moved places' parent", listed: false, why: "the folder a setting put the app's places in" };
	return { name: "elsewhere in the test computer", listed: true, why: "no tree of the design names it: a finding" };
}
