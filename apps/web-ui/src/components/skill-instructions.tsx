import { useLayoutEffect, useRef, useState } from "react";
import { MarkdownRenderer } from "./Markdown";

/** Folded height of a skill's instructions on its page, in px. */
const FOLDED_HEIGHT = 340;

/**
 * A skill's SKILL.md at the pane's scale: headings in the UI font, code that
 * wraps, tables that fit the width. The pane is the one scroll. `foldable`
 * holds a long text to about 340 px with a fade and a Show all toggle; the
 * review screen leaves it unfolded, since that screen asks you to read it.
 */
export function SkillInstructions({ body, foldable = false }: { body: string; foldable?: boolean }) {
	const docRef = useRef<HTMLDivElement | null>(null);
	const [tall, setTall] = useState(false);
	const [open, setOpen] = useState(false);

	useLayoutEffect(() => {
		const doc = docRef.current;
		if (!foldable || !doc) return;
		const measure = () => setTall(doc.scrollHeight > FOLDED_HEIGHT + 40);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(doc);
		return () => observer.disconnect();
	}, [body, foldable]);

	const folded = foldable && tall && !open;
	return (
		<>
			<div ref={docRef} className={`skill-doc${folded ? " folded" : ""}`}>
				<MarkdownRenderer codeTokens>{body}</MarkdownRenderer>
			</div>
			{foldable && tall && (
				<button
					type="button"
					className="rs-btn skill-doc-toggle"
					aria-expanded={open}
					onClick={() => {
						// Folding back from far below brings the start of the text into view.
						if (open) docRef.current?.scrollIntoView({ block: "nearest" });
						setOpen(!open);
					}}
				>
					{open ? "Show less" : "Show all instructions"}
				</button>
			)}
		</>
	);
}
