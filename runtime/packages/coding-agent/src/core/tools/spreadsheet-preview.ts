import { extname } from "node:path";
import * as XLSX from "xlsx";

export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;
export const DEFAULT_SPREADSHEET_MAX_ROWS = 30;
export const MAX_SPREADSHEET_ROWS = 100;
export const DEFAULT_SPREADSHEET_MAX_COLUMNS = 12;
export const MAX_SPREADSHEET_COLUMNS = 30;
export const MAX_SPREADSHEET_CELL_CHARS = 500;
export const MAX_SPREADSHEET_OUTPUT_CHARS = 50 * 1024;

export type SpreadsheetPreviewErrorCode = "not_readable" | "empty_workbook" | "sheet_not_found";

export class SpreadsheetPreviewError extends Error {
	readonly code: SpreadsheetPreviewErrorCode;

	constructor(code: SpreadsheetPreviewErrorCode, message: string) {
		super(message);
		this.name = "SpreadsheetPreviewError";
		this.code = code;
	}
}

export interface SpreadsheetPreviewOptions {
	/** Sheet name (exact, then case-insensitive) or 1-based sheet index. Defaults to the first sheet. */
	sheet?: string | number;
	/** 1-based row offset within the sheet's used range. Defaults to 1. */
	startRow?: number;
	/** Maximum rows to preview (default 30, hard cap 100). */
	maxRows?: number;
	/** Maximum columns to preview (default 12, hard cap 30). */
	maxColumns?: number;
}

export function isSpreadsheetPath(filePath: string): boolean {
	return extname(filePath).toLowerCase() === ".xlsx";
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || Number.isNaN(value)) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

function normalizeStartRow(value: number | undefined): number {
	if (value === undefined || Number.isNaN(value)) return 1;
	if (!Number.isFinite(value) || value < 1) return 1;
	return Math.floor(value);
}

function workbookSheetRange(sheet: XLSX.WorkSheet | undefined): XLSX.Range | null {
	const ref = String(sheet?.["!ref"] ?? "").trim();
	if (!ref) return null;
	try {
		return XLSX.utils.decode_range(ref);
	} catch {
		return null;
	}
}

function rangeDimensions(range: XLSX.Range | null): { rows: number; columns: number } {
	if (!range) return { rows: 0, columns: 0 };
	return {
		rows: Math.max(0, range.e.r - range.s.r + 1),
		columns: Math.max(0, range.e.c - range.s.c + 1),
	};
}

function sheetDisplayName(value: string): string {
	return value.replace(/\r?\n/g, " ").slice(0, 80) || "(unnamed sheet)";
}

function resolveSpreadsheetSheetName(workbook: XLSX.WorkBook, requested: SpreadsheetPreviewOptions["sheet"]): string {
	const sheetNames = workbook.SheetNames ?? [];
	if (sheetNames.length === 0) {
		throw new SpreadsheetPreviewError("empty_workbook", "Workbook does not contain readable sheets.");
	}
	if (requested === undefined || requested === null || String(requested).trim() === "") return sheetNames[0]!;
	if (typeof requested === "number") {
		const index = Math.floor(requested);
		if (!Number.isFinite(index) || index < 1 || index > sheetNames.length) {
			throw new SpreadsheetPreviewError("sheet_not_found", "Requested sheet was not found in the workbook.");
		}
		return sheetNames[index - 1]!;
	}
	const requestedName = String(requested).trim();
	const exact = sheetNames.find((name) => name === requestedName);
	if (exact) return exact;
	const lower = requestedName.toLowerCase();
	const caseInsensitive = sheetNames.find((name) => name.toLowerCase() === lower);
	if (caseInsensitive) return caseInsensitive;
	throw new SpreadsheetPreviewError("sheet_not_found", "Requested sheet was not found in the workbook.");
}

function spreadsheetCellText(cell: XLSX.CellObject | undefined): { text: string; formula: boolean; truncated: boolean } {
	if (!cell) return { text: "", formula: false, truncated: false };
	const formula = typeof (cell as any).f === "string" && (cell as any).f.length > 0;
	let value = "";
	if (typeof cell.w === "string") value = cell.w;
	else if (cell.v instanceof Date) value = cell.v.toISOString().slice(0, 10);
	else if (cell.v !== undefined && cell.v !== null) value = String(cell.v);
	else if (formula) value = "[formula; no cached value]";
	value = value.replace(/\r?\n/g, " ").trim();
	const truncated = value.length > MAX_SPREADSHEET_CELL_CHARS;
	if (truncated) value = `${value.slice(0, MAX_SPREADSHEET_CELL_CHARS)}…`;
	return { text: value, formula, truncated };
}

function markdownTableCell(value: string): string {
	return value.replace(/\|/g, "\\|");
}

function boundedSpreadsheetOutput(lines: string[]): { text: string; truncated: boolean } {
	const text = lines.join("\n");
	if (text.length <= MAX_SPREADSHEET_OUTPUT_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, MAX_SPREADSHEET_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_SPREADSHEET_OUTPUT_CHARS / 1024}KB. Use a smaller sheet/row/column preview.]`,
		truncated: true,
	};
}

function sheetContainsFormula(sheet: XLSX.WorkSheet | undefined): boolean {
	if (!sheet) return false;
	return Object.entries(sheet).some(([address, cell]) => !address.startsWith("!") && typeof (cell as any)?.f === "string" && (cell as any).f.length > 0);
}

export function renderSpreadsheetPreview(
	buffer: Buffer,
	workbookDisplayName: string,
	options: SpreadsheetPreviewOptions = {},
): { text: string; details: Record<string, unknown> } {
	let workbook: XLSX.WorkBook;
	try {
		workbook = XLSX.read(buffer, {
			type: "buffer",
			cellDates: true,
			cellFormula: true,
			cellHTML: false,
			cellNF: false,
			cellStyles: false,
		});
	} catch {
		throw new SpreadsheetPreviewError("not_readable", "Workbook cannot be read.");
	}

	const sheetName = resolveSpreadsheetSheetName(workbook, options.sheet);
	const sheet = workbook.Sheets[sheetName];
	const range = workbookSheetRange(sheet);
	const dimensions = rangeDimensions(range);
	const maxRows = normalizeLimit(options.maxRows, DEFAULT_SPREADSHEET_MAX_ROWS, MAX_SPREADSHEET_ROWS);
	const maxColumns = normalizeLimit(options.maxColumns, DEFAULT_SPREADSHEET_MAX_COLUMNS, MAX_SPREADSHEET_COLUMNS);
	const startRow = normalizeStartRow(options.startRow);
	const previewRows = Math.max(0, Math.min(maxRows, dimensions.rows - (startRow - 1)));
	const previewColumns = Math.min(dimensions.columns, maxColumns);
	const formulaDetected = sheetContainsFormula(sheet);
	let cellTruncated = false;

	const lines: string[] = [];
	lines.push(`# Spreadsheet preview: ${workbookDisplayName}`);
	lines.push("");
	lines.push(`Sheets (${workbook.SheetNames.length}):`);
	for (const [index, name] of workbook.SheetNames.entries()) {
		const sheetRange = workbookSheetRange(workbook.Sheets[name]);
		const sheetDimensions = rangeDimensions(sheetRange);
		lines.push(`- ${index + 1}. ${sheetDisplayName(name)} (${sheetDimensions.rows} rows × ${sheetDimensions.columns} columns)`);
	}
	lines.push("");
	lines.push(`Selected sheet: ${sheetDisplayName(sheetName)}`);
	lines.push(`Preview: ${previewRows} of ${dimensions.rows} rows, ${previewColumns} of ${dimensions.columns} columns.`);
	if (dimensions.rows > maxRows || dimensions.columns > maxColumns) {
		lines.push(`Truncated preview: row cap ${maxRows}, column cap ${maxColumns}.`);
	}
	if (formulaDetected) {
		lines.push("Warning: formula cells were detected. Formulas were not evaluated; cached/display values are shown where available.");
	}
	lines.push("");

	if (!range || dimensions.rows === 0 || previewColumns === 0) {
		lines.push("(selected sheet is empty)");
	} else if (startRow > dimensions.rows) {
		lines.push(`[Row offset ${startRow} is beyond the sheet's ${dimensions.rows} rows.]`);
	} else {
		const firstRow = range.s.r + (startRow - 1);
		const rows: string[][] = [];
		for (let row = firstRow; row < firstRow + previewRows; row += 1) {
			const values: string[] = [];
			for (let column = range.s.c; column < range.s.c + previewColumns; column += 1) {
				const address = XLSX.utils.encode_cell({ r: row, c: column });
				const cell = spreadsheetCellText(sheet?.[address]);
				if (cell.truncated) cellTruncated = true;
				values.push(markdownTableCell(cell.text));
			}
			rows.push(values);
		}
		if (startRow === 1) {
			const header = rows[0] ?? [];
			lines.push(`| ${header.join(" | ")} |`);
			lines.push(`| ${header.map(() => "---").join(" | ")} |`);
			for (const row of rows.slice(1)) lines.push(`| ${row.join(" | ")} |`);
		} else {
			const letters: string[] = [];
			for (let column = range.s.c; column < range.s.c + previewColumns; column += 1) {
				letters.push(XLSX.utils.encode_col(column));
			}
			lines.push(`| ${letters.join(" | ")} |`);
			lines.push(`| ${letters.map(() => "---").join(" | ")} |`);
			for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
		}
	}
	if (cellTruncated) lines.push("\n[Some cell values were truncated to 500 characters.]");
	const lastPreviewRow = startRow + previewRows - 1;
	if (previewRows > 0 && lastPreviewRow < dimensions.rows) {
		lines.push(`\n[Showing rows ${startRow}-${lastPreviewRow} of ${dimensions.rows}. Use offset=${lastPreviewRow + 1} to continue.]`);
	}
	const bounded = boundedSpreadsheetOutput(lines);
	return {
		text: bounded.text,
		details: {
			workbook: workbookDisplayName,
			sheet: sheetName,
			sheetCount: workbook.SheetNames.length,
			rows: dimensions.rows,
			columns: dimensions.columns,
			previewRows,
			previewColumns,
			formulaDetected,
			truncated: bounded.truncated || cellTruncated || dimensions.rows > maxRows || dimensions.columns > maxColumns,
		},
	};
}
