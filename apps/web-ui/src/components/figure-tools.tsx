import { type ReactNode } from "react";
import { CheckIcon, CopyIcon, useCopiedFlag } from "./CopyButton";
import { copyPng, svgPng } from "../png-picture";

// The tools a figure in an answer carries (a chart, a diagram, code): one
// quiet row, a switch of words and icon tools, Copy always the right-most,
// so it stands at the same spot on every figure.

const icon = { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function ExpandIcon() {
	return <svg {...icon}><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" /></svg>;
}

/** The slim strip on top of a diagram or code: a quiet label, then the tools. */
export function FigureStrip({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
	return (
		<span className={`figure-strip${className ? ` ${className}` : ""}`}>
			{label && <span className="figure-strip-label">{label}</span>}
			{children}
		</span>
	);
}

/** The tools' row. Copy's slot keeps its place with nothing to copy, so the tools before it never move under the pointer. */
export function FigureTools({ copy, children }: { copy: ReactNode; children?: ReactNode }) {
	return (
		<span className="figure-tools">
			{children}
			<span className="figure-copy-slot">{copy}</span>
		</span>
	);
}

/** The switch between a figure's two views, in words. */
export function FigureSwitch<View extends string>({ options, value, onChange }: { options: readonly { value: View; word: string }[]; value: View; onChange: (value: View) => void }) {
	return (
		<span className="figure-switch" role="group" aria-label="View">
			{options.map((option) => (
				<button key={option.value} type="button" className="figure-switch-option" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.word}</button>
			))}
		</span>
	);
}

/** A tool drawn as an icon: `name` is both what a screen reader hears and the tooltip. */
export function IconTool({ name, copied = false, onClick, children }: { name: string; copied?: boolean; onClick: () => void; children: ReactNode }) {
	return <button type="button" className={`figure-icon${copied ? " is-copied" : ""}`} onClick={onClick} aria-label={name} data-tip={name}>{children}</button>;
}

/** A Copy tool. `copy` runs at the click; with no clipboard or a denied write it just does not flip. */
function CopyTool({ name, copy }: { name: string; copy: () => Promise<void> | undefined }) {
	const [copied, markCopied] = useCopiedFlag();
	return (
		<IconTool name={copied ? "Copied" : name} copied={copied} onClick={() => void copy()?.then(markCopied).catch(() => {})}>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</IconTool>
	);
}

/** Copy text, `what` naming it in "Copy code". */
export function CopyTextTool({ text, what }: { text: string; what: string }) {
	return <CopyTool name={`Copy ${what}`} copy={() => navigator.clipboard?.writeText(text)} />;
}

/** A table's cells as tab-separated lines, each cell on one line, as a spreadsheet reads them. */
function tableText(table: HTMLTableElement): string {
	return [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent!.replace(/\s+/g, " ").trim()).join("\t")).join("\n");
}

/** Copy table: as HTML and as tab-separated text, so it pastes as a table in Excel, Word and Google Docs. `table` finds it at the moment of the click. */
export function CopyTableTool({ table }: { table: () => HTMLTableElement | null | undefined }) {
	return (
		<CopyTool
			name="Copy table"
			copy={() => {
				const shown = table();
				if (!shown || typeof ClipboardItem === "undefined") return undefined;
				const copy = shown.cloneNode(true) as HTMLTableElement;
				// KaTeX's drawing means nothing away from our stylesheet, so a formula pastes as its LaTeX, as Copy formula gives it.
				copy.querySelectorAll(".maths").forEach((formula) => formula.replaceWith(formula.querySelector("annotation")?.textContent ?? formula.textContent ?? ""));
				const part = (type: string, text: string) => new Blob([text], { type });
				return navigator.clipboard?.write([new ClipboardItem({ "text/html": part("text/html", copy.outerHTML), "text/plain": part("text/plain", tableText(copy)) })]);
			}}
		/>
	);
}

/** Copy image: the figure's SVG as a PNG on the card's own colour. `svg` finds it at the moment of the click. */
export function CopyImageButton({ svg }: { svg: () => SVGSVGElement | null | undefined }) {
	return (
		<CopyTool
			name="Copy image"
			copy={() => {
				const element = svg();
				if (!element) return undefined;
				const card = element.closest(".figure-card") ?? element;
				return copyPng(() => svgPng(element, getComputedStyle(card).backgroundColor));
			}}
		/>
	);
}
