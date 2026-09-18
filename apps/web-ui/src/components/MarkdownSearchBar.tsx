// Find-in-file bar adapted from Omnigent's MarkdownSearchBar.tsx.
// Source: https://github.com/omnigent-ai/omnigent/tree/da7555532be25cd127a3cdee8bf8bb32071932fb
// Copyright (2026) Databricks, Inc.; Apache-2.0.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { findMatches, searchDecorationKey, type SearchDecorationState } from "./TipTapSearchExtension";

interface Props {
	editor: Editor | null;
	stateRef: { current: SearchDecorationState | null };
	open: boolean;
	onClose: () => void;
}

export function MarkdownSearchBar({ editor, stateRef, open, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [currentIndex, setCurrentIndex] = useState(0);
	const [version, setVersion] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const matchCount = useMemo(() => editor && query.trim() ? findMatches(editor.state.doc, query.trim()).length : 0, [editor, query, version]);
	useEffect(() => {
		if (!editor) return;
		const onUpdate = () => setVersion((value) => value + 1);
		editor.on("update", onUpdate);
		return () => { editor.off("update", onUpdate); };
	}, [editor]);
	useEffect(() => setCurrentIndex(0), [query]);
	useEffect(() => {
		if (!open) { setQuery(""); return; }
		const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(timer);
	}, [open]);
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		stateRef.current = { query: query.trim().toLowerCase(), currentIndex };
		editor.view.dispatch(editor.state.tr.setMeta(searchDecorationKey, "rebuild"));
	}, [currentIndex, editor, matchCount, query, stateRef]);
	useEffect(() => {
		if (!editor || !matchCount) return;
		const timer = requestAnimationFrame(() => editor.view.dom.querySelector(".md-search-match-current")?.scrollIntoView({ block: "center", behavior: "smooth" }));
		return () => cancelAnimationFrame(timer);
	}, [currentIndex, editor, matchCount]);
	const next = useCallback(() => { if (matchCount) setCurrentIndex((index) => (index + 1) % matchCount); }, [matchCount]);
	const previous = useCallback(() => { if (matchCount) setCurrentIndex((index) => (index - 1 + matchCount) % matchCount); }, [matchCount]);
	const close = useCallback(() => { setQuery(""); onClose(); }, [onClose]);
	if (!open) return null;
	const displayIndex = matchCount ? (currentIndex % matchCount) + 1 : 0;
	return (
		<div className="markdown-editor-search" role="search">
			<span aria-hidden="true">⌕</span>
			<input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in file…" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.shiftKey ? previous() : next(); } if (event.key === "Escape") { event.preventDefault(); close(); } }} />
			<span className="markdown-editor-search-count">{query.trim() ? matchCount ? `${displayIndex} / ${matchCount}` : "No results" : ""}</span>
			<button type="button" aria-label="Previous match" disabled={!matchCount} onClick={previous}>↑</button>
			<button type="button" aria-label="Next match" disabled={!matchCount} onClick={next}>↓</button>
			<button type="button" aria-label="Close search" onClick={close}>✕</button>
		</div>
	);
}
