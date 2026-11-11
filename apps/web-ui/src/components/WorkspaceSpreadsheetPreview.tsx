import { useEffect, useState, type CSSProperties } from "react";
import { apiFetch } from "../api";

type Border = { style: string; color: string };
type Style = { fill: string | null; font: { family: string; sizePt: number; color: string; bold: boolean; italic: boolean; underline: "none" | "single" | "double"; strike: boolean }; borders: { top: Border | null; right: Border | null; bottom: Border | null; left: Border | null }; align: { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom"; wrap: boolean } };
type Cell = { row: number; column: number; text: string; style: number; runs: { text: string; style: number }[] | null; valueKind: string };
type Sheet = { id: string; name: string; visibility: string; showGridLines: boolean; rowCount: number; columnCount: number; defaultRowHeightPx: number; defaultColumnWidthPx: number; rows: { index: number; heightPx: number }[]; columns: { index: number; widthPx: number }[]; cells: Cell[]; merges: { top: number; left: number; bottom: number; right: number }[] };
type Workbook = { dateSystem: "1900" | "1904"; styles: Style[]; sheets: Sheet[] };

const errorText: Record<string, string> = {
	invalid_request: "Choose a valid workspace file to preview.",
	invalid_path: "Choose a valid workspace file to preview.",
	not_file: "Choose a valid workspace file to preview.",
	workspace_read_forbidden: "This file is not available under the current workspace permissions.",
	blocked_by_policy: "This file is not available under the current workspace permissions.",
	outside_workspace: "This file is not available under the current workspace permissions.",
	grant_changed: "This file is not available under the current workspace permissions.",
	room_not_found: "This file is no longer available in this workspace.",
	conversation_not_found: "This file is no longer available in this workspace.",
	workspace_not_found: "This file is no longer available in this workspace.",
	file_not_found: "This file is no longer available in this workspace.",
	workspace_unavailable: "The workspace folder is not readable right now.",
	unsupported_file_type: "This file type cannot be previewed here.",
	expanded_content_too_large: "This file is too large or complex to preview here.",
	decoded_image_too_large: "This file is too large or complex to preview here.",
	unsupported_document_feature: "This document uses a feature that cannot be previewed here.",
	file_changed: "This file changed while the preview was loading; close the tab and open it again.",
	file_too_large: "This file is too large or complex to preview here.",
	preview_too_complex: "This file is too large or complex to preview here.",
	damaged_file: "This file is damaged or cannot be read.",
	encrypted_file: "Password-protected files cannot be previewed here.",
	renderer_unavailable: "Preview rendering is unavailable on this system.",
	preview_busy: "Another preview is loading; close this tab and open it again shortly.",
	preview_timeout: "This preview took too long to load.",
};

const color = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const dimension = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10_000;
const integer = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const keys = (value: unknown, names: string[]): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names.slice().sort().join(",");
const borderStyles = ["hair", "thin", "medium", "thick", "double", "dotted", "dashed", "dashDot", "dashDotDot", "mediumDashed", "mediumDashDot", "mediumDashDotDot", "slantDashDot"];

function validWorkbook(value: unknown): value is Workbook {
	if (!keys(value, ["dateSystem", "styles", "sheets"]) || !["1900", "1904"].includes(value.dateSystem) || !Array.isArray(value.styles) || value.styles.length < 1 || !Array.isArray(value.sheets) || value.sheets.length < 1) return false;
	for (const style of value.styles) {
		if (!keys(style, ["fill", "font", "borders", "align"]) || !(style.fill === null || color(style.fill)) || !keys(style.font, ["family", "sizePt", "color", "bold", "italic", "underline", "strike"]) || typeof style.font.family !== "string" || style.font.family.length < 1 || style.font.family.length > 128 || /[\x00-\x1f]/.test(style.font.family) || typeof style.font.sizePt !== "number" || !Number.isFinite(style.font.sizePt) || style.font.sizePt < 1 || style.font.sizePt > 409 || !color(style.font.color) || typeof style.font.bold !== "boolean" || typeof style.font.italic !== "boolean" || typeof style.font.strike !== "boolean" || !["none", "single", "double"].includes(style.font.underline) || !keys(style.borders, ["top", "right", "bottom", "left"]) || !keys(style.align, ["horizontal", "vertical", "wrap"]) || !["left", "center", "right"].includes(style.align.horizontal) || !["top", "middle", "bottom"].includes(style.align.vertical) || typeof style.align.wrap !== "boolean") return false;
		for (const border of Object.values(style.borders)) if (border !== null && (!keys(border, ["style", "color"]) || !borderStyles.includes(border.style) || !color(border.color))) return false;
	}
	let slots = 0, cells = 0;
	for (const [index, sheet] of value.sheets.entries()) {
		if (!keys(sheet, ["id", "name", "visibility", "showGridLines", "rowCount", "columnCount", "defaultRowHeightPx", "defaultColumnWidthPx", "rows", "columns", "cells", "merges"]) || typeof sheet.showGridLines !== "boolean" || sheet.id !== String(index + 1) || typeof sheet.name !== "string" || !sheet.name || !["visible", "hidden", "veryHidden"].includes(sheet.visibility) || !integer(sheet.rowCount, 0, 100_000) || !integer(sheet.columnCount, 0, 16_384) || ((sheet.rowCount === 0) !== (sheet.columnCount === 0)) || !dimension(sheet.defaultRowHeightPx) || !dimension(sheet.defaultColumnWidthPx) || !Array.isArray(sheet.rows) || !Array.isArray(sheet.columns) || !Array.isArray(sheet.cells) || !Array.isArray(sheet.merges)) return false;
		slots += sheet.rowCount * sheet.columnCount; cells += sheet.cells.length;
		if (slots > 200_000 || cells > 100_000) return false;
		for (const [entries, max, field] of [[sheet.rows, sheet.rowCount, "heightPx"], [sheet.columns, sheet.columnCount, "widthPx"]] as const) {
			let previous = 0;
			for (const entry of entries) { if (!keys(entry, ["index", field]) || !integer(entry.index, 1, max) || entry.index <= previous || !dimension(entry[field])) return false; previous = entry.index; }
		}
		let previous = 0;
		for (const cell of sheet.cells) {
			if (!keys(cell, ["row", "column", "text", "style", "runs", "valueKind"]) || !integer(cell.row, 1, sheet.rowCount) || !integer(cell.column, 1, sheet.columnCount) || typeof cell.text !== "string" || cell.text.length > 32_767 || !integer(cell.style, 0, value.styles.length - 1) || !["empty", "text", "number", "date", "boolean", "error", "formula-result", "formula-result-unavailable"].includes(cell.valueKind)) return false;
			const position = (cell.row - 1) * sheet.columnCount + cell.column;
			if (position <= previous) return false; previous = position;
			if (cell.runs !== null && (!Array.isArray(cell.runs) || !cell.runs.every((run: unknown) => keys(run, ["text", "style"]) && typeof run.text === "string" && integer(run.style, 0, value.styles.length - 1)) || cell.runs.map((run: { text: string }) => run.text).join("") !== cell.text)) return false;
		}
		const covered = new Set<number>();
		const anchors = new Set<number>();
		for (const merge of sheet.merges) {
			if (!keys(merge, ["top", "left", "bottom", "right"]) || !integer(merge.top, 1, sheet.rowCount) || !integer(merge.bottom, merge.top, sheet.rowCount) || !integer(merge.left, 1, sheet.columnCount) || !integer(merge.right, merge.left, sheet.columnCount)) return false;
			anchors.add((merge.top - 1) * sheet.columnCount + merge.left);
			for (let row = merge.top; row <= merge.bottom; row++) for (let column = merge.left; column <= merge.right; column++) { const pos = (row - 1) * sheet.columnCount + column; if (covered.has(pos)) return false; covered.add(pos); }
		}
		for (const cell of sheet.cells) { const pos = (cell.row - 1) * sheet.columnCount + cell.column; if (covered.has(pos) && !anchors.has(pos)) return false; }
	}
	return true;
}

function fontStyle(style: Style): CSSProperties {
	return { fontFamily: style.font.family, fontSize: `${style.font.sizePt}pt`, color: style.font.color, fontWeight: style.font.bold ? "bold" : "normal", fontStyle: style.font.italic ? "italic" : "normal", textDecorationLine: [style.font.underline !== "none" ? "underline" : "", style.font.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none", textDecorationStyle: style.font.underline === "double" ? "double" : "solid" };
}
function border(value: Border | null): string | undefined {
	if (!value) return undefined;
	const width = value.style === "hair" ? 0.5 : value.style === "thick" || value.style === "double" ? 3 : value.style.startsWith("medium") ? 2 : 1;
	const kind = value.style === "double" ? "double" : value.style === "dotted" ? "dotted" : /dash/i.test(value.style) ? "dashed" : "solid";
	return `${width}px ${kind} ${value.color}`;
}

function columnName(index: number): string {
	let name = "";
	for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
	return name;
}

// Like a sheet in Excel, the grid runs on past the last filled cell.
const MIN_ROWS = 40, MIN_COLUMNS = 12, ROW_HEADER_PX = 44;

export function WorkspaceSpreadsheetPreview({ agentId, conversationId, path }: { agentId: string; conversationId: string; path: string }) {
	const [workbook, setWorkbook] = useState<Workbook | null>(null);
	const [sheetIndex, setSheetIndex] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [notices, setNotices] = useState<string[]>([]);
	useEffect(() => {
		const controller = new AbortController();
		const query = new URLSearchParams({ conversationId, path });
		void apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-preview?${query}`, { signal: controller.signal }).then(async (response) => {
			const body = await response.json();
			if (!response.ok) { if (!controller.signal.aborted) setError(response.status === 401 ? "Sign in to preview this file." : errorText[body?.code] ?? "This file could not be previewed."); return; }
			const noticeCopy: Record<string, string> = { excel_charts_omitted: "Charts are not shown in this preview.", excel_unusual_formatting: "Some unusual spreadsheet formatting is not shown." };
			if (body?.schemaVersion !== 1 || body.agentId !== agentId || body.conversationId !== conversationId || body.path !== path || body.kind !== "spreadsheet" || !Array.isArray(body.notices) || !body.notices.every((notice: unknown) => keys(notice, ["code", "text"]) && typeof notice.code === "string" && noticeCopy[notice.code] === notice.text) || !validWorkbook(body.workbook)) throw new Error("Invalid preview");
			if (!controller.signal.aborted) { setNotices(body.notices.map((notice: { text: string }) => notice.text)); setWorkbook(body.workbook); }
		}).catch(() => { if (!controller.signal.aborted) setError("This file could not be previewed."); });
		return () => controller.abort();
	}, [agentId, conversationId, path]);
	if (!workbook) return <p>{error ?? "Loading preview…"}</p>;
	const sheet = workbook.sheets[sheetIndex];
	const cells = new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
	const merges = new Map(sheet.merges.map((merge) => [`${merge.top}:${merge.left}`, merge]));
	const covered = new Set<string>();
	for (const merge of sheet.merges) for (let row = merge.top; row <= merge.bottom; row++) for (let column = merge.left; column <= merge.right; column++) if (row !== merge.top || column !== merge.left) covered.add(`${row}:${column}`);
	const heights = new Map(sheet.rows.map((row) => [row.index, row.heightPx]));
	const widths = new Map(sheet.columns.map((column) => [column.index, column.widthPx]));
	const rowCount = Math.max(sheet.rowCount, MIN_ROWS), columnCount = Math.max(sheet.columnCount, MIN_COLUMNS);
	const tableWidth = Array.from({ length: columnCount }, (_, index) => widths.get(index + 1) ?? sheet.defaultColumnWidthPx).reduce((sum, width) => sum + width, ROW_HEADER_PX);
	return <div className="workspace-spreadsheet">{notices.map((notice) => <p key={notice}>{notice}</p>)}{sheet.rowCount === 0 ? <p>This sheet is empty.</p> : <div className="workspace-spreadsheet-scroll"><table data-gridlines={sheet.showGridLines} style={{ width: tableWidth }}><colgroup><col style={{ width: ROW_HEADER_PX }} />{Array.from({ length: columnCount }, (_, index) => <col key={index} style={{ width: widths.get(index + 1) ?? sheet.defaultColumnWidthPx }} />)}</colgroup><thead><tr><th className="workspace-spreadsheet-corner" aria-hidden="true" />{Array.from({ length: columnCount }, (_, index) => <th key={index} scope="col">{columnName(index + 1)}</th>)}</tr></thead><tbody>{Array.from({ length: rowCount }, (_, rowIndex) => <tr key={rowIndex} style={{ height: heights.get(rowIndex + 1) ?? sheet.defaultRowHeightPx }}><th scope="row">{rowIndex + 1}</th>{Array.from({ length: columnCount }, (_, columnIndex) => {
		const key = `${rowIndex + 1}:${columnIndex + 1}`;
		if (covered.has(key)) return null;
		const cell = cells.get(key), merge = merges.get(key), style = workbook.styles[cell?.style ?? 0];
		// A filled cell hides the gridlines around it, as in Excel.
		const fillEdge = style.fill ? `1px solid ${style.fill}` : undefined;
		return <td key={key} rowSpan={merge ? merge.bottom - merge.top + 1 : undefined} colSpan={merge ? merge.right - merge.left + 1 : undefined} style={{ ...fontStyle(style), backgroundColor: style.fill ?? "#FFFFFF", borderTop: border(style.borders.top) ?? fillEdge, borderRight: border(style.borders.right) ?? fillEdge, borderBottom: border(style.borders.bottom) ?? fillEdge, borderLeft: border(style.borders.left) ?? fillEdge, textAlign: style.align.horizontal, verticalAlign: style.align.vertical, whiteSpace: style.align.wrap ? "normal" : "nowrap" }} aria-label={cell?.valueKind === "formula-result-unavailable" ? `${cell.text} No calculated value is stored in this file.` : undefined}>{cell?.runs ? cell.runs.map((run, index) => <span key={index} style={fontStyle(workbook.styles[run.style])}>{run.text}</span>) : cell?.text}</td>;
	})}</tr>)}</tbody></table></div>}<div className="workspace-spreadsheet-sheets" aria-label="Workbook sheets">{workbook.sheets.map((item, index) => <button type="button" key={item.id} aria-pressed={index === sheetIndex} onClick={() => setSheetIndex(index)}>{item.name}</button>)}</div></div>;
}
