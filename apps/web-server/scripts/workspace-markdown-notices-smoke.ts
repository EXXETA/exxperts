import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const notice = fs.readFileSync("NOTICE", "utf8");
const licences = [
  "node_modules/@tiptap/core/LICENSE.md",
  "node_modules/@tiptap/extension-blockquote/LICENSE.md",
  "node_modules/@tiptap/extension-bold/LICENSE.md",
  "node_modules/@tiptap/extension-code/LICENSE.md",
  "node_modules/@tiptap/extension-code-block/LICENSE.md",
  "node_modules/@tiptap/extension-document/LICENSE.md",
  "node_modules/@tiptap/extension-hard-break/LICENSE.md",
  "node_modules/@tiptap/extension-heading/LICENSE.md",
  "node_modules/@tiptap/extension-horizontal-rule/LICENSE.md",
  "node_modules/@tiptap/extension-image/LICENSE.md",
  "node_modules/@tiptap/extension-italic/LICENSE.md",
  "node_modules/@tiptap/extension-link/LICENSE.md",
  "node_modules/@tiptap/extension-list/LICENSE.md",
  "node_modules/@tiptap/extension-paragraph/LICENSE.md",
  "node_modules/@tiptap/extension-strike/LICENSE.md",
  "node_modules/@tiptap/extension-table/LICENSE.md",
  "node_modules/@tiptap/extension-text/LICENSE.md",
  "node_modules/@tiptap/extension-underline/LICENSE.md",
  "node_modules/@tiptap/extensions/LICENSE.md",
  "node_modules/@tiptap/markdown/LICENSE.md",
  "node_modules/@tiptap/markdown/node_modules/marked/LICENSE.md",
  "node_modules/@tiptap/react/LICENSE.md",
  "node_modules/@tiptap/starter-kit/LICENSE.md",
  "node_modules/fast-equals/LICENSE",
  "node_modules/linkifyjs/LICENSE",
  "node_modules/orderedmap/LICENSE",
  "node_modules/prosemirror-commands/LICENSE",
  "node_modules/prosemirror-dropcursor/LICENSE",
  "node_modules/prosemirror-gapcursor/LICENSE",
  "node_modules/prosemirror-history/LICENSE",
  "node_modules/prosemirror-keymap/LICENSE",
  "node_modules/prosemirror-model/LICENSE",
  "node_modules/prosemirror-schema-list/LICENSE",
  "node_modules/prosemirror-state/LICENSE",
  "node_modules/prosemirror-tables/LICENSE",
  "node_modules/prosemirror-transform/LICENSE",
  "node_modules/prosemirror-view/LICENSE",
  "node_modules/rope-sequence/LICENSE",
  "node_modules/use-sync-external-store/LICENSE",
  "node_modules/w3c-keyname/LICENSE"
];
for (const file of licences) {
  const text = fs.readFileSync(file, "utf8").trim();
  assert.ok(notice.includes(text), `packaged NOTICE must contain the complete licence from ${file}`);
}
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0];
assert.ok(packed.files.some((file: { path: string }) => file.path === "NOTICE"), "NOTICE must be included in the published package");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-markdown-notices-"));
try {
  const artifact = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", tempDir], { encoding: "utf8" }))[0];
  const tarball = path.join(tempDir, artifact.filename);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trimEnd().split("\n");
  for (const file of ["LICENSE", "NOTICE", "runtime/LICENSE", "runtime/NOTICE.md"]) {
    const entry = `package/${file}`;
    assert.equal(entries.filter((name) => name === entry).length, 1, `${entry} must appear exactly once`);
    if (file !== "LICENSE") {
      assert.deepEqual(execFileSync("tar", ["-xOzf", tarball, entry]), fs.readFileSync(file), `${entry} must match source bytes`);
    }
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
console.log("workspace Markdown notices smoke passed");
