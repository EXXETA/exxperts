import { memo, useEffect, useMemo, useState } from "react";
import { approvalPreviewFromItem, type ApprovalPreviewData } from "../approval-preview";
import type { ChatItem } from "../types";

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

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

/**
 * Chip label for the delegation family, parsed from the server-composed
 * question ("Have a specialist create a slide deck?" → "Slide deck
 * specialist"). The title format is pinned by delegate-task-smoke; a parse
 * miss falls back to the generic approval chrome, never breaks.
 */
function specialistChipLabel(title: string): string | null {
	const match = title.match(/^Have a specialist create (?:a|an) (.+)\?$/);
	if (!match) return null;
	const noun = match[1];
	return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} specialist`;
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

	if (item.done) {
		return (
			<div className="approval-row">
				<div className="approval-card resolved">
					<div className="approval-head">
						<span className="approval-tag">your decision</span>
						<span className="approval-title">{item.title}</span>
					</div>
					<div className="approval-resolved">→ {item.done}</div>
				</div>
			</div>
		);
	}

	const tag =
		item.uiKind === "confirm" ? "approve?" : item.uiKind === "select" ? "your call" : "your input";
	const metadata = preview ? approvalMetadata(item.title, item.detail || item.message) : [];
	// Delegate approvals wear the delegation family's chrome (lila chip +
	// accent edge) so ask → running → done → kept reads as one object.
	const chip = fenced ? specialistChipLabel(item.title) : null;

	return (
		<div className="approval-row">
			<div className={`approval-card${chip ? " delegate" : ""}`}>
				{chip ? (
					<>
						<div className="approval-head">
							<span className="consult-chip">{chip}</span>
							<span className="approval-delegate-sub">wants to start</span>
						</div>
						<div className="approval-title approval-question">{item.title}</div>
					</>
				) : (
					<div className="approval-head">
						<span className="approval-tag">{tag}</span>
						<span className="approval-title">{item.title}</span>
					</div>
				)}
				{(() => {
					if (preview) return null;
					if (fenced) {
						// Collapsed: just the question and the buttons. Details shows the
						// guidance facts only — the model-written brief is never rendered
						// here (it still travels on the wire and in the durable record).
						return detailsOpen && fenced.facts ? (
							<div className="approval-delegate">
								<div className="approval-message approval-delegate-facts">{fenced.facts}</div>
							</div>
						) : null;
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
						<button
							className="btn-primary"
							onClick={() => onResolve(item.requestId, true, "Yes")}
						>
							Yes
						</button>
						<button
							className="btn-secondary"
							onClick={() => onResolve(item.requestId, false, "No")}
						>
							No
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
						{(item.options ?? []).map((opt) => (
							<button
								key={opt}
								className={
									opt.toLowerCase() === "approve" || opt.toLowerCase() === "yes"
										? "btn-primary"
										: opt.toLowerCase() === "no" || opt.toLowerCase() === "cancel"
											? "btn-secondary"
											: "btn-neutral"
								}
								onClick={() => onResolve(item.requestId, opt, opt)}
							>
								{opt}
							</button>
						))}
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
								onClick={() => onResolve(item.requestId, text, text ? "Submitted" : "(empty)")}
							>
								Submit
							</button>
							<button
								className="btn-secondary"
								onClick={() => onResolve(item.requestId, undefined, "Cancelled")}
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
