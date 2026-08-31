import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { approvalPreviewFromItem, type ApprovalPreviewData } from "../approval-preview";
import type { ChatItem } from "../types";

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

/**
 * The chat composer's textarea: the only textarea inside the composer box
 * (in-room-chat.tsx). The keyboard-approval flow needs it twice — to refuse
 * stealing focus from someone mid-typing, and to hand focus back after a
 * card resolves.
 */
function composerTextarea(): HTMLTextAreaElement | null {
	return document.querySelector<HTMLTextAreaElement>(".composer-box textarea");
}

interface Props {
	item: ApprovalItem;
	onResolve: (requestId: string, value: any, label: string) => void;
	onPreview?: (preview: ApprovalPreviewData) => void;
}

function kbWriteType(title: string): string {
	const t = title.toLowerCase();
	if (t.includes("append")) return "append";
	if (t.includes("replace")) return "replace";
	if (t.includes("create")) return "create";
	if (t.includes("raw") || t.includes("capture")) return "capture";
	if (t.includes("index")) return "index-generate";
	return "write";
}

function approvalMetadata(title: string, detail?: string): string[] {
	if (!detail) return [];
	const lines = detail.replace(/\r\n/g, "\n").split("\n");
	const marker = /^(Generated HTML preview|Content preview|Content|Append):\s*(.*)$/i;
	const isArtifactWrite = lines.some((line) => /^Path:\s*\//i.test(line.trim())) && lines.some((line) => /^Overwrite:\s*.+$/i.test(line.trim()));
	const isKbWrite = /knowledge-base/i.test(title) || lines.some((line) => /^Knowledge base:\s*.+$/i.test(line.trim()));
	const meta = isArtifactWrite
		? /^(Path|Overwrite|Slides):\s*.+$/i
		: isKbWrite
			? /^(Knowledge base|Folder|File|Path):\s*.+$/i
			: /^(Destination|Folder|Path|File|Overwrite|Vault|Reason|Title|Slides):\s*.+$/i;
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (marker.test(trimmed)) break;
		if (meta.test(trimmed)) out.push(trimmed);
	}
	if (isKbWrite) out.push(`Write type: ${kbWriteType(title)}`);
	return out.slice(0, isArtifactWrite ? 3 : 8);
}

/**
 * A delegate approval carries an app-facts section and a model-written brief,
 * separated by a ─── fence line the server composes. Rendering the boundary as
 * real chrome (divider + label chip + quoted block) is stronger anti-spoofing
 * than the text fence: a brief can imitate fact lines, but not app chrome.
 */
function splitFencedBrief(text?: string): { facts: string; label: string; brief: string } | null {
	if (!text) return null;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const fenceAt = lines.findIndex((line) => /^─{3,}.*─{3,}\s*$/.test(line.trim()));
	if (fenceAt < 0) return null;
	const label = lines[fenceAt].trim().replace(/^─+\s*/, "").replace(/\s*─+$/, "");
	return {
		facts: lines.slice(0, fenceAt).join("\n").trim(),
		label,
		brief: lines.slice(fenceAt + 1).join("\n").trim(),
	};
}

function ApprovalImpl({ item, onResolve, onPreview }: Props) {
	const [text, setText] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const preview = useMemo(() => approvalPreviewFromItem(item), [item.requestId, item.done, item.detail, item.message, item.title]);
	// Delegate approvals (fenced brief) render as question + Create/Cancel; all
	// mechanics live behind Show details.
	const fenced = !item.done && !preview ? (splitFencedBrief(item.message) ?? splitFencedBrief(item.detail)) : null;

	useEffect(() => {
		if (preview) onPreview?.(preview);
	}, [item.requestId, preview, onPreview]);

	// A pending card offers its Approve button to the keyboard — but it must
	// never steal focus from someone typing: a grabbed focus would turn their
	// "send" Enter into a silent approval. So the button is focused only when
	// no text surface holds focus AND the composer is empty (an unfocused
	// draft still means someone is mid-thought). Once per card, on mount.
	const approveRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (item.done) return;
		const btn = approveRef.current;
		if (!btn) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement) {
			const tag = active.tagName;
			if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || active.isContentEditable) return;
		}
		const composer = composerTextarea();
		if (composer && composer.value !== "") return;
		btn.focus();
	}, [item.requestId]);

	if (item.done) {
		// Resolved approvals fold to one quiet line: the decision is chat
		// history, not a live card. The verdict comes from the resolution label
		// ("Yes"/"No"/an option/"Submitted"); an unmapped label falls back to
		// naming the choice, never hides it.
		const done = item.done;
		const declined = /^(no\b|cancel|decline)/i.test(done);
		const verdict = /^(yes\b|approve)/i.test(done)
			? "You approved:"
			: declined
				? "You declined:"
				: /^(submitted|\(empty\))/i.test(done)
					? "You answered:"
					: `You chose ${done}:`;
		return (
			<div className="approval-row">
				<div className="approval-resolved-line">
					<span className="approval-resolved-mark" aria-hidden="true">{declined ? "✕" : "✓"}</span>
					<span className="approval-resolved-verdict">{verdict}</span>
					<span className="approval-resolved-title">{item.title}</span>
				</div>
			</div>
		);
	}

	const tag =
		item.uiKind === "confirm" ? "approve?" : item.uiKind === "select" ? "your call" : "your input";
	const metadata = preview ? approvalMetadata(item.title, item.detail || item.message) : [];

	// Every resolution path — click or key — hands focus back to the composer:
	// the card is about to fold to a line, and focus must not die on body.
	const resolve = (value: any, label: string): void => {
		onResolve(item.requestId, value, label);
		composerTextarea()?.focus();
	};

	// The keyboard twin of the Decline/No/Cancel button, per card kind. A
	// select card with no decline-shaped option has nothing to map Escape to,
	// so it reports "did not act" and the key keeps its usual meaning.
	const declineCurrent = (): boolean => {
		if (item.uiKind === "confirm") {
			resolve(false, fenced ? "Decline" : "No");
			return true;
		}
		if (item.uiKind === "select") {
			const opt = (item.options ?? []).find((o) => /^(no\b|cancel|decline)/i.test(o));
			if (!opt) return false;
			resolve(opt, opt);
			return true;
		}
		if (item.uiKind === "input") {
			resolve(undefined, "Cancelled");
			return true;
		}
		return false;
	};

	// Escape declines while focus is INSIDE the card (this handler only sees
	// events targeted within it — that is the focus-within scope). Enter needs
	// no handler: the focused Approve button activates natively. The event is
	// stopped only when the card acts, so an Escape it cannot honor still
	// closes menus and panes exactly as before.
	const onCardKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (e.key !== "Escape") return;
		if (declineCurrent()) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	return (
		<div className="approval-row">
			<div className={`approval-card${fenced ? " delegate" : ""}`} onKeyDown={onCardKeyDown}>
				{fenced ? (
					// The delegate approval is just the question: it already names the
					// actor ("Have a specialist create ..."), so a chip and a "wants to
					// start" subline would say the same thing twice. The lila accent
					// edge alone carries the family identity.
					<div className="approval-title approval-question">{item.title}</div>
				) : (
					<div className="approval-head">
						<span className="approval-tag">{tag}</span>
						<span className="approval-title">{item.title}</span>
					</div>
				)}
				{(() => {
					if (preview) return null;
					if (fenced) {
						// A command approval shows the fenced text ON the card: the command
						// is what the user consents to, and the tool row above truncates
						// long commands. Delegate briefs stay hidden as before — long, and
						// not themselves the consent object.
						const isCommand = /command/i.test(fenced.label);
						return (
							<>
								{isCommand && fenced.brief && <pre className="approval-detail approval-command">{fenced.brief}</pre>}
								{detailsOpen && fenced.facts ? (
									<div className="approval-delegate">
										<div className="approval-message approval-delegate-facts">{fenced.facts}</div>
									</div>
								) : null}
							</>
						);
					}
					return (
						<>
							{item.message && <div className="approval-message">{item.message}</div>}
							{item.detail && <pre className="approval-detail">{item.detail}</pre>}
						</>
					);
				})()}
				{preview && metadata.length > 0 && (
					<div className="approval-message approval-meta-compact">
						{metadata.map((line) => <div key={line}>{line}</div>)}
					</div>
				)}

				{item.uiKind === "confirm" && (
					<div className="approval-buttons">
						{/* A delegate card is a PROPOSAL (the room inferred the task —
						    delegation-flow slice), so its verbs say what the click does:
						    Approve starts the specialist, Decline sends it away. Generic
						    confirms keep Yes/No. Both label pairs map onto the resolved
						    line's verdict regexes above. */}
						<button
							ref={approveRef}
							className="btn-primary"
							onClick={() => resolve(true, fenced ? "Approve" : "Yes")}
						>
							{fenced ? "Approve" : "Yes"}
						</button>
						<button
							className="btn-secondary"
							onClick={() => resolve(false, fenced ? "Decline" : "No")}
						>
							{fenced ? "Decline" : "No"}
						</button>
						{fenced && (
							<button type="button" className="approval-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
								{detailsOpen ? "Hide details" : "Details"}
							</button>
						)}
					</div>
				)}

				{item.uiKind === "select" && (
					<div className="approval-buttons">
						{(item.options ?? []).map((opt) => {
							const lower = opt.toLowerCase();
							const primary = lower === "approve" || lower === "yes";
							return (
								<button
									key={opt}
									ref={primary ? approveRef : undefined}
									className={
										primary
											? "btn-primary"
											: lower === "no" || lower === "cancel"
												? "btn-secondary"
												: "btn-neutral"
									}
									onClick={() => resolve(opt, opt)}
								>
									{opt}
								</button>
							);
						})}
					</div>
				)}

				{item.uiKind === "input" && (
					<>
						<textarea
							value={text}
							onChange={(e) => setText(e.target.value)}
							placeholder={item.placeholder ?? "Your answer…"}
							className="approval-input"
							rows={4}
						/>
						<div className="approval-buttons">
							<button
								className="btn-primary"
								onClick={() => resolve(text, text ? "Submitted" : "(empty)")}
							>
								Submit
							</button>
							<button
								className="btn-secondary"
								onClick={() => resolve(undefined, "Cancelled")}
							>
								Cancel
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

export const Approval = memo(ApprovalImpl);
