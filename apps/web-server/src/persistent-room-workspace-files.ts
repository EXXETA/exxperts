import fs from "node:fs";
import path from "node:path";
import type { PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import { PersistentRoomWorkspaceToolError, resolvePersistentRoomWorkspacePath } from "./persistent-room-workspace-tools.js";

export interface PersistentRoomWorkspaceFileEntry {
	name: string;
	relativePath: string;
	kind: "file" | "directory";
	bytes: number | null;
	modifiedAt: string;
	extension: string;
}

export interface PersistentRoomWorkspaceFileListing {
	root: { displayLabel: string; basename: string } | null;
	path: string;
	entries: PersistentRoomWorkspaceFileEntry[];
}

function pathInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(value: unknown): string {
	const raw = String(value ?? "").trim().replaceAll("\\", "/");
	if (!raw || raw === ".") return "";
	if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) throw new Error("Workspace path must be relative.");
	const segments = raw.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
		throw new Error("Workspace path contains an invalid segment.");
	}
	return segments.join("/");
}

function globMatches(name: string, glob: string): boolean {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
	return new RegExp(`^${escaped}$`, "i").test(name);
}

function hiddenOrDenied(name: string, policy: PersistentRoomCapabilityPolicy): boolean {
	if (name.startsWith(".")) return true;
	if (policy.denySegments.some((segment) => segment.toLowerCase() === name.toLowerCase())) return true;
	return policy.denyFilenameGlobs.some((glob) => globMatches(name, glob));
}

function workspaceUnavailableError(error: unknown): Error & { code: string; statusCode: number } {
	const cause = error as NodeJS.ErrnoException;
	if (cause?.code !== "EACCES" && cause?.code !== "EPERM" && cause?.code !== "workspace_unavailable") {
		if (error instanceof PersistentRoomWorkspaceToolError) throw error;
		throw new Error("The workspace folder could not be listed.");
	}
	const unavailable = new Error("The workspace folder is not readable. Check OneDrive permissions or make the folder available offline.") as Error & { code: string; statusCode: number };
	unavailable.code = "workspace_unavailable";
	unavailable.statusCode = 503;
	return unavailable;
}

export function listPersistentRoomWorkspaceFiles(policy: PersistentRoomCapabilityPolicy | null, requestedPath: unknown = ""): PersistentRoomWorkspaceFileListing {
	const grant = policy?.roots[0];
	if (!policy || !grant || !persistentRoomWorkspaceToolNamesForPolicy(policy).includes("ls")) return { root: null, path: "", entries: [] };

	const relativePath = normalizeRelativePath(requestedPath);
	let guarded: ReturnType<typeof resolvePersistentRoomWorkspacePath>;
	try { guarded = resolvePersistentRoomWorkspacePath(policy, relativePath || ".", "list"); } catch (error) { throw workspaceUnavailableError(error); }
	const root = guarded.rootRealpath;
	const current = guarded.absolutePath;
	let ancestor = root;
	for (const segment of relativePath.split("/").filter(Boolean)) {
		ancestor = path.join(ancestor, segment);
		try {
			if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Workspace folder not found.");
		} catch (error) {
			if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw workspaceUnavailableError(error);
			throw new Error("Workspace folder not found.");
		}
	}
	if (!pathInside(current, root)) throw new Error("Workspace path is outside the configured folder.");
	let currentRealpath: string;
	try {
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Workspace folder not found.");
		currentRealpath = fs.realpathSync.native(current);
		if (!pathInside(currentRealpath, root) || !fs.statSync(currentRealpath).isDirectory()) {
			throw new Error("Workspace folder not found.");
		}
	} catch (error) {
		throw workspaceUnavailableError(error);
	}

	let directoryEntries: fs.Dirent[];
	try {
		directoryEntries = fs.readdirSync(currentRealpath, { withFileTypes: true });
	} catch (error) {
		throw workspaceUnavailableError(error);
	}
	const entries = directoryEntries.flatMap((entry) => {
		if (entry.name.startsWith(".") || hiddenOrDenied(entry.name, policy) || entry.isSymbolicLink()) return [];
		try { resolvePersistentRoomWorkspacePath(policy, [relativePath, entry.name].filter(Boolean).join("/"), "list"); } catch { return []; }
		const absolutePath = path.join(currentRealpath, entry.name);
		let stat: fs.Stats;
		let realpath: string;
		try {
			stat = fs.lstatSync(absolutePath);
			realpath = fs.realpathSync.native(absolutePath);
		} catch {
			return [];
		}
		if (!pathInside(realpath, root) || (!stat.isDirectory() && !stat.isFile())) return [];
		const kind = stat.isDirectory() ? "directory" : "file";
		return [{
			name: entry.name,
			relativePath: [relativePath, entry.name].filter(Boolean).join("/"),
			kind,
			bytes: stat.isFile() ? stat.size : null,
			modifiedAt: new Date(stat.mtimeMs).toISOString(),
			extension: stat.isFile() ? path.extname(entry.name).toLowerCase() : "",
		} satisfies PersistentRoomWorkspaceFileEntry];
	});

	entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "directory" ? -1 : 1));
	return {
		root: { displayLabel: grant.displayLabel || grant.basename, basename: grant.basename },
		path: relativePath,
		entries,
	};
}
