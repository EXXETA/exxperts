import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createReadToolDefinition, type ReadOperations } from "../src/core/tools/read.js";
import { renderSpreadsheetPreview } from "../src/core/tools/spreadsheet-preview.js";

function workbookBuffer(sheets: Record<string, unknown[][]>): Buffer {
	const workbook = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) {
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
	}
	return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function numberedRows(rowCount: number, columnCount = 2): unknown[][] {
	const rows: unknown[][] = [];
	for (let row = 1; row <= rowCount; row += 1) {
		const values: unknown[] = [];
		for (let column = 1; column <= columnCount; column += 1) values.push(`r${row}c${column}`);
		rows.push(values);
	}
	return rows;
}

function operationsFor(buffer: Buffer): ReadOperations {
	return {
		readFile: async () => buffer,
		access: async () => {},
	};
}

function readToolFor(buffer: Buffer) {
	return createReadToolDefinition("/workbooks", { operations: operationsFor(buffer) });
}

function getTextOutput(result: { content: { type: string; text?: string }[] }): string {
	return (
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n") || ""
	);
}

describe("read tool spreadsheet preview", () => {
	it("previews the first sheet with the first row as the table header", async () => {
		const tool = readToolFor(workbookBuffer({ Data: [["Name", "Qty"], ["Ada", 1], ["Grace", 2]] }));
		const result = await tool.execute("sheet-1", { path: "book.xlsx" });
		const output = getTextOutput(result);
		expect(output).toContain("# Spreadsheet preview: book.xlsx");
		expect(output).toContain("Sheets (1):");
		expect(output).toContain("- 1. Data (3 rows × 2 columns)");
		expect(output).toContain("Selected sheet: Data");
		expect(output).toContain("Preview: 3 of 3 rows, 2 of 2 columns.");
		expect(output).toContain("| Name | Qty |\n| --- | --- |\n| Ada | 1 |\n| Grace | 2 |");
		expect(result.details?.spreadsheet).toMatchObject({
			path: "book.xlsx",
			workbook: "book.xlsx",
			sheet: "Data",
			sheetCount: 1,
			rows: 3,
			columns: 2,
			previewRows: 3,
			previewColumns: 2,
			formulaDetected: false,
			truncated: false,
		});
	});

	it("selects sheets by exact name, case-insensitive name, and 1-based index", async () => {
		const buffer = workbookBuffer({ Data: [["a"]], Summary: [["b", "c"], ["d", "e"]] });
		const tool = readToolFor(buffer);
		const byName = await tool.execute("sheet-2", { path: "book.xlsx", sheet: "Summary" });
		expect(getTextOutput(byName)).toContain("Selected sheet: Summary");
		const caseInsensitive = await tool.execute("sheet-3", { path: "book.xlsx", sheet: "summary" });
		expect(getTextOutput(caseInsensitive)).toContain("Selected sheet: Summary");
		const byIndex = await tool.execute("sheet-4", { path: "book.xlsx", sheet: 2 });
		expect(getTextOutput(byIndex)).toContain("Selected sheet: Summary");
		await expect(tool.execute("sheet-5", { path: "book.xlsx", sheet: "Nope" })).rejects.toThrow(
			/sheet was not found/,
		);
	});

	it("clamps the row limit to 100 and notes the next offset", async () => {
		const tool = readToolFor(workbookBuffer({ Data: numberedRows(120) }));
		const result = await tool.execute("rows-1", { path: "book.xlsx", limit: 500 });
		const output = getTextOutput(result);
		expect(output).toContain("Preview: 100 of 120 rows, 2 of 2 columns.");
		expect(output).toContain("Truncated preview: row cap 100, column cap 12.");
		expect(output).toContain("[Showing rows 1-100 of 120. Use offset=101 to continue.]");
		expect(result.details?.spreadsheet).toMatchObject({ previewRows: 100, truncated: true });
	});

	it("defaults to 30 rows when limit is omitted", async () => {
		const tool = readToolFor(workbookBuffer({ Data: numberedRows(120) }));
		const result = await tool.execute("rows-2", { path: "book.xlsx" });
		const output = getTextOutput(result);
		expect(output).toContain("Preview: 30 of 120 rows, 2 of 2 columns.");
		expect(output).toContain("[Showing rows 1-30 of 120. Use offset=31 to continue.]");
	});

	it("defaults to 12 columns and clamps the columns option to 30", async () => {
		const buffer = workbookBuffer({ Data: numberedRows(3, 40) });
		const tool = readToolFor(buffer);
		const defaulted = await tool.execute("cols-1", { path: "book.xlsx" });
		expect(getTextOutput(defaulted)).toContain("Preview: 3 of 3 rows, 12 of 40 columns.");
		const clamped = await tool.execute("cols-2", { path: "book.xlsx", columns: 35 });
		expect(getTextOutput(clamped)).toContain("Preview: 3 of 3 rows, 30 of 40 columns.");
	});

	it("pages rows via offset with a column-letter header", async () => {
		const tool = readToolFor(workbookBuffer({ Data: numberedRows(120) }));
		const result = await tool.execute("offset-1", { path: "book.xlsx", offset: 5, limit: 10 });
		const output = getTextOutput(result);
		expect(output).toContain("| A | B |\n| --- | --- |\n| r5c1 | r5c2 |");
		expect(output).toContain("| r14c1 | r14c2 |");
		expect(output).not.toContain("| r15c1 |");
		expect(output).toContain("[Showing rows 5-14 of 120. Use offset=15 to continue.]");
	});

	it("reports when the offset is beyond the sheet's rows", async () => {
		const tool = readToolFor(workbookBuffer({ Data: numberedRows(120) }));
		const result = await tool.execute("offset-2", { path: "book.xlsx", offset: 200 });
		expect(getTextOutput(result)).toContain("[Row offset 200 is beyond the sheet's 120 rows.]");
	});

	it("truncates long cells and warns about uncached formulas", async () => {
		const workbook = XLSX.utils.book_new();
		const sheet = XLSX.utils.aoa_to_sheet([["x".repeat(600), "y"]]);
		sheet.B1 = { t: "n", f: "1+1" };
		XLSX.utils.book_append_sheet(workbook, sheet, "Data");
		const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
		const tool = readToolFor(buffer);
		const result = await tool.execute("cells-1", { path: "book.xlsx" });
		const output = getTextOutput(result);
		expect(output).toContain(`${"x".repeat(500)}…`);
		expect(output).toContain("[Some cell values were truncated to 500 characters.]");
		expect(output).toContain("Warning: formula cells were detected.");
		expect(output).toContain("[formula; no cached value]");
		expect(result.details?.spreadsheet).toMatchObject({ formulaDetected: true, truncated: true });
	});

	it("reports an empty sheet", async () => {
		const tool = readToolFor(workbookBuffer({ Data: [] }));
		const result = await tool.execute("empty-1", { path: "book.xlsx" });
		expect(getTextOutput(result)).toContain("(selected sheet is empty)");
	});

	it("rejects workbooks above the 10MB limit", async () => {
		const tool = readToolFor(Buffer.alloc(10 * 1024 * 1024 + 1));
		await expect(tool.execute("large-1", { path: "book.xlsx" })).rejects.toThrow(/too large/);
	});

	it("routes only .xlsx paths (any case) to the spreadsheet preview", async () => {
		const buffer = workbookBuffer({ Data: [["Name"], ["Ada"]] });
		const tool = readToolFor(buffer);
		const textPath = await tool.execute("route-1", { path: "book.csv" });
		expect(getTextOutput(textPath)).not.toContain("# Spreadsheet preview");
		const upperCase = await tool.execute("route-2", { path: "BOOK.XLSX" });
		expect(getTextOutput(upperCase)).toContain("# Spreadsheet preview: BOOK.XLSX");
	});
});

describe("renderSpreadsheetPreview", () => {
	it("matches the golden preview for a small workbook", () => {
		const buffer = workbookBuffer({ Data: [["Name", "Qty"], ["Ada", 1], ["Grace", 2]] });
		const preview = renderSpreadsheetPreview(buffer, "golden.xlsx", {});
		expect(preview.text).toBe(
			[
				"# Spreadsheet preview: golden.xlsx",
				"",
				"Sheets (1):",
				"- 1. Data (3 rows × 2 columns)",
				"",
				"Selected sheet: Data",
				"Preview: 3 of 3 rows, 2 of 2 columns.",
				"",
				"| Name | Qty |",
				"| --- | --- |",
				"| Ada | 1 |",
				"| Grace | 2 |",
			].join("\n"),
		);
		expect(preview.details).toEqual({
			workbook: "golden.xlsx",
			sheet: "Data",
			sheetCount: 1,
			rows: 3,
			columns: 2,
			previewRows: 3,
			previewColumns: 2,
			formulaDetected: false,
			truncated: false,
		});
	});

	it("escapes pipes in cell values", () => {
		const buffer = workbookBuffer({ Data: [["a|b", "c"]] });
		const preview = renderSpreadsheetPreview(buffer, "pipes.xlsx", {});
		expect(preview.text).toContain("| a\\|b | c |");
	});
});
