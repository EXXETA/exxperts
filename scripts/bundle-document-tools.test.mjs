// Tests for the built document packages (scripts/bundle-document-tools.mjs).
//
//   npm run test:scripts   (bundle-release.test.mjs loads this file)
//
// The real list is installed and built once, which needs the npm registry.
// Each row then runs a .cjs from a temp folder, finding the packages through
// NODE_PATH as a room's script will. The files made there are read back with
// the root's yauzl, jsdom, SheetJS and pdf.js, which share no code with the
// packages that wrote them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "xlsx";
import yauzl from "yauzl";

import { DESKTOP_MAX_FILES } from "../apps/desktop/scripts/prune-payload.mjs";
import { bundleInstalled, installList, LICENCES_FILE } from "./bundle-document-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listDir = path.join(repoRoot, "apps", "document-tools");
const LOCKFILE_ARG = "--lockfile=./apps/document-tools/package-lock.json";

// Each package's real shape, as its own documentation has a CommonJS script
// use it. A built file that moves an export (onto `.default`, say) fails here.
const SHAPES = {
	"@xmldom/xmldom": `new (require("@xmldom/xmldom").DOMParser)().parseFromString("<a>x</a>", "text/xml").documentElement.textContent === "x"`,
	docx: `new (require("docx").Paragraph)("x") instanceof require("docx").Paragraph && typeof require("docx").Packer.toBuffer === "function"`,
	docxtemplater: `typeof require("docxtemplater") === "function" && typeof require("docxtemplater").Errors === "object"`,
	exceljs: `new (require("exceljs").Workbook)().addWorksheet("a").name === "a"`,
	jszip: `new (require("jszip"))().file("a", "b").files.a.name === "a" && typeof require("jszip").loadAsync === "function"`,
	"pdf-lib": `typeof require("pdf-lib").PDFDocument.create === "function"`,
	pizzip: `new (require("pizzip"))().file("a", "b").files.a.name === "a"`,
	"pptx-automizer": `typeof require("pptx-automizer").default === "function" && require("pptx-automizer").default === require("pptx-automizer").Automizer`,
	pptxgenjs: `typeof new (require("pptxgenjs"))().addSlide === "function"`,
};

const tempDirs = [];
function tempDir() {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "exxperts-document-tools-test-"));
	tempDirs.push(dir);
	return dir;
}

function makeTree(files) {
	const dir = tempDir();
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, ...rel.split("/"));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return dir;
}

function listFiles(dir) {
	return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
		.sort();
}

// The XML of every zip entry whose name matches, in name order, parsed.
function zipXml(file, namePattern) {
	return new Promise((resolve, reject) => {
		yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
			if (openError) return reject(openError);
			const parts = [];
			zip.on("error", reject);
			zip.on("end", () => resolve(parts.sort((a, b) => a.name.localeCompare(b.name)).map((part) => new JSDOM(part.xml, { contentType: "text/xml" }).window.document)));
			zip.on("entry", (entry) => {
				if (!namePattern.test(entry.fileName)) return zip.readEntry();
				zip.openReadStream(entry, (streamError, stream) => {
					if (streamError) return reject(streamError);
					const chunks = [];
					stream.on("data", (chunk) => chunks.push(chunk));
					stream.on("end", () => {
						parts.push({ name: entry.fileName, xml: Buffer.concat(chunks).toString("utf8") });
						zip.readEntry();
					});
				});
			});
			zip.readEntry();
		});
	});
}

const textsOf = (doc, tag) => Array.from(doc.getElementsByTagName(tag), (node) => node.textContent);

describe("the built document packages", () => {
	let installed;
	let built;
	let toolsDir;

	before(async () => {
		installed = tempDir();
		built = path.join(tempDir(), "document-tools");
		toolsDir = path.join(built, "node_modules");
		installList(listDir, installed);
		await bundleInstalled(installed, built);
	});
	after(() => {
		for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
	});

	function runCjs(source, args = []) {
		const dir = tempDir();
		const script = path.join(dir, "script.cjs");
		fs.writeFileSync(script, source);
		return execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: toolsDir } });
	}

	test("each package of the list is one file with its licences beside it", () => {
		const names = Object.keys(JSON.parse(fs.readFileSync(path.join(listDir, "package.json"), "utf8")).dependencies);
		assert.deepEqual(names.slice().sort(), Object.keys(SHAPES).sort());
		assert.deepEqual(listFiles(toolsDir), names.flatMap((name) => [`${name}/${LICENCES_FILE}`, `${name}/index.js`]).sort());
		assert.match(fs.readFileSync(path.join(toolsDir, "docx", LICENCES_FILE), "utf8"), /docx 9\.15\.2 \(MIT\)[\s\S]*Permission is hereby granted/);
		// An inlined package's licence, not only the named package's.
		assert.match(fs.readFileSync(path.join(toolsDir, "exceljs", LICENCES_FILE), "utf8"), /unzipper 0\.12\.3 \(MIT\)/);
	});

	test("the release's file limits hold unchanged, with the tools counted in the archive and outside the desktop's app folder", () => {
		const release = fs.readFileSync(path.join(repoRoot, "scripts", "bundle-release.mjs"), "utf8");
		assert.match(release, /^const MAX_ARCHIVE_FILES = 15_000;$/m);
		assert.equal(DESKTOP_MAX_FILES, 2_500);
		const build = release.indexOf('"bundle-document-tools.mjs"');
		assert.ok(build !== -1 && build < release.indexOf("const archiveFiles = countFiles(staging);"), "the tools are built before the archive's files are counted");
		assert.match(release.slice(build, release.indexOf("\n", build)), /path\.join\(stagingTop, "vendor", "document-tools"\)/);
		assert.equal(listFiles(built).length, 18);
	});

	test("the list holds the three forced versions, and buffers, which has no licence, is gone", () => {
		const version = (name) => JSON.parse(fs.readFileSync(path.join(installed, "node_modules", name, "package.json"), "utf8")).version;
		assert.equal(version("image-size"), "2.1.0");
		assert.equal(version("uuid"), "11.1.1");
		assert.equal(version("unzipper"), "0.12.3");
		assert.equal(fs.existsSync(path.join(installed, "node_modules", "buffers")), false);
	});

	test("the release's scan and both bills of materials read the list's lockfile", () => {
		const workflow = (name) => fs.readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");
		for (const name of ["release.yml", "sbom.yml"]) {
			assert.ok(workflow(name).includes(LOCKFILE_ARG), `${name} scans the lockfile`);
			assert.match(workflow(name), /cd \.\.\/document-tools && .*--output-file \.\.\/\.\.\/sbom-document-tools\.cdx\.json/);
		}
		assert.match(workflow("release.yml"), /gh release upload .*sbom-document-tools\.cdx\.json/);
		assert.match(workflow("sbom.yml"), /^\s+sbom-document-tools\.cdx\.json$/m);
		// What the public pages promise a release carries.
		for (const page of ["SECURITY.md", "docs/release-pipeline.md"]) {
			assert.match(fs.readFileSync(path.join(repoRoot, ...page.split("/")), "utf8"), /four CycloneDX SBOMs[^\n]*sbom-document-tools\.cdx\.json/, page);
		}
	});

	for (const [name, shape] of Object.entries(SHAPES)) {
		test(`${name} has its real shape from a .cjs`, () => {
			assert.equal(runCjs(`process.stdout.write(String(${shape}));`), "true");
			// The same type and export names as the installed package.
			const describeIt = `(m) => [typeof m, Object.keys(m).sort()]`;
			const output = runCjs(`const see = ${describeIt}; process.stdout.write(JSON.stringify([see(require(${JSON.stringify(name)})), see(require(require.resolve(${JSON.stringify(name)}, { paths: [${JSON.stringify(installed)}] })))]));`);
			const [fromBuilt, fromInstall] = JSON.parse(output);
			assert.deepEqual(fromBuilt, fromInstall);
		});
	}

	describe("files made from the built packages, read back by other code", () => {
		let out;

		before(() => {
			out = path.join(tempDir(), "made");
			runCjs(fs.readFileSync(path.join(listDir, "make-sample-files.cjs"), "utf8"), [out]);
		});

		test("a Word report", async () => {
			const [doc] = await zipXml(path.join(out, "report.docx"), /^word\/document\.xml$/);
			assert.deepEqual(textsOf(doc, "w:t"), ["Quarterly report", "Sales grew", " in the north.", "Region", "Sales", "North", "1200"]);
			assert.equal(doc.getElementsByTagName("w:tbl").length, 1);
			assert.equal(doc.getElementsByTagName("w:b").length, 1);
		});

		test("a filled Word template", async () => {
			const [doc] = await zipXml(path.join(out, "filled.docx"), /^word\/document\.xml$/);
			assert.deepEqual(textsOf(doc, "w:p").map((text) => text.trim()), ["Dear Carla,", "Your total is 2000."]);
		});

		test("a workbook, and the same workbook edited", () => {
			const sheet = XLSX.read(fs.readFileSync(path.join(out, "sales-edited.xlsx"))).Sheets.Sales;
			assert.equal(sheet.A1.v, "Region");
			assert.equal(sheet.B2.v, 1200);
			assert.equal(sheet.A4.v, "Total");
			assert.equal(sheet.B4.f, "SUM(B2:B3)");
			assert.equal(XLSX.read(fs.readFileSync(path.join(out, "sales.xlsx"))).Sheets.Sales.A4, undefined);
		});

		test("a deck with a table and a chart, and the deck read by hand", async () => {
			const [slide] = await zipXml(path.join(out, "deck.pptx"), /^ppt\/slides\/slide1\.xml$/);
			assert.deepEqual(textsOf(slide, "a:t"), ["Quarterly review", "Region", "Sales", "North", "1200"]);
			assert.equal((await zipXml(path.join(out, "deck.pptx"), /^ppt\/charts\/chart\d+\.xml$/)).length, 1);
			assert.equal(fs.readFileSync(path.join(out, "deck-text.txt"), "utf8"), "Quarterly review\nRegion\nSales\nNorth\n1200");
		});

		test("a deck reusing a slide of the first", async () => {
			const slides = await zipXml(path.join(out, "reused.pptx"), /^ppt\/slides\/slide\d+\.xml$/);
			assert.equal(slides.length, 2);
			for (const slide of slides) assert.ok(textsOf(slide, "a:t").includes("Quarterly review"));
		});

		test("a PDF", async () => {
			const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(path.join(out, "report.pdf"))), verbosity: 0 }).promise;
			assert.equal(pdf.numPages, 1);
			const { items } = await (await pdf.getPage(1)).getTextContent();
			assert.equal(items.map((item) => item.str).join(""), "Quarterly report, EUR 2000");
			await pdf.destroy();
		});
	});

	const list = (deps) => JSON.stringify({ name: "list", dependencies: deps });
	const manifest = (name, extra = {}) => JSON.stringify({ name, version: "1.0.0", main: "index.js", ...extra });

	test("a native file in the install fails the build, and names the file", async () => {
		const root = makeTree({
			"package.json": list({ plain: "1.0.0" }),
			"node_modules/plain/package.json": manifest("plain", { license: "MIT" }),
			"node_modules/plain/index.js": "module.exports = 1;\n",
			"node_modules/addon/package.json": manifest("addon", { license: "MIT" }),
			"node_modules/addon/build/Release/addon.node": "binary",
		});
		await assert.rejects(bundleInstalled(root, path.join(root, "out")), /native files:\n {2}- node_modules.addon.build.Release.addon\.node/);
		assert.equal(fs.existsSync(path.join(root, "out")), false);
	});

	test("a plain package with a file that only looks native builds", async () => {
		const root = makeTree({
			"package.json": list({ plain: "1.0.0" }),
			"node_modules/plain/package.json": manifest("plain", { license: "MIT" }),
			"node_modules/plain/index.js": "module.exports = 1;\n",
			"node_modules/plain/node.js": "module.exports = 2;\n",
			"node_modules/plain/notes.so.txt": "words\n",
		});
		await bundleInstalled(root, path.join(root, "out"));
		assert.deepEqual(listFiles(path.join(root, "out")), [`node_modules/plain/${LICENCES_FILE}`, "node_modules/plain/index.js"]);
	});

	test("an inlined package with no licence fails the build, and names the package", async () => {
		const root = makeTree({
			"package.json": list({ plain: "1.0.0" }),
			"node_modules/plain/package.json": manifest("plain", { license: "MIT" }),
			"node_modules/plain/index.js": 'module.exports = require("unlicensed");\n',
			"node_modules/unlicensed/package.json": manifest("unlicensed"),
			"node_modules/unlicensed/index.js": "module.exports = 1;\n",
		});
		await assert.rejects(bundleInstalled(root, path.join(root, "out")), /plain inlines packages with neither a licence file nor a license field: unlicensed 1\.0\.0/);
	});

	test("a licence file alone or a license field alone is enough, and each reaches the licences", async () => {
		const root = makeTree({
			"package.json": list({ plain: "1.0.0" }),
			"node_modules/plain/package.json": manifest("plain", { license: "MIT" }),
			"node_modules/plain/index.js": 'module.exports = require("with-file");\n',
			"node_modules/with-file/package.json": manifest("with-file"),
			"node_modules/with-file/LICENSE.md": "The text of the licence\n",
			"node_modules/with-file/index.js": "module.exports = 1;\n",
		});
		await bundleInstalled(root, path.join(root, "out"));
		const licences = fs.readFileSync(path.join(root, "out", "node_modules", "plain", LICENCES_FILE), "utf8");
		assert.match(licences, /plain 1\.0\.0 \(MIT\)\n=+\n\nThis package ships no licence file\./);
		assert.match(licences, /with-file 1\.0\.0 \(no license field\)[\s\S]*The text of the licence/);
	});

	test("a package that cannot be found fails the build", async () => {
		const root = makeTree({
			"package.json": list({ plain: "1.0.0" }),
			"node_modules/plain/package.json": manifest("plain", { license: "MIT" }),
			"node_modules/plain/index.js": 'module.exports = require("missing");\n',
		});
		await assert.rejects(bundleInstalled(root, path.join(root, "out")), /Could not resolve "missing"/);
	});
});
