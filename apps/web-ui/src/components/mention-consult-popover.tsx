import type { MentionCandidateRoom } from "../mention-popover";
import { memoryFreshnessHint, mentionHighlightLength } from "../mention-popover";

// The prop bundle the composer receives to power the @-mention consult flow.
// Absent (undefined) outside a live room and in fixtures, so composer behaviour
// is unchanged when it is not provided.
export interface MentionSupport {
	// The full rooms list; the composer filters/orders it per query.
	candidates: MentionCandidateRoom[];
	// The room being typed in — excluded from candidates (no self-consult).
	currentRoomId: string;
	// While the room has an in-flight turn the popover does not open and
	// mention-submit falls back to normal send; the disabled affordance carries
	// busyTitle as its tooltip.
	busy: boolean;
	busyTitle: string;
	// Handed the resolved target room id + the question (mention stripped). For
	// MR-3 this is wired to an inert App-level stub; MR-4 wires it to the consult
	// WS family + DelegationCard.
	/** Returns whether the consult was accepted (false → rejected: one already active, or socket down). */
	onConsultRequest: (targetRoomId: string, question: string) => boolean;
	// Stacked consult (§8.3): the display name of the room whose card is currently
	// docked, or null when none is. A composer @-mention always means a FRESH
	// consult, so while a card is docked the composer must reject it VISIBLY (the
	// card is the place to follow up) and keep the draft. Null → no gate.
	activeConsultDisplayName?: string | null;
}

// The status dot colour reflects the room's memory status. Default (ready /
// unknown) is the success green the mockup uses; needs_absorb warns amber;
// error/missing reads red.
function statusDotClass(status?: string): string {
	if (status === "needs_absorb") return "m-dot needs-absorb";
	if (status === "error" || status === "missing") return "m-dot bad";
	return "m-dot";
}

export function MentionConsultPopover({
	matches,
	query,
	activeIndex,
	onHover,
	onSelect,
}: {
	matches: MentionCandidateRoom[];
	query: string;
	activeIndex: number;
	onHover: (index: number) => void;
	onSelect: (room: MentionCandidateRoom) => void;
}) {
	return (
		<div className="mention-pop" role="listbox" aria-label="Consult a room">
			<div className="pop-kicker">Consult a room: answers from its memory</div>
			{/* The row list scrolls past ~6 rooms (kicker + teaching footer stay
			    pinned); arrow navigation keeps the selection in view. */}
			<div className="mention-rows">
				{matches.map((room, index) => {
					const highlight = mentionHighlightLength(room.displayName, query);
					const fresh = memoryFreshnessHint(room.lastCheckpointAt);
					return (
						<div
							key={room.id}
							role="option"
							aria-selected={index === activeIndex}
							className={`mention-row${index === activeIndex ? " sel" : ""}`}
							ref={index === activeIndex ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
							// mousedown, not click: fire before the textarea blurs so focus stays put.
							onMouseDown={(e) => { e.preventDefault(); onSelect(room); }}
							onMouseEnter={() => onHover(index)}
						>
							<span className={statusDotClass(room.status)} aria-hidden="true" />
							<span className="m-name">
								{highlight > 0 ? (
									<>
										<span className="hl">{room.displayName.slice(0, highlight)}</span>
										{room.displayName.slice(highlight)}
									</>
								) : (
									room.displayName
								)}
							</span>
							{fresh && <span className="m-fresh">{fresh}</span>}
						</div>
					);
				})}
			</div>
			<div className="pop-foot">↑↓ choose · Enter select · Esc dismiss. The room's memory is read, never changed</div>
		</div>
	);
}

// The disabled affordance shown when a trigger is typed while the room is busy:
// no interactive rows, and a title naming why (spec §4.3 "disabled while busy").
export function MentionConsultPopoverBusy({ title }: { title: string }) {
	return (
		<div className="mention-pop mention-pop-disabled" title={title} aria-disabled="true">
			<div className="pop-kicker">Consult a room: answers from its memory</div>
			<div className="pop-foot">{title}</div>
		</div>
	);
}
