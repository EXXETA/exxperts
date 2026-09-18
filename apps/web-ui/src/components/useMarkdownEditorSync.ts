// Adapted from Omnigent's web/src/shell/useMarkdownEditorSync.ts.
// Source: https://github.com/omnigent-ai/omnigent/tree/da7555532be25cd127a3cdee8bf8bb32071932fb
// Copyright (2026) Databricks, Inc.; Apache-2.0.
// Changes: exxperts uses a TipTap surface and revision-based workspace saves.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

interface Options {
	content: string;
	path: string;
	/** True when the file load has settled; path changes wait for real content. */
	isSettled: boolean;
	onDirtyChange?: (isDirty: boolean) => void;
	setContentRef?: RefObject<((content: string) => void) | null>;
}

interface Result {
	editorKey: number;
	isDirty: boolean;
	setDirty: (value: boolean) => void;
	hasExternalUpdate: boolean;
	discardAndApplyExternal: () => void;
	dismissExternalUpdate: () => void;
	markSaved: (content: string) => void;
	reconcileServerContent: (serverContent: string) => boolean;
}

export function useMarkdownEditorSync({
	content,
	path,
	isSettled,
	onDirtyChange,
	setContentRef,
}: Options): Result {
	const [editorKey, setEditorKey] = useState(0);
	const [isDirty, setIsDirty] = useState(false);
	const [hasExternalUpdate, setHasExternalUpdate] = useState(false);
	const isDirtyRef = useRef(isDirty);
	isDirtyRef.current = isDirty;
	const pendingContentRef = useRef<string | null>(null);
	const lastSavedRef = useRef<string | null>(null);
	const prevContentRef = useRef(content);
	const prevPathRef = useRef(path);
	const pendingRemountRef = useRef(false);

	const setDirty = useCallback((value: boolean) => {
		setIsDirty(value);
		onDirtyChange?.(value);
	}, [onDirtyChange]);

	useEffect(() => {
		if (prevPathRef.current === path) return;
		prevPathRef.current = path;
		prevContentRef.current = content;
		pendingContentRef.current = null;
		lastSavedRef.current = null;
		setHasExternalUpdate(false);
		setDirty(false);
		pendingRemountRef.current = true;
	}, [path, content, setDirty]);

	useEffect(() => {
		if (!isSettled || !pendingRemountRef.current) return;
		pendingRemountRef.current = false;
		prevContentRef.current = content;
		setEditorKey((key) => key + 1);
	}, [isSettled, path, content]);

	useEffect(() => {
		if (prevContentRef.current === content) return;
		if (content === lastSavedRef.current) {
			prevContentRef.current = content;
			return;
		}
		prevContentRef.current = content;
		if (pendingRemountRef.current) return;
		if (isDirtyRef.current) {
			pendingContentRef.current = content;
			setHasExternalUpdate(true);
			return;
		}
		if (setContentRef?.current) setContentRef.current(content);
		else setEditorKey((key) => key + 1);
	}, [content, setContentRef]);

	useEffect(() => {
		if (isDirty || pendingContentRef.current === null) return;
		const pending = pendingContentRef.current;
		pendingContentRef.current = null;
		setHasExternalUpdate(false);
		if (setContentRef?.current) setContentRef.current(pending);
		else setEditorKey((key) => key + 1);
	}, [isDirty, setContentRef]);

	const discardAndApplyExternal = useCallback(() => {
		const pending = pendingContentRef.current;
		pendingContentRef.current = null;
		setHasExternalUpdate(false);
		setDirty(false);
		if (setContentRef?.current && pending !== null) setContentRef.current(pending);
		else setEditorKey((key) => key + 1);
	}, [setDirty, setContentRef]);

	const dismissExternalUpdate = useCallback(() => {
		pendingContentRef.current = null;
		setHasExternalUpdate(false);
	}, []);

	const markSaved = useCallback((saved: string) => {
		lastSavedRef.current = saved;
	}, []);

	const reconcileServerContent = useCallback((serverContent: string): boolean => {
		if (serverContent === prevContentRef.current || serverContent === lastSavedRef.current) return false;
		prevContentRef.current = serverContent;
		if (isDirtyRef.current) {
			pendingContentRef.current = serverContent;
			setHasExternalUpdate(true);
			return true;
		}
		if (setContentRef?.current) setContentRef.current(serverContent);
		else setEditorKey((key) => key + 1);
		return false;
	}, [setContentRef]);

	return {
		editorKey,
		isDirty,
		setDirty,
		hasExternalUpdate,
		discardAndApplyExternal,
		dismissExternalUpdate,
		markSaved,
		reconcileServerContent,
	};
}
