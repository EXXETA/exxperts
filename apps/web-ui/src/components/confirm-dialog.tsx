import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEscapeKey } from "./use-escape-key";

/**
 * The app's own yes/no question, in place of the browser's confirm(): the
 * same card as the profile-switch question, above every other layer. Call
 * sites keep their `if (!ok) return` shape through the promise:
 *
 *   const ok = await confirmDialog({ title, body, confirmLabel: "Leave" });
 *
 * Enter (anywhere but the other buttons) and the focused primary button
 * confirm; Escape, the secondary button and a click on the backdrop cancel.
 * The focus starts on the primary button, or on Cancel when the primary is a
 * destructive one, so two Enters in a row never delete anything.
 * One host (ConfirmDialogHost, mounted once at the app root) renders the
 * questions in order; a question asked while none is mounted is declined.
 *
 * A question with three answers (Keep editing, Close without saving, Save and
 * close) passes `alternateLabel` and asks through confirmChoice instead.
 */
export interface ConfirmDialogOptions {
	title: string;
	body?: string;
	confirmLabel: string;
	cancelLabel?: string;
	/** Destructive primary action (Forget, discard): the primary button is red. */
	danger?: boolean;
	/** A third answer, a plain button between the secondary and the primary. */
	alternateLabel?: string;
}

/** Which answer a question got: the primary, the alternate, or cancel. */
export type ConfirmChoice = "confirm" | "alternate" | "cancel";

type PendingConfirm = ConfirmDialogOptions & { id: number; resolve: (choice: ConfirmChoice) => void };

const queue: PendingConfirm[] = [];
let nextId = 1;
let notifyHost: (() => void) | null = null;

export function confirmChoice(options: ConfirmDialogOptions): Promise<ConfirmChoice> {
	return new Promise((resolve) => {
		if (!notifyHost) {
			resolve("cancel");
			return;
		}
		queue.push({ ...options, id: nextId++, resolve });
		notifyHost();
	});
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
	return confirmChoice(options).then((choice) => choice === "confirm");
}

export function ConfirmDialogHost() {
	const [current, setCurrent] = useState<PendingConfirm | null>(null);
	useEffect(() => {
		const pull = () => setCurrent((showing) => showing ?? queue[0] ?? null);
		notifyHost = pull;
		pull();
		return () => {
			if (notifyHost === pull) notifyHost = null;
			for (const pending of queue.splice(0)) pending.resolve("cancel");
		};
	}, []);
	if (!current) return null;
	const settle = (choice: ConfirmChoice) => {
		const index = queue.indexOf(current);
		if (index !== -1) queue.splice(index, 1);
		current.resolve(choice);
		setCurrent(queue[0] ?? null);
	};
	return <ConfirmDialogView key={current.id} options={current} onSettle={settle} />;
}

export function ConfirmDialogView({ options, onSettle }: { options: ConfirmDialogOptions; onSettle: (choice: ConfirmChoice) => void }) {
	const cardRef = useRef<HTMLElement | null>(null);
	const primaryRef = useRef<HTMLButtonElement | null>(null);
	const secondaryRef = useRef<HTMLButtonElement | null>(null);
	const alternateRef = useRef<HTMLButtonElement | null>(null);
	// Topmost layer on the shared Escape stack: one Escape answers this
	// question and leaves the surface that asked it open.
	useEscapeKey(() => onSettle("cancel"), true);
	// Whatever had focus (the Forget button, a field) gets it back afterwards.
	useEffect(() => {
		const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		(options.danger ? secondaryRef : primaryRef).current?.focus();
		return () => { if (returnTo && returnTo.isConnected) returnTo.focus(); };
	}, []);
	function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
		if (e.key === "Enter") {
			// A focused Cancel or alternate keeps its native meaning; everywhere
			// else Enter is the primary answer.
			if (document.activeElement === secondaryRef.current || document.activeElement === alternateRef.current) return;
			e.preventDefault();
			e.stopPropagation();
			onSettle("confirm");
			return;
		}
		if (e.key !== "Tab") return;
		const first = secondaryRef.current;
		const last = primaryRef.current;
		if (!first || !last) return;
		if (!cardRef.current?.contains(document.activeElement)) {
			e.preventDefault();
			last.focus();
		} else if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
	return (
		<div
			className="checkpoint-preview-backdrop maintain-confirm-backdrop confirm-dialog-backdrop"
			role="alertdialog"
			aria-modal="true"
			aria-label={options.title}
			onKeyDown={onKeyDown}
			onClick={(e) => { if (e.target === e.currentTarget) onSettle("cancel"); }}
		>
			<section className={`checkpoint-input-card maintain-confirm-card${options.alternateLabel ? " confirm-dialog-three" : ""}`} ref={cardRef} tabIndex={-1}>
				<h2>{options.title}</h2>
				{options.body && <p>{options.body}</p>}
				<div className="checkpoint-preview-actions">
					<button ref={secondaryRef} type="button" className="rs-btn" onClick={() => onSettle("cancel")}>{options.cancelLabel ?? "Cancel"}</button>
					{options.alternateLabel && <button ref={alternateRef} type="button" className="rs-btn" onClick={() => onSettle("alternate")}>{options.alternateLabel}</button>}
					<button ref={primaryRef} type="button" className={`rs-btn rs-btn-primary${options.danger ? " rs-btn-danger" : ""}`} onClick={() => onSettle("confirm")}>{options.confirmLabel}</button>
				</div>
			</section>
		</div>
	);
}
