import assert from "node:assert/strict";
import JSZip from "jszip";
import { normalizeRepoPath, normalizeRepositoryFilePolicy, referencePathPermission, validateReferenceBuffer } from "../src/skills-file-policy.js";

const basic = normalizeRepositoryFilePolicy();
const design = normalizeRepositoryFilePolicy({ designRepo: true, allowedTypes: ["markdown", "text", "styles", "html", "svg", "pdf", "word", "excel", "images", "fonts"], referenceRoots: ["brands"] });
assert.deepEqual(basic.allowedTypes, ["markdown"]);
assert.equal(referencePathPermission("notes.md", basic).allowed, true);
for (const file of ["colors.css", "brand.pdf", "logo.svg", "font.ttf", "book.xlsx", "document.docx", "photo.png"]) assert.equal(referencePathPermission(file, basic).allowed, false, `${file} is opt-in`);
for (const file of ["run.ts", "run.js", "run.sh", "run.ps1", "run.py", "code.exe", "data.zip", "data.docm", "data.xlsm"]) assert.equal(referencePathPermission(file, design).allowed, false, `${file} remains blocked`);
assert.throws(() => normalizeRepositoryFilePolicy({ allowedTypes: ["pdf"] }), /design repository/);
assert.throws(() => normalizeRepositoryFilePolicy({ designRepo: "true" }), /boolean/);
assert.throws(() => normalizeRepositoryFilePolicy({ designRepo: true, allowedTypes: ["javascript"] }), /unsupported/);
for (const file of ["../secret.md", "a/../secret.md", "C:/secret.md", "/secret.md", "a\\secret.md", "a//secret.md", "NUL.md", "con/file.md", "folder./file.md", "a\u0000.md"]) assert.throws(() => normalizeRepoPath(file), /invalid|unsafe/, file);
assert.equal(referencePathPermission("provenance.json", design).allowed, false);
assert.equal(referencePathPermission("palette.json", basic).allowed, false, "JSON remains opt-in");
assert.equal((await validateReferenceBuffer("palette.json", Buffer.from('{"primary":"#123456"}'), design)).preview, '{"primary":"#123456"}');
await assert.rejects(validateReferenceBuffer("palette.json", Buffer.from("export default {}"), design), /valid JSON/);
assert.equal(referencePathPermission(".skill-references/a.md", design).allowed, false);
assert.equal((await validateReferenceBuffer("brand/colors.scss", Buffer.from("$brand: #123456;"), design)).preview, "$brand: #123456;");
assert.equal((await validateReferenceBuffer("logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>external()</script></svg>'), design)).kind, "svg");
assert.equal((await validateReferenceBuffer("example.html", Buffer.from('<script src="https://example.invalid/blocked.js"></script>'), design)).kind, "html");
await assert.rejects(validateReferenceBuffer("fake.css", Buffer.from("%PDF-1.4\n"), design), /binary/);
await assert.rejects(validateReferenceBuffer("fake.md", Buffer.from([0xff, 0xfe]), design), /UTF-8/);
await assert.rejects(validateReferenceBuffer("lfs.md", Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 1\n"), design), /LFS/);
await assert.rejects(validateReferenceBuffer("large.md", Buffer.alloc(512 * 1024 + 1, 65), design), /512 KiB/);
await assert.rejects(validateReferenceBuffer("fake.pdf", Buffer.from("just text"), design), /extension/);
assert.equal((await validateReferenceBuffer("brand.pdf", Buffer.from("%PDF-1.4\n"), design)).kind, "pdf");
assert.equal((await validateReferenceBuffer("font.ttf", Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), design)).kind, "fonts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZAAAAABJRU5ErkJggg==", "base64");
assert.equal((await validateReferenceBuffer("logo.png", png, design)).mimeType, "image/png");
await assert.rejects(validateReferenceBuffer("logo.jpg", png, design), /extension/);
const word = new JSZip();
word.file("[Content_Types].xml", '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
word.file("word/document.xml", "<document><body>Brand manual</body></document>");
assert.equal((await validateReferenceBuffer("manual.docx", await word.generateAsync({ type: "nodebuffer" }), design)).kind, "word");
word.file("word/vbaProject.bin", "macro");
await assert.rejects(validateReferenceBuffer("manual.docx", await word.generateAsync({ type: "nodebuffer" }), design), /macros/);
const excel = new JSZip();
excel.file("[Content_Types].xml", '<Types><Default Extension="xlsb" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>');
excel.file("xl/workbook.xml", "<workbook/>");
assert.equal((await validateReferenceBuffer("palette.xlsx", await excel.generateAsync({ type: "nodebuffer" }), design)).kind, "excel");
excel.file("xl/embeddings/executable.bin", "embedded payload");
await assert.rejects(validateReferenceBuffer("palette.xlsx", await excel.generateAsync({ type: "nodebuffer" }), design), /embedded programs/);
const bomb = new JSZip();
bomb.file("[Content_Types].xml", Buffer.alloc(512 * 1024 + 1, 65));
bomb.file("word/document.xml", "<document/>");
const compressed = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
assert.ok(compressed.length < 2048, "high-expansion fixture remains a small archive");
// Lie in both headers: safety must count streamed bytes rather than trust the ZIP sizes.
let forgedHeaders = 0;
for (let index = 0; index < compressed.length - 46; index += 1) {
	if (compressed.readUInt32LE(index) === 0x02014b50 && compressed.subarray(index + 46, index + 65).toString() === "[Content_Types].xml") { compressed.writeUInt32LE(1, index + 24); forgedHeaders += 1; }
	if (compressed.readUInt32LE(index) === 0x04034b50 && compressed.subarray(index + 30, index + 49).toString() === "[Content_Types].xml") { compressed.writeUInt32LE(1, index + 22); forgedHeaders += 1; }
}
assert.equal(forgedHeaders, 2, "both declared uncompressed sizes were forged");
await assert.rejects(validateReferenceBuffer("bomb.docx", compressed, design), /limit|validated/);
console.log("skills-file-policy-smoke: OK");
