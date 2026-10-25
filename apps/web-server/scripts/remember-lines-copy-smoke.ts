// Remember's lines, plain and true. The person sees a line only when they must
// do something, or as the plain outcome of what they asked; each says what
// happened in the person's words and never carries raw engine text.
//
// Offline: the server's sentences and the client's source, no server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-lines-copy-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempHome, ".exxperts", "app", "personalized-agents");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
function check(label: string, run: () => void): void {
	try {
		run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}`);
	}
}

try {
	const pa = await import("../src/persistent-agents.js");
	const twoStage = await import("../src/remember-two-stage.js");
	const job = await import("../src/remember-job.js");
	const client = await import("../../web-ui/src/remember-read.js");
	const copy = await import("../../web-ui/src/memory-v2-copy.js");
	// A page component (.tsx): loaded at run time, as the server build compiles scripts without JSX.
	const notice: any = await import(new URL("../../web-ui/src/components/model-notice.tsx", import.meta.url).href);
	const remote = await import("../src/remote-route-policy.js");
	// React lives with the page.
	const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
	const { createElement } = pageRequire("react");
	(globalThis as any).React = pageRequire("react");
	const { renderToStaticMarkup } = pageRequire("react-dom/server");
	const app = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
	const server = fs.readFileSync(path.join(process.cwd(), "apps", "web-server", "src", "index.ts"), "utf8");
	const model = { provider: "openai-codex", model: "gpt-6-sol", label: "ChatGPT Plus/Pro \u2014 GPT-6 Sol" };

	const CHANGED = "This conversation changed after Remember read it. Generate again.";
	const STOPPED = "Remember stopped unexpectedly. Nothing was saved. Generate again.";
	const OTHER_OPEN = "Remember stopped because another conversation is open now. Open Remember again.";

	check("a conversation that changed after Remember read it says so, at the result and at Save", () => {
		assert(server.includes(CHANGED), "the stale result says the conversation changed");
		assert(app.includes(CHANGED) && !app.includes("Memory changed while this proposal was open"), "the stale save names the conversation, not memory");
		assert(client.isPlainRememberSentence(CHANGED), "the client passes it through");
	});

	check("a Save from a window older than the server says to reload, and the page shows it as it is", () => {
		const RELOAD = "This window is out of date. Reload the page, then save again.";
		const agents = fs.readFileSync(path.join(process.cwd(), "apps", "web-server", "src", "persistent-agents.ts"), "utf8");
		assert(agents.includes(`const REMEMBER_PAGE_FORM_MESSAGE = "${RELOAD}";`), "the server's sentence");
		assert(client.isPlainRememberSentence(RELOAD), "the client passes it through by name");
	});

	check("a Remember that stopped for no named cause says so plainly", () => {
		assert(server.includes(STOPPED) && !server.includes("Remember has nothing ready"), "the missing job says Remember stopped");
		assert(app.includes(STOPPED) && !app.includes("Failed to generate proposal"), "a failed request with no sentence says the same, with no status code");
		assert(client.isPlainRememberSentence(STOPPED), "the client passes it through");
	});

	check("a conversation the provider refused whole says so once, at the save", () => {
		const dated = (provider: string, label: string) => ({ process: { model: { provider, model: "m", label } }, rememberRead: { refusedWhole: true }, fields: { title: "Conversation of 2026-10-10", sessionArc: "Conversation of 2026-10-10", body: "- Conversation of 2026-10-10", parked: "None." } });
		const line = "Saved. Claude's safety check would not read this conversation, so its memory keeps only the date. The room can still look it up when you ask about it.";
		assert(client.rememberRefusedWholeSentence(dated("anthropic", "Anthropic / Claude \u2014 Claude Opus 5.5")) === line, `got ${client.rememberRefusedWholeSentence(dated("anthropic", "x"))}`);
		assert(/^Saved\. ChatGPT's safety check/.test(client.rememberRefusedWholeSentence(dated("openai-codex", model.label)) ?? ""), "the provider's name comes from the model");
		assert(client.rememberRefusedWholeSentence({ ...dated("anthropic", "x"), rememberRead: {}, fields: { title: "The launch plan", sessionArc: "We planned it.", body: "- The launch moves to May." } } as any) === null, "an ordinary page says nothing more");
		assert(client.rememberRefusedWholeSentence({ ...dated("anthropic", "x"), rememberRead: {} } as any) === null, "a dated page the safety check did not cause (a conversation of greetings) says nothing about it");
	});

	check("a failure nothing classified shows one plain sentence, never raw words", () => {
		assert(client.rememberFailureSentence("ENOSPC: no space left on device, open '/home/x/proposal.json'") === STOPPED, `a full disk reads as the plain stop, got ${client.rememberFailureSentence("ENOSPC: no space left on device, open '/home/x/proposal.json'")}`);
		assert(client.rememberFailureSentence("upstream said: {\"error\":\"weird_gateway_state\"}") === STOPPED, "an odd gateway reply too");
		assert(client.rememberFailureSentence("The room is closed for now.") === "The room is closed for now.", "a sentence written for the person passes");
		assert(!/formatMaintenanceRequestError\(message\) \?\? message/.test(app), "Remember's formatter has no raw fallthrough");
		const review = app.slice(app.indexOf("function formatReviewWorkflowError"), app.indexOf("function formatReviewApprovalError"));
		assert(!/\n\treturn message;\n\}/.test(review), "Review's formatter has no raw fallthrough");
	});

	check("both restart lines say the same", () => {
		assert(client.rememberRestartSentence() === "The app restarted while Remember was reading. Generate again to finish.", `got ${client.rememberRestartSentence()}`);
	});

	check("a Remember already reading says where to act", () => {
		assert(pa.REMEMBER_ALREADY_GENERATING_MESSAGE === "Remember is already reading this conversation, on this or another device. Wait for it to finish, or cancel it.", pa.REMEMBER_ALREADY_GENERATING_MESSAGE);
	});

	check("a Remember stopped because another window saved the conversation is an outcome, with its own code", () => {
		const saved = (job as any).rememberCancelledReply?.({ state: "cancelled", reason: "saved" });
		const cancelled = (job as any).rememberCancelledReply?.({ state: "cancelled" });
		assert(saved?.error === "This conversation was saved from another window." && saved?.code === "remember_saved_elsewhere", `got ${JSON.stringify(saved)}`);
		assert(cancelled?.error === "Remember was cancelled. Nothing was saved." && cancelled?.code === "remember_cancelled", `got ${JSON.stringify(cancelled)}`);
		assert(client.isRememberOutcome?.(saved.error) === true && client.isRememberOutcome?.(cancelled.error) === false, "the client shows the first as an outcome, not an error");
	});

	check("a Remember stopped because another window forgot the conversation says so, not cancelled", () => {
		const forgotten = (job as any).rememberCancelledReply?.({ state: "cancelled", reason: "forgotten" });
		assert(forgotten?.error === "This conversation was forgotten from another window." && forgotten?.code === "remember_forgotten_elsewhere", `got ${JSON.stringify(forgotten)}`);
		assert(client.isPlainRememberSentence(forgotten.error) && client.isRememberOutcome?.(forgotten.error) === true, "the client shows it as it is, as an outcome");
	});

	check("a Memory model changed after the entry was written says so", () => {
		assert(pa.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE === "The Memory model changed after this entry was written. Nothing was saved. Generate again.", pa.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE);
		assert(client.isPlainRememberSentence(pa.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE), "the client passes it through");
	});

	check("another conversation open now says so, never a mismatch", () => {
		const uses = (app.match(/REMEMBER_OTHER_CONVERSATION_OPEN\b/g) ?? []).length - 1;
		assert(app.includes(OTHER_OPEN) && uses >= 4, `the four mismatch errors say it, got ${uses}`);
		assert(!/memory proposal does not match|The room changed|save response does not match/.test(app), "no mismatch wording is left");
	});

	check("an edited entry with a part's label typed inside another part says so plainly", () => {
		const sentence = "Part of this entry can't be read: What to keep and Still open each need their own words. Check the entry and save again.";
		const page = (body: string) => `### RC-DRAFT | CLOSED | 2026-10-09 | The plan\n\n**Session arc:** We planned.\n\n**Body:**\n${body}\n\n**Parked:**\nNone\n`;
		let message = "";
		try { (pa as any).validateApprovedRecentContextDraft(page("**Parked:** the plan.")); } catch (error) { message = error instanceof Error ? error.message : String(error); }
		assert(message === sentence, `got ${JSON.stringify(message)}`);
		assert(client.isPlainRememberSentence(sentence), "the client passes it through");
	});

	check("a quick save that did not work opens the entry, with a cause only when it is plain", () => {
		assert(app.includes("Saving did not work this time. Here is the entry to save.") && !app.includes("could not save automatically"), "the plain sentence");
	});

	check("an ordinary save offers Keep chatting, and the old Continue working is gone", () => {
		assert(app.includes('{!roomFilled && <button className="rs-btn rs-btn-primary" onClick={onContinueAfterCheckpoint} title="Stay in this room with a new conversation">Keep chatting</button>}'), "Keep chatting after a save that did not fill the room");
		const ui = fs.readdirSync(path.join(process.cwd(), "apps", "web-ui", "src"), { recursive: true }).map(String).filter((file) => /\.tsx?$/.test(file));
		assert(!ui.some((file) => fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", file), "utf8").includes("Continue working")), "no Continue working anywhere");
	});

	check("a phone reads Remember's progress and result, and Cancel is a write it may not send", () => {
		const { classifyRemoteRoute } = remote;
		assert(classifyRemoteRoute("GET", "/api/persistent-agents/:id/checkpoint/progress") === "read" && classifyRemoteRoute("GET", "/api/persistent-agents/:id/checkpoint/result") === "read", "progress and result are reads");
		assert(classifyRemoteRoute("POST", "/api/persistent-agents/:id/checkpoint/cancel") === "write" && classifyRemoteRoute("POST", "/api/persistent-agents/:id/checkpoint/approve") === "write", "Cancel and Save are writes");
	});

	check("the wait line names the next try, and changes on each try", () => {
		const nextTryAt = "2026-10-10T14:05:00.000Z";
		const lines = [notice.modelWaitLine({ cause: "busy", detail: "rate-limit", attempt: 2, nextTryAt }), notice.modelWaitLine({ cause: "busy", detail: "overload", attempt: 3, nextTryAt, again: true }), notice.modelWaitLine({ cause: "busy", detail: "stalled", attempt: 2, nextTryAt })];
		const at = lines[0]!.replace(/^.* at (.+)\.$/, "$1");
		assert(/\d/.test(at) && lines.every((line) => line.endsWith(` at ${at}.`)), `each names the time of the next try, got ${JSON.stringify(lines)}`);
		const local = new Date(nextTryAt);
		const [hour, minute] = [local.getHours(), String(local.getMinutes()).padStart(2, "0")];
		assert(at === `${String(hour).padStart(2, "0")}:${minute}` || at === `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`, `the next try is said on the person's own clock, 24-hour or 12-hour, got ${at}`);
		assert(lines[0]!.startsWith("The Memory model is busy. Trying again at") && lines[1]!.startsWith("Still busy. Trying again at") && lines[2]!.startsWith("The answer stopped coming. Asking again at"), `the words change with the try and the cause, got ${JSON.stringify(lines)}`);
		// A dropped connection (a blip after the probe answered, or a socket that dropped mid-call) says so, never busy.
		const dropped = [notice.modelWaitLine({ cause: "busy", detail: "connection", attempt: 2, nextTryAt }), notice.modelWaitLine({ cause: "busy", detail: "connection", attempt: 3, nextTryAt })];
		assert(dropped.every((line) => line === `The connection to the Memory model dropped. Trying again at ${at}.`), `a dropped connection reads as one, got ${JSON.stringify(dropped)}`);
		assert(notice.modelWaitLine({ cause: "busy", detail: "rate-limit", attempt: 3, nextTryAt }).startsWith("The Memory model is busy."), "a third try whose earlier wait never said busy says busy first, not still busy");
		const unreached = notice.modelWaitLine({ cause: "unreached", detail: "connection", attempt: 2, nextTryAt });
		assert(unreached === `Can't reach the Memory model right now. Trying again at ${at}.`, `a first call that could not connect says so, never busy, got ${JSON.stringify(unreached)}`);
	});

	check("a model too small for this memory offers no Try again, which would meet the same refusal", () => {
		const html = (detail: string) => renderToStaticMarkup(createElement(notice.ModelNoticePanel, { notice: { detail, sentence: "The notice." } as any, onTryAgain: () => {}, onChooseModel: () => {} }));
		assert(!html("too-small").includes("Try again") && html("too-small").includes("Choose another model"), "too small: Choose another model only");
		assert(html("not-answering").includes("Try again"), "not answering: Try again stays");
	});

	check("signed out, no longer offered or out of quota: no Try again, which is sure to fail; the way that works comes first", () => {
		const buttons = (detail: string) => [...renderToStaticMarkup(createElement(notice.ModelNoticePanel, { notice: { detail, sentence: "The notice.", provider: "anthropic" } as any, onTryAgain: () => {}, onChooseModel: () => {}, onSignIn: () => {} })).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
		for (const detail of ["quota", "not-offered"]) assert(buttons(detail).join("|") === "Choose another model", `${detail}: Choose another model only, got ${buttons(detail).join("|")}`);
		const signedOut = buttons("signed-out");
		assert(signedOut.length === 2 && signedOut[1] === "Choose another model" && !signedOut.includes("Try again"), `signed out: the sign-in way first, then Choose another model, got ${signedOut.join("|")}`);
		assert(buttons("not-answering").join("|") === "Try again|Choose another model" && buttons("still-busy").join("|") === "Try again|Choose another model", "a model that may answer later keeps Try again first");
	});

	check("Remember on a damaged memory file says so, and offers no Generate again that would meet it again", () => {
		const damaged = "This room's memory file is damaged, so Remember cannot save. Nothing was lost.";
		const said = (client as any).rememberDamagedSentence;
		for (const message of ["L1b missing mandatory section: Chronos", "L1b missing mandatory section(s): Deep Memory, Recent Context", "L1b Recent Context contains duplicate id(s): RC-0001", "L1b topology must be exactly: Chronos, Deep Memory, Active Items, Recent Context"]) {
			assert(said?.(message) === damaged, `damaged memory reads plainly, got ${said?.(message)}`);
		}
		assert(said?.("Remember stopped because another conversation is open now. Open Remember again.") === null, "other lines pass through");
		assert(!/Generate again/.test(damaged), "no Generate again in the line, so the dialog offers none");
		assert((client as any).REMEMBER_DAMAGED_SENTENCE === damaged && app.includes("{error !== REMEMBER_DAMAGED_SENTENCE && <button className=\"rs-btn rs-btn-primary\" disabled={itemCount === 0} onClick={onGenerate}>"), "nor a Generate memory proposal, which meets the same damaged file: Close is the way out");
		const format = app.slice(app.indexOf("function formatRememberError("), app.indexOf("const ROOM_TURN_WAIT_LINE"));
		assert(format.indexOf("rememberDamagedSentence(message)") > -1 && format.indexOf("rememberDamagedSentence(message)") < format.indexOf("formatMaintenanceRequestError(message)"), "the dialog reads the damaged line before any other");
	});

	check("Remember after the Memory model changed: Generate again leads and Save goes, as for a changed conversation", () => {
		assert(app.includes("const mustGenerateAgain = generateAgain && /changed after Remember read it|The Memory model changed after this entry was written/.test(approvalError ?? \"\");"), "the model-changed refusal hides Save");
		assert(/changed after this entry was written/.test(pa.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE), "it matches the server's own sentence");
	});

	check("Generate again asks before it replaces the person's edits", () => {
		const generate = app.slice(app.indexOf("async function generateCheckpointProposal()"), app.indexOf("setCheckpointEdits(null);", app.indexOf("async function generateCheckpointProposal()")));
		assert(generate.includes('title: "Generate again replaces your edits."') && generate.includes('confirmLabel: "Generate again"'), "a confirm before the edits go");
		assert(/checkpointProposal && checkpointEdits\?\.key === checkpointEditsKey\(checkpointProposal\) && !sameCheckpointFields\(checkpointEdits\.fields, checkpointFieldsOf\(checkpointProposal\)\)/.test(generate), "only when there are edits");
	});

	check("a read-only device closes the Remember dialog, never sends a Cancel or a Discard it may not send", () => {
		const shell = app.slice(app.indexOf("function CheckpointPreviewShell("), app.indexOf("function CheckpointPreviewShell(") + 30000);
		assert(shell.includes('const readOnly = useRemoteClientContext().capability === "read-only";'), "the dialog knows the device is read-only");
		assert(shell.includes('{readOnly ? <button className="rs-btn" onClick={onClose}>Close</button> : <button className="rs-btn" onClick={onCancelGenerate}>Cancel</button>}'), "Close in place of Cancel while it reads");
		assert(shell.includes("{!readOnly && <button className=\"rs-btn\" disabled={approvalLoading} onClick={() => void confirmDiscard()}"), "no Discard");
		assert(shell.includes('{readOnly ? <button className="rs-btn" onClick={onClose}>Close</button> : !mustGenerateAgain && <button className="rs-btn rs-btn-primary" disabled={approvalLoading || !approvalReady} onClick={() => onApprove(savedFields)}>'), "no Save either: Close in its place");
	});

	check("the room warns one Remember before it fills, and says when it is full", () => {
		assert(client.recentSessionsHeadsUp(18) === null, "no line before");
		assert(client.recentSessionsHeadsUp(19) === "One more remembered conversation fills this room. Then Memorize before starting a new one.", "the warning at 19");
		assert(client.recentSessionsHeadsUp(20, "Atlas") === "Atlas now holds 20 conversations, as many as it can. Memorize them to start a new conversation.", "the line at 20");
		assert(app.includes("const headsUp = recentSessionsHeadsUp(approval.recentContextEntryCount);"), "the quick save carries it on its saved line");
	});

	check("a result handed over but not yet sent is not promised to carry over", () => {
		assert(!app.includes("carry into the fresh conversation"), "no promise a full room or Return Home would break");
		assert(app.includes("A transferred consult hasn't entered memory yet. Send a message before you save, so it is part of this conversation.") && app.includes("A transferred task result hasn't entered memory yet. Send a message before you save, so it is part of this conversation."), "what to do to keep it");
	});

	check("a Save after the conversation was already saved parks with the saved line, unless it filled the room, and never switches a second window", () => {
		for (const start of ["async function approveCheckpointProposal(", "const skipsPreview = await fetchQuickCheckpointPreference("]) {
			const body = app.slice(app.indexOf(start), app.indexOf(start) + 3200);
			// The window whose own answer was lost shows the save's page instead: that save is its own.
			assert(/if \(approval\.alreadySaved && (?:!answerWasLost && )?!roomFilledBy\(approval\)\) \{ parkAfterSavedRemember\(targetChat, savedHereBefore \? REMEMBER_SAVED_REOPEN_SENTENCE : REMEMBER_SAVED_ELSEWHERE_SENTENCE\); return; \}/.test(body), `${start}: the landed save does not bind`);
		}
	});

	check("a save that landed while the tab moved to another conversation reads as saved", () => {
		const request = app.slice(app.indexOf("async function requestCheckpointApproval("), app.indexOf("async function requestCheckpointApproval(") + 2000);
		assert(!request.slice(0, request.indexOf("\n\t}\n")).includes("persistentChatRef.current"), "the save's own request does not fail on the tab's conversation");
		const bind = app.slice(app.indexOf("async function bindToApprovedCheckpointRuntime("), app.indexOf("async function bindToApprovedCheckpointRuntime(") + 600);
		assert(bind.includes("persistentChatRef.current") && bind.includes("REMEMBER_OTHER_CONVERSATION_OPEN"), "the switch checks it, so the landed save parks with the saved line");
	});

	check("a save that landed never reads as failed when opening the fresh conversation fails", () => {
		assert(client.REMEMBER_SAVED_REOPEN_SENTENCE === "Saved. Enter the room again from its card.", "the plain outcome");
		assert(client.REMEMBER_SAVED_ELSEWHERE_SENTENCE === "Already saved in another window. Enter the room again from its card.", "the plain outcome when another window saved it");
		// The plain outcome is a status on Home, never the red alert box.
		assert(/persistentResumeError === REMEMBER_SAVED_REOPEN_SENTENCE \|\| persistentResumeError === REMEMBER_SAVED_ELSEWHERE_SENTENCE\s*\?\s*<div className="home-resume-status" role="status">/.test(app), "Home shows the saved lines as a status, not an alert");
		// Both save paths keep the switch out of the save's own try: the save's failure line is only the save's.
		const paths = [app.slice(app.indexOf("async function approveCheckpointProposal("), app.indexOf("async function requestCheckpointApproval(")), app.slice(app.indexOf("const skipsPreview = await fetchQuickCheckpointPreference("), app.indexOf("function resetCheckpointInput("))];
		for (const body of paths) assert(/try \{ await bindToApprovedCheckpointRuntime\(approval, targetChat\); \} catch \{ parkAfterSavedRemember\(targetChat\); return; \}/.test(body), "a failed switch after the save parks the room with the plain outcome");
	});

	check("an edited entry with a heading or a comment says what to remove", () => {
		const sentence = "A heading line or an HTML comment can't be saved in an entry. Remove it and save again.";
		const page = (extra: string) => `### RC-DRAFT | CLOSED | 2026-10-09 | The plan\n\n**Session arc:** We planned.\n\n**Body:**\n- The plan.${extra}\n\n**Parked:**\nNone\n`;
		for (const extra of ["\n### Smuggled", "\n## Deep Memory", "\n<!-- hidden -->"]) {
			let message = "";
			try { (pa as any).validateApprovedRecentContextDraft(page(extra)); } catch (error) { message = error instanceof Error ? error.message : String(error); }
			assert(message === sentence, `got ${JSON.stringify(message)} for ${JSON.stringify(extra)}`);
		}
		assert(client.isPlainRememberSentence(sentence), "the client passes it through");
	});

	check("the saving line names the room's memory, nothing else", () => {
		assert(app.includes("<p>Saving to {chat.displayName}’s memory…</p>") && !app.includes("came back clean"), "the plain saving line");
	});

	check("before Save, the review says only when this save nears or fills the room", () => {
		const fills = (client as any).rememberFillsRoomHeadsUp;
		assert(typeof fills === "function" && fills(5, "Room") === null, "no line while the room has room");
		assert(fills(18, "Room") === client.recentSessionsHeadsUp(19), "a save that makes 19 says the existing heads-up");
		assert(fills(19, "Room") === "This save fills Room: it will hold 20 conversations, as many as it can. Then Memorize them to start a new conversation.", "a save that makes 20 says it fills the room");
		assert(!app.includes("Holds ${") && !app.includes("rememberRoomHoldsLine") && !app.includes("Remember without the preview in Room settings"), "no count label and no sentence about saving without the preview");
		assert(!app.includes("recent sessions used") && !/RECENT_SESSIONS_CAP\b/.test(app), "no count against the old 10 and no sessions");
	});

	check("a conversation too long even in parts names the Memory model and Room settings", () => {
		assert(twoStage.rememberWindowTooSmallMessage(model) === "This conversation is too long for GPT-6 Sol to remember next to this room's memory, even read in parts. Choose a Memory model that can read more at once in Room settings, Model, then Generate again. Nothing was saved.", twoStage.rememberWindowTooSmallMessage(model));
	});

	check("memory editing waits only for the room's answer", () => {
		assert(copy.MEMORY_EDIT_BLOCKED_SENTENCE === "Memory can be edited once the room finishes its answer.", copy.MEMORY_EDIT_BLOCKED_SENTENCE);
	});

	check("the chooser's status title says when a new conversation needs Memorize", () => {
		assert(app.includes("A new conversation needs Memorize once the room holds ${sessionBlockCap}.") && !app.includes("Chat keeps working until the room holds"), "the second sentence");
	});

	check("an edited entry Save cannot take says why and what to do, never the generic sentence", () => {
		const entry = (body: string) => `### RC-DRAFT | CLOSED | 2026-10-09 | The plan\n\n**Session arc:** We planned.\n\n**Body:**\n${body}\n\n**Parked:**\nNone\n`;
		const refusal = (markdown: string) => {
			try { (pa as any).validateApprovedRecentContextDraft(markdown); } catch (error) { return error instanceof Error ? error.message : String(error); }
			return "";
		};
		const tooLong = refusal(entry(`- ${"The plan holds. ".repeat(600)}`));
		assert(tooLong === "This entry is too long to save (at most 8,000 characters). Shorten it and save again.", `an entry past 8,000 characters, got ${JSON.stringify(tooLong)}`);
		assert(refusal("### RC-DRAFT | CLOSED | 2026-10-09 | The plan\n\n**Body:**\n- The plan.\n\n**Parked:**\nNone\n") === "", "an entry without What happened saves");
		assert(app.includes('"The Memory model returned nothing to keep. Generate again, or Edit to write it."') && app.includes("const approvalReady = pageLimit.canSave;"), "Save needs only what to keep within the page's limit, and says so when the model returned none");
		assert(refusal(entry("- checkpoint_id = none")) === "", "the person's words are never read as the page's identity");
		const identity = refusal(entry("- The plan.").replace("| The plan", "| checkpoint_id = none"));
		assert(identity === "A line saying checkpoint_id or session_id is none can't be saved in an entry. Remove it and save again.", `a line the gate keeps for itself, got ${JSON.stringify(identity)}`);
		for (const sentence of [tooLong, identity]) assert(client.isPlainRememberSentence(sentence), `the client passes it through: ${sentence}`);
	});

	check("a title from the notes is their first eight to ten words, and never stops at an abbreviation", () => {
		const title = (text: string) => twoStage.rememberTitleFromWords(text);
		assert(title("Dr. Meier agreed to the May launch.") === "Dr. Meier agreed to the May launch", `got ${JSON.stringify(title("Dr. Meier agreed to the May launch."))}`);
		assert(title("We went through the Nordwind renewal, the vendor quotes and the June launch plan with Mara.") === "We went through the Nordwind renewal, the vendor quotes", `ten words, cut at a word, no trailing comma, got ${JSON.stringify(title("We went through the Nordwind renewal, the vendor quotes and the June launch plan with Mara."))}`);
		assert(title("The team moved the Nordwind renewal to early June. Mara owns the vendor review.") === "The team moved the Nordwind renewal to early June", `a sentence ending at the eighth to tenth word ends the title, got ${JSON.stringify(title("The team moved the Nordwind renewal to early June. Mara owns the vendor review."))}`);
	});

	check("a keep-request counts as kept only when the entry holds its words or its whole line", () => {
		const notes = ["DECISIONS:\n- \"keep the launch month\": May\n- \"remember the vendor\": Nordwind supplies the sensors"];
		const missing = (body: string) => twoStage.missingKeepRequests(notes, body);
		assert(JSON.stringify(missing("- The budget review moved to May.\n- Nordwind supplies the sensors.")) === JSON.stringify(["- \"keep the launch month\": May"]), `a common word elsewhere does not keep a request, its whole line does, got ${JSON.stringify(missing("- The budget review moved to May.\n- Nordwind supplies the sensors."))}`);
		assert(missing("- Keep the launch month: May.\n- Remember the vendor: Nordwind.").length === 0, `the request's own words keep it, got ${JSON.stringify(missing("- Keep the launch month: May.\n- Remember the vendor: Nordwind."))}`);
	});

	assert(failures.length === 0, `remember lines copy smoke failed:\n${failures.join("\n")}`);
	console.log("remember lines copy smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
