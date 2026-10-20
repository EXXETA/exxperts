import assert from "node:assert/strict";
import { skillFilePreview } from "../src/skills-file-preview.js";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";

assert.equal((await skillFilePreview("skills/a/SKILL.md", Buffer.from("# Main instructions"))).kind, "markdown");
assert.equal((await skillFilePreview("run.cmd", Buffer.from("echo must-not-execute"))).text, "echo must-not-execute");
assert.equal((await skillFilePreview("layout.html", Buffer.from("<h1>Layout</h1><script>must-not-execute()</script>"))).kind, "html");
assert.equal((await skillFilePreview("logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'))).kind, "svg");
await assert.rejects(skillFilePreview("invalid.svg", Buffer.from("not svg")), /SVG root/);
await assert.rejects(skillFilePreview("binary.cmd", Buffer.from([0xff, 0xfe])), /UTF-8/);
await assert.rejects(skillFilePreview("large.md", Buffer.alloc(512 * 1024 + 1)), /512 KiB/);
await assert.rejects(skillFilePreview("bad.md", Buffer.from("version https://git-lfs.github.com/spec/v1\n")), /Git LFS/);
const pdf = await skillFilePreview("guide.pdf", Buffer.from("%PDF-1.4\n"));
assert.equal(pdf.mimeType, "application/pdf");
assert.equal(Buffer.from(pdf.base64!, "base64").toString(), "%PDF-1.4\n");
assert.equal(classifyRemoteRoute("POST", "/api/skills/repo/preview"), "local");
assert.equal(classifyRemoteRoute("GET", "/api/skills/:id/references/:reference/preview"), "local");
console.log("skills-file-preview-smoke: OK");
