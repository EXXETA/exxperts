// Makes one file of each kind with the built document packages, the way a
// room's script will: a .cjs that finds them by name through NODE_PATH.
//
//   NODE_PATH=<folder>/node_modules node make-sample-files.cjs <out folder>
//
// Run a copy from a folder outside the repository: from here, require would
// find the root node_modules before NODE_PATH. Used by
// scripts/bundle-document-tools.test.mjs and scripts/smoke-release-archive.mjs;
// a change to the words here changes what they read back.
const fs = require("node:fs");
const path = require("node:path");

async function makeWord(out) {
	const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = require("docx");
	const cell = (text) => new TableCell({ children: [new Paragraph(text)] });
	const report = new Document({
		sections: [{
			children: [
				new Paragraph({ text: "Quarterly report", heading: HeadingLevel.HEADING_1 }),
				new Paragraph({ children: [new TextRun({ text: "Sales grew", bold: true }), new TextRun(" in the north.")] }),
				new Table({ rows: [new TableRow({ children: [cell("Region"), cell("Sales")] }), new TableRow({ children: [cell("North"), cell("1200")] })] }),
			],
		}],
	});
	fs.writeFileSync(path.join(out, "report.docx"), await Packer.toBuffer(report));
}

async function fillWordTemplate(out) {
	const { Document, Packer, Paragraph } = require("docx");
	const Docxtemplater = require("docxtemplater");
	const PizZip = require("pizzip");
	const template = new Document({ sections: [{ children: [new Paragraph("Dear {name},"), new Paragraph("Your total is {total}.")] }] });
	const filled = new Docxtemplater(new PizZip(await Packer.toBuffer(template)), { paragraphLoop: true, linebreaks: true });
	filled.render({ name: "Carla", total: "2000" });
	fs.writeFileSync(path.join(out, "filled.docx"), filled.getZip().generate({ type: "nodebuffer" }));
}

async function makeAndEditExcel(out) {
	const { Workbook } = require("exceljs");
	const made = new Workbook();
	const sheet = made.addWorksheet("Sales");
	sheet.addRows([["Region", "Sales"], ["North", 1200], ["South", 800]]);
	sheet.getCell("A1").font = { bold: true };
	sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE7FF" } };
	sheet.getCell("B4").value = { formula: "SUM(B2:B3)", result: 2000 };
	await made.xlsx.writeFile(path.join(out, "sales.xlsx"));

	const edited = new Workbook();
	await edited.xlsx.readFile(path.join(out, "sales.xlsx"));
	edited.getWorksheet("Sales").getCell("A4").value = "Total";
	await edited.xlsx.writeFile(path.join(out, "sales-edited.xlsx"));
}

async function makeDeck(out) {
	const PptxGenJS = require("pptxgenjs");
	const deck = new PptxGenJS();
	const slide = deck.addSlide();
	slide.addText("Quarterly review", { x: 1, y: 1, w: 8, h: 1, fontSize: 28, bold: true });
	slide.addTable([["Region", "Sales"], ["North", "1200"]], { x: 1, y: 2, w: 6 });
	slide.addChart(deck.ChartType.bar, [{ name: "Sales", labels: ["North", "South"], values: [1200, 800] }], { x: 1, y: 3.2, w: 6, h: 2 });
	await deck.writeFile({ fileName: path.join(out, "deck.pptx") });
}

async function reuseDeck(out) {
	const { default: Automizer } = require("pptx-automizer");
	const automizer = new Automizer({ templateDir: out, outputDir: out, removeExistingSlides: false, autoImportSlideMasters: false, verbosity: 0 });
	const presentation = automizer.loadRoot("deck.pptx").load("deck.pptx", "company");
	presentation.addSlide("company", 1);
	await presentation.write("reused.pptx");
}

async function readDeckByHand(out) {
	const JSZip = require("jszip");
	const { DOMParser } = require("@xmldom/xmldom");
	const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, "deck.pptx")));
	const xml = await zip.file("ppt/slides/slide1.xml").async("string");
	const texts = new DOMParser().parseFromString(xml, "text/xml").getElementsByTagName("a:t");
	fs.writeFileSync(path.join(out, "deck-text.txt"), Array.from(texts, (node) => node.textContent).join("\n"));
}

async function makePdf(out) {
	const { PDFDocument, StandardFonts } = require("pdf-lib");
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	pdf.addPage().drawText("Quarterly report, EUR 2000", { x: 50, y: 700, size: 18, font });
	fs.writeFileSync(path.join(out, "report.pdf"), await pdf.save());
}

async function main() {
	const out = path.resolve(process.argv[2]);
	fs.mkdirSync(out, { recursive: true });
	await makeWord(out);
	await fillWordTemplate(out);
	await makeAndEditExcel(out);
	await makeDeck(out);
	await reuseDeck(out);
	await readDeckByHand(out);
	await makePdf(out);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
