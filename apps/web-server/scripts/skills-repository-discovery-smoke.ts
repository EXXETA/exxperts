import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withRepositoryProgress, readRepositoryProgress } from "../src/skills-repository-progress.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverRepositoryMaterials } from "../src/skills-repository-discovery.js";
import { repositoryTextReferences } from "../src/skills-markdown-references.js";
import { disposeAllCheckouts, reconfigureRepositoryScan, scanRepository } from "../src/skills-repo-fetch.js";
import { REFERENCE_KINDS } from "../src/skills-file-policy.js";

const files = new Set(["shared/theme.css", "shared/font.woff2", "shared/logo.svg", "other/duplicate.svg", "shared/icons/check.svg"]);
assert.deepEqual(repositoryTextReferences('@import "theme.css"; url("font.woff2"); url(data:image/png,x);', "shared/base.css", "styles", files), ["shared/font.woff2", "shared/theme.css"]);
assert.deepEqual(repositoryTextReferences('<img srcset="logo.svg 1x, https://example.invalid/hero.png 2x">', "shared/page.html", "html", files), ["shared/logo.svg"]);
assert.deepEqual(repositoryTextReferences(JSON.stringify({ icon: "logo.svg", directory: "icons/", bad: "duplicate.svg", version: "2024.10.14", link: "https://example.invalid/private.md" }), "shared/index.json", "text", files), ["shared/duplicate.svg", "shared/icons", "shared/logo.svg"], "JSON paths resolve exactly; no basename search or version-number guesses");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-repository-discovery-"));
const repo = path.join(work, "repo");
function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function write(relative: string, data: string | Buffer): void {
	const file = path.join(repo, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
}

try {
	fs.mkdirSync(repo);
	git("init", "-q", "-b", "main");
	git("config", "uploadpack.allowFilter", "true");
	write("skills/brand-a/SKILL.md", "---\nname: brand-a\n---\n[Instructions](references/start.md)\nCanonical icons: `shared/icons/`.\n[Missing](references/missing.md) [Program](references/evil.cmd) [Other](../brand-b/SKILL.md)\n[Linked](../../shared/linked.md) [Submodule](../../shared/submodule)\n");
	write("skills/brand-b/SKILL.md", "---\nname: brand-b\n---\n[Styles](../../shared/theme.css)\n");
	write("skills/large/SKILL.md", "---\nname: large\n---\n[Pictures](../../shared/big/)\n");
	write("skills/brand-a/references/start.md", "[Page](../../../shared/page.html)\nAsset index: `shared/index.json`.\n[Cycle](../../../shared/rules.md)\n");
	write("skills/brand-a/references/evil.cmd", "echo do-not-run > executed.txt\n");
	write("shared/rules.md", "[Cycle](../skills/brand-a/references/start.md)\n");
	write("shared/page.html", '<html><head><link href="theme.css"></head><body><img src="images/hero.png"><script src="run.js"></script></body></html>');
	write("shared/theme.css", '@import "more.css"; @font-face { src: url("fonts/brand.woff2"); }');
	write("shared/more.css", '@import "theme.css"; body { background: url("images/hero.png"); }');
	write("shared/index.json", JSON.stringify({ logo: "images/logo.svg", directory: "icons/", canonical: "shared/fonts/brand.woff2", notABasenameSearch: "duplicate.svg" }));
	write("shared/images/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><image href="hero.png"/></svg>');
	write("shared/icons/check.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv2sAAAAASUVORK5CYII=", "base64");
	write("shared/images/hero.png", png);
	write("shared/fonts/brand.woff2", "font metadata is not fetched by discovery");
	write("shared/run.js", "throw new Error('must never run');");
	write("shared/linked.md", "../outside.md");
	write("other/duplicate.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
	write("_source-material/manual.pdf", "%PDF-1.4\n");
	write("websites/unreferenced.html", "<html><body>Not referenced by any skill.</body></html>");
	for (let index = 0; index < 501; index += 1) write(`shared/big/image-${index}.png`, png);
	git("add", "-A");
	git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture");
	git("update-index", "--cacheinfo", `120000,${git("hash-object", "-w", "shared/linked.md")},shared/linked.md`);
	git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},shared/submodule`);
	git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "synthetic special Git entries");
	const scanProgressId = randomUUID();
	const scan = await withRepositoryProgress(scanProgressId, () => scanRepository(`${repo}#main`, { designRepo: true, allowedTypes: [...REFERENCE_KINDS], skillRoot: "skills", referenceRoots: ["."] }, "synthetic", true));
	assert.equal(readRepositoryProgress(scanProgressId)?.completed, scan.skills.length, "the real scanner reports every inspected skill manifest");
	const discoveryProgressId = randomUUID();
	const result = await withRepositoryProgress(discoveryProgressId, () => discoverRepositoryMaterials(scan.token, ["skills/brand-a", "skills/brand-b"]));
	assert.equal(readRepositoryProgress(discoveryProgressId)?.message, "Linked references checked");
	assert.equal(readRepositoryProgress(discoveryProgressId)?.completed, readRepositoryProgress(discoveryProgressId)?.total);
	const primary = new Map(result.referenced.map((file) => [file.path, file]));
	assert.equal(primary.get("shared/fonts/brand.woff2")?.selected, true, "recursive CSS dependencies are proposed");
	assert.deepEqual(primary.get("shared/fonts/brand.woff2")?.skillPaths, ["skills/brand-a", "skills/brand-b"], "shared dependencies retain both skill associations");
	assert.equal(primary.get("shared/icons/check.svg")?.selected, true, "referenced folders expand into material files");
	assert.equal(primary.get("shared/images/logo.svg")?.selected, true, "JSON indexes point to exact existing files");
	assert.equal(primary.get("shared/run.js")?.selected, false);
	assert.equal(primary.get("skills/brand-a/references/evil.cmd")?.selected, false);
	assert.equal(primary.get("skills/brand-b/SKILL.md")?.selected, false);
	assert.equal(primary.get("shared/linked.md")?.selected, false);
	assert.equal(primary.get("shared/submodule")?.selected, false);
	assert.equal(primary.has("other/duplicate.svg"), false, "a basename elsewhere is not a dependency");
	assert(result.missing.some((file) => file.path === "skills/brand-a/references/missing.md"));
	assert(result.missing.some((file) => file.path === "shared/duplicate.svg"));
	assert(result.additional.some((file) => file.path === "websites/unreferenced.html" && !file.selected));
	assert(result.additional.some((file) => file.path === "_source-material/manual.pdf" && !file.selected));
	assert(result.formats.some((format) => format.kind === "pdf" && format.additional === 1));
	assert.equal(result.incomplete, false, "cycles terminate without hiding valid dependencies");
	assert.equal(fs.existsSync(path.join(repo, "executed.txt")), false);
	const markdownOnly = await reconfigureRepositoryScan(scan.token, { designRepo: false, allowedTypes: ["markdown"], skillRoot: "skills", referenceRoots: ["."] }, "synthetic");
	const restricted = await discoverRepositoryMaterials(markdownOnly.token, ["skills/brand-a"]);
	assert(restricted.referenced.some((file) => file.path === "shared/page.html" && !file.allowed));
	assert(restricted.formats.some((format) => format.kind === "images" && !format.enabled), "found formats remain visible even when disabled");
	const big = await discoverRepositoryMaterials(scan.token, ["skills/large"]);
	assert.equal(big.referenced.filter((file) => file.selected).length, 501, "large folder discovery is not truncated at the old 500-name picker limit");
	assert(big.warnings.some((warning) => warning.includes("499")));
	await assert.rejects(discoverRepositoryMaterials(scan.token, ["no-such-skill"]), /not in this/);
	await assert.rejects(discoverRepositoryMaterials(scan.token, ["skills/brand-a", "skills/brand-a"]), /invalid/);
	console.log("skills-repository-discovery-smoke: OK");
} finally {
	disposeAllCheckouts();
	fs.rmSync(work, { recursive: true, force: true });
}
