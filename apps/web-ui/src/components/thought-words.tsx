import { Fragment } from "react";
import { MarkdownRenderer } from "./Markdown";
import type { Thought } from "../thinking-text-store";

/**
 * A row's thoughts, opened: each its own Markdown document, so a fence one
 * thought left open never swallows the next, with a rule between; each streams
 * only while it is written.
 */
export function ThoughtWords({ thoughts }: { thoughts: readonly Thought[] }) {
	return (
		<>
			{thoughts.map((thought, index) => (
				<Fragment key={index}>
					{index > 0 && <hr className="thought-break" />}
					<MarkdownRenderer streaming={thought.live}>{thought.words}</MarkdownRenderer>
				</Fragment>
			))}
		</>
	);
}
