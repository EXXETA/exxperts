import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MarkdownRenderer, opensOutside } from "./components/Markdown";

// What an answer puts on the clipboard as text/html: its structure and
// nothing of the page. The browser's own copy carries the page's computed
// styles, so a mail shows the page's background behind every block. Pasted
// markup takes the look of where it lands, so only these tags pass, and a
// tag's own default gives code its monospace.
const KEPT_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "BR", "HR", "STRONG", "EM", "DEL", "A", "UL", "OL", "LI", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "PRE", "CODE", "SUP", "SUB", "KBD"]);
// The page's own controls and drawings: an in-app picture's link opens nothing
// outside the app, and hidden nodes repeat what a formula already says.
const LEFT_OUT = "button, svg, img, figure, .figure-strip, [aria-hidden='true']";
// The only look a tag gets: a table has no borders without it, and no colour is named, so the borders follow the text.
const TAG_STYLE: Record<string, string> = { TABLE: "border-collapse:collapse", TH: "border:1px solid;padding:4px 8px", TD: "border:1px solid;padding:4px 8px" };
// Around a selection that sits inside one of these, the marks it still needs.
const MARKS_AROUND = "pre, code, a, strong, em, del, sup, sub, kbd";
const LISTS_AND_TABLES = "ul, ol, table, thead, tbody, tr";
const ONE_BLOCK = "li, th, td, p, h1, h2, h3, h4, h5, h6";

function cleanCopy(element: Element, target: Document): Element {
	const copy = target.createElement(element.tagName);
	const style = TAG_STYLE[element.tagName];
	if (style) copy.setAttribute("style", style);
	const href = element.getAttribute("href");
	if (element.tagName === "A" && href && opensOutside(href)) copy.setAttribute("href", href);
	// A list split by a block goes on counting: on the page and in a mail, its number is its meaning.
	if (element instanceof HTMLOListElement && element.start !== 1) copy.setAttribute("start", String(element.start));
	return copy;
}

function cleanChildren(from: Node, into: Node, target: Document): void {
	for (const child of from.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) into.appendChild(target.createTextNode(child.textContent ?? ""));
		if (!(child instanceof Element) || child.matches(LEFT_OUT)) continue;
		if (child.tagName === "math") {
			// A formula reads as its TeX: the typeset one is drawn by the page's fonts and stylesheet.
			const code = into.appendChild(target.createElement("code"));
			code.textContent = child.querySelector("annotation")?.textContent ?? child.textContent;
		} else if (child instanceof HTMLInputElement) {
			if (child.type === "checkbox") into.appendChild(target.createTextNode(child.checked ? "[x] " : "[ ] "));
		} else if (KEPT_TAGS.has(child.tagName)) cleanChildren(child, into.appendChild(cleanCopy(child, target)), target);
		else cleanChildren(child, into, target);
	}
}

function inertBody(): HTMLElement {
	return document.implementation.createHTMLDocument("").body;
}

/** The answer behind `markdown`, drawn off screen by the page's own renderer, as clean HTML. */
export function answerHtml(markdown: string): string {
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		flushSync(() => root.render(createElement(MarkdownRenderer, { answer: true, children: markdown })));
		const body = inertBody();
		cleanChildren(host, body, body.ownerDocument);
		return body.innerHTML;
	} finally {
		root.unmount();
	}
}

// Whether a range holds text a copy would take: words the page marks as not selectable (a time) stay out of it.
function holdsCopyableText(range: Range): boolean {
	const texts = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
	while (texts.nextNode()) {
		const text = texts.currentNode;
		if (text.textContent?.trim() && range.intersectsNode(text) && text.parentElement && getComputedStyle(text.parentElement).userSelect !== "none") return true;
	}
	return false;
}

/** The range to copy when the selection holds only what is inside one answer, else null. */
function answerRange(selection: Selection): { range: Range; answer: Element } | null {
	if (selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0).cloneRange();
	const start = range.startContainer;
	const answer = (start instanceof Element ? start : start.parentElement)?.closest(".assistant-markdown");
	if (!answer) return null;
	if (!answer.contains(range.endContainer)) {
		// A triple click on an answer's last block ends the selection at the next text after the answer.
		const past = range.cloneRange();
		past.setStart(answer, answer.childNodes.length);
		if (holdsCopyableText(past)) return null;
		range.setEnd(answer, answer.childNodes.length);
	}
	return { range, answer };
}

function selectionHtml(range: Range, answer: Element): string {
	const body = inertBody();
	const target = body.ownerDocument;
	let html: Node = target.createDocumentFragment();
	cleanChildren(range.cloneContents(), html, target);
	// The fragment holds only what is below the selection's common ancestor: a
	// line of code loses its block, two rows lose their table.
	const common = range.commonAncestorContainer;
	let spansParts = true;
	for (let at = common instanceof Element ? common : common.parentElement; at && at !== answer; at = at.parentElement) {
		if (at.matches(ONE_BLOCK)) spansParts = false;
		if (!at.matches(MARKS_AROUND) && !(spansParts && at.matches(LISTS_AND_TABLES))) continue;
		const around = cleanCopy(at, target);
		around.appendChild(html);
		html = around;
	}
	body.appendChild(html);
	return body.innerHTML;
}

// A figure's view switch shows words, and the browser counts a button's words
// as selected text. Only a read of the live page keeps the browser's own lines
// and tabs, so those buttons step out of selection for this one read, before
// anything can paint. An icon's button stays: without it the lines around a table change.
function selectionText(selection: Selection, answer: Element): string {
	const controls = [...answer.querySelectorAll("button")].filter((button) => button.textContent);
	for (const control of controls) control.style.userSelect = "none";
	const text = selection.toString();
	for (const control of controls) control.style.removeProperty("user-select");
	return text;
}

/** Installs the clean copy for selections inside an answer; anything else keeps the browser's copy. */
export function installAnswerCopy(): void {
	document.addEventListener("copy", (event) => {
		// A box keeps its own selection apart from the page's in some browsers.
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		const selection = document.getSelection();
		const inAnswer = selection && answerRange(selection);
		if (!selection || !inAnswer || !event.clipboardData) return;
		event.clipboardData.setData("text/plain", selectionText(selection, inAnswer.answer));
		event.clipboardData.setData("text/html", selectionHtml(inAnswer.range, inAnswer.answer));
		event.preventDefault();
	});
}

// navigator.clipboard is undefined over plain http on a LAN address, so the
// only way left to the clipboard there is the older command, on a selected box.
function copyByCommand(text: string): void {
	const focused = document.activeElement;
	const box = document.createElement("textarea");
	box.value = text;
	box.style.position = "fixed";
	box.style.opacity = "0";
	document.body.append(box);
	box.select();
	const copied = document.execCommand("copy");
	box.remove();
	if (focused instanceof HTMLElement) focused.focus();
	if (!copied) throw new Error("the browser refused the copy");
}

/** Puts an answer on the clipboard: its markdown as text/plain and, where the browser can, clean HTML beside it. */
export async function copyAnswer(markdown: string): Promise<void> {
	const clipboard: Clipboard | undefined = navigator.clipboard;
	if (clipboard?.write && typeof ClipboardItem !== "undefined") {
		const blob = (text: string, type: string) => new Blob([text], { type });
		await clipboard.write([new ClipboardItem({ "text/plain": blob(markdown, "text/plain"), "text/html": blob(answerHtml(markdown), "text/html") })]);
	} else if (clipboard) await clipboard.writeText(markdown);
	else copyByCommand(markdown);
}
