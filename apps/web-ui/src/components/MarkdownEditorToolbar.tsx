// TipTap toolbar adapted from Omnigent's web/src/shell/MarkdownEditorToolbar.tsx.
// Source: https://github.com/omnigent-ai/omnigent/tree/da7555532be25cd127a3cdee8bf8bb32071932fb
// Copyright (2026) Databricks, Inc.; Apache-2.0.
// Changes: exxperts uses plain buttons/CSS and its revision-based workspace API.

import { useCallback, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import "@tiptap/markdown";
import "@tiptap/extension-list";
import "@tiptap/extension-table";

interface Props {
	editor: Editor | null;
	canEdit: boolean;
	onSave: () => void;
	isSaving: boolean;
	isDirty: boolean;
	saveError: boolean;
	hasExternalUpdate: boolean;
	onSearch: () => void;
	searchOpen: boolean;
}

function Button({ label, title, active, disabled, onClick }: { label: string; title: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
	return <button type="button" className={`markdown-editor-tool${active ? " is-active" : ""}`} title={title} aria-label={title} aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{label}</button>;
}

function Divider() {
	return <span className="markdown-editor-toolbar-divider" aria-hidden="true" />;
}

export function MarkdownEditorToolbar({ editor, canEdit, onSave, isSaving, isDirty, saveError, hasExternalUpdate, onSearch, searchOpen }: Props) {
	const [copied, setCopied] = useState(false);
	const state = useEditorState({
		editor,
		selector: ({ editor: current }) => ({
			canUndo: current?.can().undo() ?? false,
			canRedo: current?.can().redo() ?? false,
			paragraph: current?.isActive("paragraph") ?? false,
			h1: current?.isActive("heading", { level: 1 }) ?? false,
			h2: current?.isActive("heading", { level: 2 }) ?? false,
			h3: current?.isActive("heading", { level: 3 }) ?? false,
			blockquote: current?.isActive("blockquote") ?? false,
			bold: current?.isActive("bold") ?? false,
			italic: current?.isActive("italic") ?? false,
			strike: current?.isActive("strike") ?? false,
			code: current?.isActive("code") ?? false,
			taskList: current?.isActive("taskList") ?? false,
			inTable: current?.isActive("tableCell") || current?.isActive("tableHeader") || false,
		}),
	});
	const run = useCallback((command: () => boolean | void) => { command(); }, []);
	const copyMarkdown = useCallback(() => {
		const markdown = editor?.getMarkdown() ?? "";
		if (!navigator.clipboard?.writeText) return;
		void navigator.clipboard.writeText(markdown).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}).catch(() => {});
	}, [editor]);
	const setLink = useCallback(() => {
		if (!editor) return;
		const oldHref = String(editor.getAttributes("link").href ?? "");
		const href = window.prompt("Link URL", oldHref);
		if (href === null) return;
		if (href.trim()) run(() => editor.chain().focus().setLink({ href: href.trim() }).run());
		else run(() => editor.chain().focus().unsetLink().run());
	}, [editor, run]);
	const saveDisabled = !canEdit || !isDirty || isSaving || hasExternalUpdate;
	const saveLabel = isSaving ? "Saving…" : saveError && isDirty ? "Retry" : isDirty ? "Save" : "Saved";
	const editDisabled = !canEdit;
	return (
		<div className="markdown-editor-toolbar" role="toolbar" aria-label="Markdown formatting">
			<Button label="↶" title="Undo (⌘Z)" disabled={editDisabled || !state?.canUndo} onClick={() => run(() => editor?.chain().focus().undo().run())} />
			<Button label="↷" title="Redo (⌘⇧Z)" disabled={editDisabled || !state?.canRedo} onClick={() => run(() => editor?.chain().focus().redo().run())} />
			<Divider />
			<Button label="¶" title="Normal paragraph" active={state?.paragraph} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().setParagraph().run())} />
			<Button label="H1" title="Heading 1" active={state?.h1} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleHeading({ level: 1 }).run())} />
			<Button label="H2" title="Heading 2" active={state?.h2} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleHeading({ level: 2 }).run())} />
			<Button label="H3" title="Heading 3" active={state?.h3} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleHeading({ level: 3 }).run())} />
			<Button label="❝" title="Blockquote" active={state?.blockquote} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleBlockquote().run())} />
			<Divider />
			<Button label="B" title="Bold (⌘B)" active={state?.bold} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleBold().run())} />
			<Button label="I" title="Italic (⌘I)" active={state?.italic} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleItalic().run())} />
			<Button label="S" title="Strikethrough" active={state?.strike} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleStrike().run())} />
			<Button label="<>" title="Inline code" active={state?.code} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleCode().run())} />
			<Button label="Link" title="Set or remove link" active={editor?.isActive("link")} disabled={editDisabled} onClick={setLink} />
			<Divider />
			<Button label="• List" title="Bullet list" disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleBulletList().run())} />
			<Button label="1. List" title="Numbered list" disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleOrderedList().run())} />
			<Button label="☑ Tasks" title="Task list" active={state?.taskList} disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().toggleTaskList().run())} />
			<Button label="Find" title="Find in file (⌘F)" active={searchOpen} onClick={onSearch} />
			<Button label="Table" title="Insert table" disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())} />
			{state?.inTable && <Button label="Delete table" title="Delete table" disabled={editDisabled} onClick={() => run(() => editor?.chain().focus().deleteTable().run())} />}
			<div className="markdown-editor-toolbar-spacer" />
			<Button label={copied ? "Copied" : "Copy"} title="Copy Markdown source" onClick={copyMarkdown} />
			<button type="button" className="markdown-editor-save-status" title={hasExternalUpdate ? "Resolve the external change first" : saveLabel} disabled={saveDisabled} onMouseDown={(event) => event.preventDefault()} onClick={onSave}>{saveLabel}</button>
		</div>
	);
}
