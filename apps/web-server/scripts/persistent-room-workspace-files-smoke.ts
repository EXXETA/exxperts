import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPersistentRoomWorkspaceFiles } from "../src/persistent-room-workspace-files.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-room-workspace-files-"));
try {
	fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
	fs.mkdirSync(path.join(root, "node_modules"));
	fs.writeFileSync(path.join(root, "README"), "ok");
	fs.writeFileSync(path.join(root, "src", "no-extension"), "ok");
	fs.writeFileSync(path.join(root, ".hidden"), "no");
	fs.writeFileSync(path.join(root, "private.secret"), "no");
	fs.writeFileSync(path.join(root, "src", "nested", "data.xyz"), "ok");

	const policy = {
		roots: [{ displayLabel: "Workspace", basename: path.basename(root), path: root, realpath: fs.realpathSync.native(root) }],
		workspaceAccessMode: "bounded",
		modes: { read: true, write: false },
		allowedToolNames: ["ls", "find", "grep", "read"],
		toolSelection: { kind: "standard" },
		denySegments: ["node_modules"],
		denyFilenameGlobs: ["*.secret"],
	} as any;
	assert.deepEqual(listPersistentRoomWorkspaceFiles(policy).entries.map((entry) => entry.name), ["src", "README"]);
	assert.deepEqual(listPersistentRoomWorkspaceFiles(policy, "src").entries.map((entry) => entry.name), ["nested", "no-extension"]);
	assert.deepEqual(listPersistentRoomWorkspaceFiles(policy, "src/nested").entries.map((entry) => entry.name), ["data.xyz"]);
	assert.throws(() => listPersistentRoomWorkspaceFiles(policy, "../"));
	console.log("persistent-room workspace files smoke passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
