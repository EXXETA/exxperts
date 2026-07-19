import { useEffect, useRef } from "react";
import type { TaskState } from "../task-stream";

interface Props {
	state: TaskState;
	onStop: () => void;
	onClose: () => void;
	maximized: boolean;
	onToggleMaximize: () => void;
}

/** The trimmed non-empty lines of the delta-stream tail. */
function tailLines(tail: string): string[] {
	return tail.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * The run view (status grammar, 2026-07-18): the homogenized viewer chrome's
 * RUNNING state — the done-card's status stream relocated behind one click on
 * the rail's running row. Same header shell as ArtifactViewer (title-led,
 * app-drawn, unforgeable); the body is the live mono tail, pinned to the
 * newest line; the footer is Stop's second home. When the task finishes the
 * host swaps this pane for the artifact viewer in place.
 */
export function TaskRunView({ state, onStop, onClose, maximized, onToggleMaximize }: Props) {
	const boxRef = useRef<HTMLDivElement>(null);
	const lines = tailLines(state.tail);
	const running = state.phase === "running";
	// Pin the scroll box to the newest line as deltas arrive.
	useEffect(() => {
		const box = boxRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, [state.tail]);
	return (
		<aside className={`artifact-viewer${maximized ? " artifact-viewer-maximized" : ""}`} aria-label="Task run view">
			<header className="artifact-viewer-head">
				<div className="artifact-viewer-provenance">
					<div className="artifact-viewer-kicker">{state.templateLabel ?? "specialist"}</div>
					<div className="artifact-viewer-template" title={state.title ?? "Specialist task"}>
						{running && <span className="assets-pulse task-run-view-pulse" aria-hidden="true" />}
						{state.title ?? "Specialist task"}
					</div>
				</div>
				<div className="artifact-viewer-head-right">
					<span className="artifact-viewer-badge" title={running ? "This specialist is working right now" : "This run has ended"}>{running ? "running" : "ended"}</span>
					<div className="artifact-viewer-actions">
						<button
							type="button"
							className="artifact-viewer-icon"
							onClick={onToggleMaximize}
							aria-pressed={maximized}
							aria-label={maximized ? "Restore panel size" : "Maximize panel"}
							title={maximized ? "Restore panel size" : "Maximize panel"}
						>
							{maximized ? "⤡" : "⤢"}
						</button>
						<button type="button" className="artifact-viewer-close" onClick={onClose} aria-label="Close run view. The task keeps running.">
							✕
						</button>
					</div>
				</div>
			</header>
			<div ref={boxRef} className="task-run-view-stream" aria-label="task activity">
				{lines.length === 0 ? (
					<div className="task-line">starting…</div>
				) : (
					lines.map((line, index) => {
						const isTool = /^\[.+\]$/.test(line);
						return (
							<div className={`task-line${isTool ? " is-tool" : ""}`} key={index}>
								{line}
							</div>
						);
					})
				)}
				{!running && state.errorMessage && <div className="task-line task-run-view-error">{state.errorMessage}</div>}
			</div>
			{running && (
				<div className="artifact-viewer-foot">
					<div className="asset-viewer-footer">
						<div className="asset-viewer-footer-row">
							<button type="button" className="artifact-viewer-action asset-viewer-delete" onClick={onStop} title="Stop this task. Files it already wrote are kept.">
								Stop
							</button>
						</div>
					</div>
				</div>
			)}
		</aside>
	);
}
