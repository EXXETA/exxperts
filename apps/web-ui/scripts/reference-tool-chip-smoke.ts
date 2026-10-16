import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Message } from "../src/components/Message";
import type { ChatItem } from "../src/types";

type Tool = Extract<ChatItem, { kind: "tool" }>;
function chip(name: string, args: Tool["args"], details?: Tool["details"], status: Tool["status"] = "done") {
	const html = renderToStaticMarkup(createElement(Message, { item: { kind: "tool", id: "fixture", name, args, details, status, result: "Synthetic result" } }));
	const dom = new JSDOM(html);
	const summary = dom.window.document.querySelector(".tool-chip > summary")!;
	return { summary: summary.textContent!, title: summary.getAttribute("title"), details: dom.window.document.querySelector(".chip-reference-context")?.textContent };
}
const source = "362d8f6c-d023-41bc-82bb-77b54aec0ac1";
const file = chip("read_library_reference", { libraryId: source, reference: "shared/images/exxeta.png" });
assert.match(file.summary, /Read library reference.*exxeta\.png/);
assert(!file.summary.includes(source), "source identifiers do not obscure the referenced filename");
assert.match(file.title!, /shared\/images\/exxeta\.png/);
assert(file.details?.includes(source));
assert(file.details?.includes("shared/images/exxeta.png"));
assert.match(chip("read_library_reference", { libraryId: source }, { listing: true }).summary, /Browse library references.*Library root/);
assert.match(chip("read_library_reference", { libraryId: source, reference: "_source-material/examples" }, { listing: true }).summary, /Browse library references.*examples/);
assert.match(chip("read_library_reference", { libraryId: source, reference: "LICENSE" }, { reference: "LICENSE" }).summary, /Read library reference.*LICENSE/);
assert.match(chip("read_library_reference", { libraryId: source, reference: "images/exxeta.png" }, undefined, "running").summary, /Reading library reference.*exxeta\.png/);
assert.match(chip("read_library_reference", { libraryId: source, reference: "../image.png", from: "docs/guide.md" }, { reference: "image.png" }).details!, /Linked fromdocs\/guide\.md/);
assert.match(chip("read_skill_reference", { name: "brand", reference: "shared/colors.css" }).summary, /Read skill reference.*colors\.css.*brand/);
assert.match(chip("read_library_reference", { libraryId: source, reference: "private.png" }, { outcome: "not-enabled" }, "error").summary, /✗.*Read library reference.*private\.png/);
assert.match(chip("mcp", { tool: "search", server: "Synthetic connector" }).summary, /🔌 search.*Synthetic connector/);
assert.match(chip("read", { path: "workspace/file.txt" }).summary, /Read file.*workspace\/file\.txt/);
console.log("reference-tool-chip smoke passed");
