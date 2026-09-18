// Find-in-file decorations adapted from Omnigent's TipTapSearchExtension.ts.
// Source: https://github.com/omnigent-ai/omnigent/tree/da7555532be25cd127a3cdee8bf8bb32071932fb
// Copyright (2026) Databricks, Inc.; Apache-2.0. Decorations do not alter Markdown.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export const searchDecorationKey = new PluginKey<DecorationSet>("exxpertsMarkdownSearch");
export interface SearchDecorationState { query: string; currentIndex: number; }
interface Segment { text: string; from: number; visibleFrom: number; separator: boolean; }

function visibleText(doc: ProseMirrorNode) {
	const segments: Segment[] = [];
	let text = "";
	let sawBlock = false;
	doc.descendants((node, pos) => {
		if (node.isTextblock) {
			if (sawBlock) { segments.push({ text: "\n", from: pos, visibleFrom: text.length, separator: true }); text += "\n"; }
			sawBlock = true;
			return true;
		}
		if (node.isText && node.text) {
			segments.push({ text: node.text, from: pos, visibleFrom: text.length, separator: false });
			text += node.text;
			return false;
		}
		return true;
	});
	return { text, segments };
}

function lowerSameLength(value: string) {
	let result = "";
	for (const character of value) {
		const lower = character.toLowerCase();
		result += lower.length === character.length ? lower : character;
	}
	return result;
}

export function findMatches(doc: ProseMirrorNode, query: string) {
	const needle = lowerSameLength(query);
	if (!needle) return [];
	const map = visibleText(doc);
	const haystack = lowerSameLength(map.text);
	const matches: { from: number; to: number }[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		const end = index + needle.length;
		let first: Segment | undefined;
		let last: Segment | undefined;
		let crossesBlock = false;
		for (const segment of map.segments) {
			const segmentEnd = segment.visibleFrom + segment.text.length;
			if (segmentEnd <= index || segment.visibleFrom >= end) continue;
			if (segment.separator) { crossesBlock = true; break; }
			if (!first) first = segment;
			last = segment;
		}
		if (!crossesBlock && first && last) matches.push({ from: first.from + index - first.visibleFrom, to: last.from + end - last.visibleFrom });
		index = haystack.indexOf(needle, end);
	}
	return matches;
}

function decorations(doc: ProseMirrorNode, state: SearchDecorationState | null) {
	if (!state?.query) return DecorationSet.empty;
	const matches = findMatches(doc, state.query);
	if (!matches.length) return DecorationSet.empty;
	const active = ((state.currentIndex % matches.length) + matches.length) % matches.length;
	return DecorationSet.create(doc, matches.map((match, index) => Decoration.inline(match.from, match.to, { class: index === active ? "md-search-match md-search-match-current" : "md-search-match" })));
}

export function createSearchDecorationExtension(stateRef: { current: SearchDecorationState | null }) {
	return Extension.create({
		name: "exxpertsMarkdownSearch",
		addProseMirrorPlugins() {
			return [new Plugin({
			key: searchDecorationKey,
			state: {
				init: (_, { doc }) => decorations(doc, stateRef.current),
				apply: (transaction, current, _, nextState) => transaction.getMeta(searchDecorationKey) || transaction.docChanged && stateRef.current?.query ? decorations(nextState.doc, stateRef.current) : current.map(transaction.mapping, nextState.doc),
			},
			props: { decorations(state) { return this.getState(state) ?? DecorationSet.empty; } },
		})];
		},
	});
}
