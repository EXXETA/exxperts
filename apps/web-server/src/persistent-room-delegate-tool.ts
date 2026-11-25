import { SKILL_PICKED_OPEN, withoutSkillNote } from "./skill-pick.js";

/**
 * The words the person typed in a room message, apart from what other actors
 * put in front of them. This module once also held the visual specialists'
 * `delegate_task` tool, which is switched off; old conversations that hold
 * its calls still show them (Message.tsx, step-lines.ts).
 */

/**
 * The wire prompt is user text PLUS text other actors put in front of it: the
 * client prepends queued handoff blocks (consult/specialist summaries — MODEL
 * written) and `[FILE ATTACHED: …]` notes (app written). What lands as the
 * person's message, and what an edit puts back in the box, must only ever be
 * the words the user actually typed, so this strips those leading layers.
 * Parsing leans on guarantees the composers already enforce: blocks ride BEFORE the user text (composeOutgoingPromptWithHandoffs), and
 * block content is neutralised against fence forgery. INVARIANT the fence
 * regexes must keep (adversarial pass, delegation-flow slice): they may only
 * recognise fence shapes the neutralizers actually defang — a full BRACKETED
 * marker line, because neutralizeBlockContent / neutralizeSpecialistBlockContent
 * strip brackets only off `[…]`-closed tokens. A looser recogniser (e.g. a
 * prefix match) accepts the unbracketed `[/SPECIALIST RESULT: x` a hostile
 * summary can still emit, ends the block early, and launders the rest of the
 * model-written block into "user-authored" consent scope. Anything malformed
 * is left in place — an unclosed fence is user-typed text, and over-stripping
 * could only shrink what counts as consent anyway (the fail-safe direction).
 */
export function userAuthoredPromptText(wireText: string): string {
	// The close recogniser is FAMILY-MATCHED to its open (critical-fixes
	// hardening): a consult block only ends at a CONSULT close, a specialist
	// block only at a SPECIALIST close. The neutralizers now defang both
	// families in all untrusted content, so no literal marker should survive
	// into a block at all — but were one ever to, a foreign-family close must
	// not terminate the block early and launder its tail into consent scope.
	// The server's own notes in front of a message the person sent after a cut
	// or a Stop, or while the room worked (cut-answer-note.ts), go too. The cut
	// note's markers carry nothing after their name, so they match only exactly:
	// a suffix such as "[/ANSWER CUT OFFx]" escapes the defanging's word
	// boundary and must not close the note early. The note of a skill the
	// person picked (skill-pick.ts) stands in front of the message, behind the
	// cut and edit notes when there are any: it is one more layer, cut where it is met.
	const openFence = /^\[(CONSULT HANDOFF FROM|SPECIALIST RESULT:|ANSWER CUT OFF(?=\]))[^\]\n]*\]$/;
	const closeFence = /^\[\/(CONSULT HANDOFF FROM|SPECIALIST RESULT:|ANSWER CUT OFF(?=\]))[^\]\n]*\]$/;
	// One line of the server's own: a message sent while the room worked, and who sent a message (cut-answer-note.ts).
	const oneLineFence = /^\[(SENT WHILE YOU WORKED|MESSAGE FROM)\].*\[\/\1\]$/;
	// Deliberately unanchored at the tail: a note line that somehow lost its
	// closing bracket must still strip (stripping MORE is the safe direction —
	// it can only shrink what counts as consent).
	const attachmentNote = /^\[FILE ATTACHED: /;
	let lines = String(wireText ?? "").replace(/\r\n/g, "\n").trimStart().split("\n");
	let at = 0;
	while (at < lines.length) {
		const line = lines[at].trim();
		if (line === "" || attachmentNote.test(line) || oneLineFence.test(line)) { at++; continue; }
		if (line === SKILL_PICKED_OPEN) {
			const rest = lines.slice(at).join("\n");
			const after = withoutSkillNote(rest);
			if (after === rest) break; // an open marker with no close: not a note, the person's words from here
			lines = after.split("\n");
			at = 0;
			continue;
		}
		const open = openFence.exec(line);
		if (!open) break;
		const family = open[1];
		const closeAt = lines.findIndex((candidate, index) => {
			if (index <= at) return false;
			const close = closeFence.exec(candidate.trim());
			return close !== null && close[1] === family;
		});
		if (closeAt < 0) break;
		at = closeAt + 1;
	}
	return lines.slice(at).join("\n").trim();
}
