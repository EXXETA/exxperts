import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ThemedToken } from "shiki/core";
import { cacheColours, cachedColours, codeLanguage, codeLanguageLabel, colourLines, highlightVersion, prepareHighlight, subscribeHighlight, type ColouredLines } from "../code-highlight";
import { CopyTextTool, FigureStrip, FigureTools } from "./figure-tools";
import type { FenceState } from "./Markdown";

/** One finished line, its tokens as text in spans: drawn once, then kept while the lines below it arrive. */
const ColouredLine = memo(function ColouredLine({ tokens, end }: { tokens: ThemedToken[]; end: string }) {
	return (
		<>
			{tokens.map((token, i) => (
				<span key={i} style={{ color: token.color, fontStyle: token.fontStyle === 1 ? "italic" : undefined }}>{token.content}</span>
			))}
			{end}
		</>
	);
});

/**
 * A fenced code block: a header strip with the language and Copy above the
 * code, never an overlay inside it (a bubble sized to a short block would
 * put an overlay on the code, and a block scrolling sideways would carry it
 * away).
 *
 * While the fence's first line is still being written the label waits for
 * it, so it never grows letter by letter. The code is coloured line by line
 * (code-highlight.ts): each finished line as soon as the next one starts,
 * the line being written plain. Until the language has loaded, and for
 * languages we do not colour, the block shows `children`, the plain code the
 * parser drew.
 */
export function CodeBlock({ code, language: fenceLanguage, fence, streaming, preProps, children }: { code: string; language: string | undefined; fence: FenceState | undefined; streaming: boolean; preProps: React.ComponentProps<"pre">; children: React.ReactNode }) {
	const labelled = fenceLanguage !== undefined && fence !== "opening";
	const writing = streaming && fence !== undefined;
	const language = labelled ? codeLanguage(fenceLanguage) : undefined;
	const loaded = useSyncExternalStore(subscribeHighlight, highlightVersion, highlightVersion);
	useEffect(() => {
		// Shiki starts loading with the first fence; the grammar once the fence's language is known.
		if (language || writing) prepareHighlight(language);
	}, [language, writing]);
	const previous = useRef<ColouredLines | undefined>(undefined);
	const lineEnd = writing ? code.lastIndexOf("\n") : code.length;
	const finished = lineEnd < 0 ? undefined : code.slice(0, lineEnd);
	const coloured = useMemo(() => {
		if (!language || finished === undefined) return undefined;
		return (!writing ? cachedColours(language, code) : undefined) ?? colourLines(previous.current, language, finished);
		// `loaded` draws the block again once its grammar is ready.
	}, [language, finished, writing, code, loaded]);
	useEffect(() => {
		previous.current = coloured;
		if (coloured && !writing) cacheColours(coloured);
	}, [coloured, writing]);
	const open = writing ? code.slice(lineEnd + 1) : "";
	return (
		<div className="code-block">
			<FigureStrip label={labelled ? codeLanguageLabel(fenceLanguage) : undefined} className="code-block-tools">
				<FigureTools copy={<CopyTextTool text={code} what="code" />} />
			</FigureStrip>
			{coloured ? (
				<pre {...preProps}>
					<code className={`language-${fenceLanguage}`}>
						{coloured.lines.map((tokens, i) => <ColouredLine key={i} tokens={tokens} end={i < coloured.lines.length - 1 || writing ? "\n" : ""} />)}
						{open}
					</code>
				</pre>
			) : (
				<pre {...preProps}>{children}</pre>
			)}
		</div>
	);
}
