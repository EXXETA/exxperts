import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { createWorkspaceImageExtension, WorkspaceLink, WorkspaceParagraph } from "../../web-ui/src/components/WorkspaceImageExtension.js";
import { workspaceImageUrl } from "../../web-ui/src/workspace-image-src.js";
import { hashPersistentRoomPath } from "../src/persistent-room-workspace-policy.js";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";
import {
	MAX_WORKSPACE_IMAGE_BYTES,
	PersistentRoomWorkspaceMarkdownError,
	readWorkspaceImageFileWithPolicy,
} from "../src/persistent-room-workspace-image.js";

// Saving must never drop an image: the Markdown keeps its own relative source.
const seen: string[] = [];
const extensions = [
	StarterKit.configure({ paragraph: false, link: false }),
	WorkspaceLink,
	WorkspaceParagraph,
	Table,
	TableRow,
	TableCell,
	TableHeader,
	createWorkspaceImageExtension({ current: (src) => { seen.push(src); return `/resolved/${src}`; } }),
];
const manager = new MarkdownManager({ extensions });
const schema = getSchema(extensions);
for (const markdown of [
	"Before ![a diagram](img/diagram.png \"Cap\") after",
	"![alone](../pic.jpg)",
	"![spaces](<img/my picture.png>)",
	"![encoded](img/my%20picture.png)",
	"![quote](a.png \"say \\\"hi\\\"\")",
	"![](no-alt.png)",
	"Two ![a](a.png) and ![b](b.png) inline",
	"![one](a.png) ![two](b.png)",
	"- ![in a list](a.png)",
	"> ![in a quote](a.png)",
	"| Head                 |\n| -------------------- |\n| ![in a table](a.png) |",
	"[![linked](a.png)](https://example.com)",
	"[text ![x](a.png)](https://example.com)",
	"[![badge](a.svg \"Badge\")](https://example.com \"Site\")",
	"Text [plain link](https://example.com) stays",
	"![remote](https://example.com/a.png)",
]) {
	// An invalid document takes the whole page down when the editor loads it.
	schema.nodeFromJSON(manager.parse(markdown)).check();
	const once = manager.serialize(manager.parse(markdown));
	const twice = manager.serialize(manager.parse(once));
	assert.equal(once.trim(), markdown, "an image should survive a load and save unchanged");
	assert.equal(twice, once, "saving twice should not change the file further");
}

// Relative sources resolve against the Markdown file and stay inside the workspace.
const url = (markdownPath: string, src: string) => workspaceImageUrl("room 1", "conv", markdownPath, src);
const pathOf = (value: string | null) => new URLSearchParams(String(value).split("?")[1]).get("path");
assert.equal(pathOf(url("docs/guide.md", "img/a.png")), "docs/img/a.png");
assert.equal(pathOf(url("docs/guide.md", "./img/a.png")), "docs/img/a.png");
assert.equal(pathOf(url("docs/guide.md", "../a.png")), "a.png");
assert.equal(pathOf(url("guide.md", "a.png")), "a.png");
assert.equal(pathOf(url("docs/guide.md", "/assets/a.png")), "assets/a.png", "a leading slash means the workspace root");
assert.equal(pathOf(url("docs/guide.md", "my%20picture.png")), "docs/my picture.png");
assert.equal(pathOf(url("docs/guide.md", "a.png?raw=1#top")), "docs/a.png");
assert.equal(url("guide.md", "../../secret.png"), null, "a source above the workspace should not resolve");
assert.equal(url("guide.md", ""), null);
assert.equal(url("guide.md", "https://example.com/a.png"), null);
assert.equal(url("guide.md", "data:image/png;base64,AAAA"), null);
assert.equal(url("guide.md", "//example.com/a.png"), null);
assert.ok(url("guide.md", "a.png")?.startsWith("/api/persistent-agents/room%201/workspace-image?"), "the room id should be encoded");
assert.ok(url("guide.md", "a.png")?.includes("conversationId=conv"));

assert.equal(classifyRemoteRoute("GET", "/api/persistent-agents/:id/workspace-image"), "read");

// The server hands out images only, inside the workspace, and honours the room's policy.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-markdown-images-"));
const realRoot = fs.realpathSync.native(root);
const policy = {
	schemaVersion: 1,
	policyId: "policy",
	agentId: "agent",
	conversationId: "conversation",
	workspaceAccessMode: "bounded",
	roots: [{ id: "root", displayLabel: "Workspace", path: root, realpath: realRoot, basename: path.basename(root), pathHash: hashPersistentRoomPath(realRoot) }],
	modes: { read: true, write: false },
	allowedToolNames: ["ls", "find", "grep", "read"],
	toolSelection: { kind: "standard" },
	deniedRoots: [],
	denySegments: [".git", "node_modules"],
	denyFilenameGlobs: [".env", ".env.*", "*.secret"],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
} as any;

function throwsCode(fn: () => unknown, code: string): void {
	assert.throws(fn, (error: unknown) => error instanceof PersistentRoomWorkspaceMarkdownError && error.code === code, `expected ${code}`);
}

try {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	fs.mkdirSync(path.join(root, "img"));
	fs.writeFileSync(path.join(root, "img", "a.png"), png);
	fs.writeFileSync(path.join(root, "photo.JPG"), png);
	fs.writeFileSync(path.join(root, "draw.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
	fs.writeFileSync(path.join(root, "notes.txt"), "text");
	fs.writeFileSync(path.join(root, "key.secret.png"), png);
	fs.mkdirSync(path.join(root, "node_modules"));
	fs.writeFileSync(path.join(root, "node_modules", "x.png"), png);
	fs.symlinkSync(path.join(root, "img", "a.png"), path.join(root, "link.png"));

	const image = readWorkspaceImageFileWithPolicy(policy, "img/a.png");
	assert.equal(image.contentType, "image/png");
	assert.deepEqual(image.bytes, png);
	assert.equal(readWorkspaceImageFileWithPolicy(policy, "photo.JPG").contentType, "image/jpeg");
	assert.equal(readWorkspaceImageFileWithPolicy(policy, "draw.svg").contentType, "image/svg+xml");

	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "notes.txt"), "unsupported_file_type");
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "../a.png"), "invalid_path");
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "/etc/a.png"), "invalid_path");
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, ".hidden/a.png"), "invalid_path");
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "missing.png"), "file_not_found");
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "node_modules/x.png"), "blocked_by_policy");
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "link.png"), "not_file");

	const big = path.join(root, "big.png");
	fs.writeFileSync(big, png);
	fs.truncateSync(big, MAX_WORKSPACE_IMAGE_BYTES + 1);
	throwsCode(() => readWorkspaceImageFileWithPolicy(policy, "big.png"), "file_too_large");

	const noRead = { ...policy, modes: { read: false, write: false } };
	throwsCode(() => readWorkspaceImageFileWithPolicy(noRead, "img/a.png"), "workspace_read_forbidden");
	console.log("workspace markdown images smoke passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
