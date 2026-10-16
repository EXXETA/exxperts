import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPersistentRoomPath } from "../src/persistent-room-workspace-policy.js";
import {
	MAX_WORKSPACE_MARKDOWN_EDITOR_BYTES,
	PersistentRoomWorkspaceMarkdownError,
	readWorkspaceMarkdownFileWithPolicy,
	writeWorkspaceMarkdownFileWithPolicy,
} from "../src/persistent-room-workspace-markdown-files.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-room-workspace-markdown-"));
const realRoot = fs.realpathSync.native(root);
const policy = {
	schemaVersion: 1,
	policyId: "policy",
	agentId: "agent",
	conversationId: "conversation",
	workspaceAccessMode: "bounded",
	roots: [{ id: "root", displayLabel: "Workspace", path: root, realpath: realRoot, basename: path.basename(root), pathHash: hashPersistentRoomPath(realRoot), source: "manual", grantedAt: new Date().toISOString() }],
	modes: { read: true, write: true },
	allowedToolNames: ["ls", "find", "grep", "read", "write", "edit"],
	toolSelection: { kind: "standard" },
	deniedRoots: [],
	denySegments: [".git", "node_modules"],
	denyFilenameGlobs: [".env", ".env.*", "*.secret"],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
} as any;

function throwsCode(fn: () => unknown, code: string): void {
	assert.throws(fn, (error: unknown) => error instanceof PersistentRoomWorkspaceMarkdownError && error.code === code);
}

try {
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "README.md"), "# Hello\r\n");
	fs.writeFileSync(path.join(root, "Upper.MD"), "# Upper\n");
	fs.writeFileSync(path.join(root, "docs", "notes.md"), "notes\n");
	fs.writeFileSync(path.join(root, "notes.txt"), "not markdown\n");
	fs.writeFileSync(path.join(root, "notes.mdx"), "not markdown\n");
	fs.writeFileSync(path.join(root, ".env.md"), "secret\n");
	fs.mkdirSync(path.join(root, ".git"));
	fs.symlinkSync(path.join(root, "README.md"), path.join(root, "linked.md"));
	fs.mkdirSync(path.join(root, "outside"));
	fs.writeFileSync(path.join(root, "outside", "secret.md"), "secret\n");
	fs.symlinkSync(path.join(root, "outside"), path.join(root, "linked-dir"));

	const first = readWorkspaceMarkdownFileWithPolicy(policy, "README.md");
	assert.equal(first.content, "# Hello\r\n");
	assert.equal(first.bytes, Buffer.byteLength(first.content));
	assert.equal(first.readOnly, false);
	assert.match(first.revision, /^sha256:[0-9a-f]{64}$/);
	assert.equal(readWorkspaceMarkdownFileWithPolicy(policy, "Upper.MD").path, "Upper.MD");
	const written = (() => {
		const current = readWorkspaceMarkdownFileWithPolicy(policy, "README.md");
		return writeWorkspaceMarkdownFileWithPolicy(policy, "README.md", "# New\n", current.revision);
	})();
	assert.equal(written.content, "# New\n");
	assert.notEqual(written.revision, first.revision);
	throwsCode(() => writeWorkspaceMarkdownFileWithPolicy(policy, "README.md", "# Stale\n", first.revision), "revision_conflict");
	assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# New\n");

	for (const invalid of ["notes.txt", "notes.mdx"]) throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, invalid), "unsupported_file_type");
	for (const invalid of ["/tmp/README.md", "../README.md", "docs/../README.md", "bad\0.md", ".env.md"]) throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, invalid), "invalid_path");
	throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, "linked.md"), "not_file");
	throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, "linked-dir/secret.md"), "blocked_by_policy");

	fs.writeFileSync(path.join(root, "large.md"), Buffer.alloc(MAX_WORKSPACE_MARKDOWN_EDITOR_BYTES + 1, 65));
	throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, "large.md"), "file_too_large");
	fs.writeFileSync(path.join(root, "nul.md"), Buffer.from("a\0b", "utf8"));
	throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, "nul.md"), "binary_content");
	fs.writeFileSync(path.join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
	throwsCode(() => readWorkspaceMarkdownFileWithPolicy(policy, "invalid.md"), "invalid_encoding");

	const readOnly = { ...policy, modes: { read: true, write: false }, allowedToolNames: ["ls", "find", "grep", "read"], toolSelection: { kind: "custom", allowedToolNames: ["ls", "find", "grep", "read"] } } as any;
	assert.equal(readWorkspaceMarkdownFileWithPolicy(readOnly, "README.md").readOnly, true);
	throwsCode(() => writeWorkspaceMarkdownFileWithPolicy(readOnly, "README.md", "# No\n", written.revision), "markdown_write_forbidden");
	console.log("persistent-room workspace markdown files smoke passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
