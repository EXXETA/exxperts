import type { SkillPickEntry } from "../skill-pick-list";
import { SKILL_PICK_HEADING } from "../skill-source-copy";
import { SkillByHandTag } from "./skill-facts";

/** The list a "/" at the start of a room's message box opens, on the "@" list's pattern (mention-consult-popover.tsx); the message box drives it. */
export function SkillPickList({
	entries,
	activeIndex,
	onHover,
	onSelect,
}: {
	entries: SkillPickEntry[];
	activeIndex: number;
	onHover: (index: number) => void;
	onSelect: (entry: SkillPickEntry) => void;
}) {
	return (
		<div className="mention-pop skill-pick-pop" role="listbox" aria-label={SKILL_PICK_HEADING}>
			<div className="pop-kicker">{SKILL_PICK_HEADING}</div>
			<div className="mention-rows">
				{entries.map((entry, index) => (
					<div
						key={entry.name}
						role="option"
						aria-selected={index === activeIndex}
						className={`mention-row skill-pick-row${index === activeIndex ? " sel" : ""}`}
						ref={index === activeIndex ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
						// mousedown, not click: fire before the textarea blurs so focus stays put.
						onMouseDown={(e) => { e.preventDefault(); onSelect(entry); }}
						onMouseEnter={() => onHover(index)}
					>
						{/* The name in full; the description on the same line, cut where the row ends. */}
						<span className="skill-pick-name">/{entry.name}</span>
						{entry.description && <span className="skill-pick-description" title={entry.description}>{entry.description}</span>}
						{entry.byHand && <SkillByHandTag />}
					</div>
				))}
			</div>
		</div>
	);
}
