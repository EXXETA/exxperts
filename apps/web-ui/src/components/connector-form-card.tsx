import { useEffect, useRef, useState } from "react";
import { FORM_PICK_PROMPT, FORM_REQUIRED, type ConnectorFormField, type ConnectorFormValue } from "../../../web-server/src/connector-form-ask";
import type { ChatItem } from "../types";

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;
/** What the person has typed, ticked or picked so far, by field: on this page only, never saved and never sent but by Send. */
export type FormDraft = Record<string, ConnectorFormValue | undefined>;

/** A field as it starts: the connector's own value where it gives one, a yes-or-no unticked. */
function startValue(field: ConnectorFormField): ConnectorFormValue | undefined {
	if (field.kind === "yes-no") return field.default === true;
	if (field.kind === "many") return Array.isArray(field.default) ? field.default : [];
	if (field.kind === "date-time") return typeof field.default === "string" ? asPicked(field.default) : undefined;
	return typeof field.default === "string" ? field.default : undefined;
}

const PICKED = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/;
const two = (part: number) => String(Math.floor(part)).padStart(2, "0");

/** A connector's date and time in this computer's time, as the picker shows it; none when it isn't one, so what is sent is what shows. */
function asPicked(given: string): string | undefined {
	const at = new Date(given);
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(given) || Number.isNaN(at.getTime())) return undefined;
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}${at.getSeconds() ? `:${two(at.getSeconds())}` : ""}`;
}

/**
 * The form's values on this page, for the card shown: they start from the
 * connector's own values and are kept while the card stays, so the server's
 * lines after a Send leave what was typed in place.
 */
export function useFormDraft(ask: ApprovalItem | null): { values: FormDraft; change: (name: string, value: ConnectorFormValue | undefined) => void } {
	const [draft, setDraft] = useState<{ id: string; values: FormDraft } | null>(null);
	const id = ask?.uiKind === "form" ? ask.requestId : null;
	const values = id === null ? {} : draft?.id === id ? draft.values : Object.fromEntries((ask?.fields ?? []).map((field) => [field.name, startValue(field)]));
	return { values, change: (name, value) => id !== null && setDraft({ id, values: { ...values, [name]: value } }) };
}

/** A date and time as the picker gives it, in this computer's time, with its seconds and time zone, as the forms standard writes one. */
function withTimeZone(local: string): string {
	const at = new Date(local);
	if (!PICKED.test(local) || Number.isNaN(at.getTime())) return local;
	const east = -at.getTimezoneOffset();
	return `${local}${local.length === 16 ? ":00" : ""}${east < 0 ? "-" : "+"}${two(Math.abs(east) / 60)}:${two(Math.abs(east) % 60)}`;
}

/** What Send carries: each field the person filled in; an empty one is left out, a list with nothing picked too unless the form needs it. */
export function formSent(fields: ConnectorFormField[], values: FormDraft): Record<string, ConnectorFormValue> {
	const sent: Record<string, ConnectorFormValue> = {};
	for (const field of fields) {
		const value = values[field.name];
		if (value === undefined || value === "") continue;
		if (Array.isArray(value) && value.length === 0 && !field.required) continue;
		sent[field.name] = field.kind === "date-time" && typeof value === "string" ? withTimeZone(value) : value;
	}
	return sent;
}

const INPUT_TYPES: Partial<Record<ConnectorFormField["kind"], string>> = { email: "email", url: "url", date: "date", "date-time": "datetime-local" };
// A number is typed as text, so what reaches the check is what was typed: a number field would hand on nothing for words it can't read.
const INPUT_MODES: Partial<Record<ConnectorFormField["kind"], "decimal" | "numeric" | "email" | "url">> = { number: "decimal", integer: "numeric", email: "email", url: "url" };

/** One field's control, by its kind. Enter in a single-line field sends nothing: only Send does. */
function FieldControl({ field, value, describedBy, onChange }: { field: ConnectorFormField; value: ConnectorFormValue | undefined; describedBy: string | undefined; onChange: (value: ConnectorFormValue | undefined) => void }) {
	const id = `form-field-${field.name}`;
	if (field.kind === "yes-no") return null;
	if (field.kind === "many") {
		const picked = Array.isArray(value) ? value : [];
		return (
			<div className="ask-form-choices" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
				{(field.choices ?? []).map((choice) => (
					<label key={choice.value} className="ask-form-check">
						<input type="checkbox" checked={picked.includes(choice.value)} onChange={(event) => onChange(event.target.checked ? [...picked, choice.value] : picked.filter((one) => one !== choice.value))} />
						<span>{choice.label}</span>
					</label>
				))}
			</div>
		);
	}
	if (field.kind === "one") {
		return (
			<select id={id} className="launcher-path-input" value={typeof value === "string" ? value : ""} aria-describedby={describedBy} aria-required={field.required} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}>
				<option value="">{FORM_PICK_PROMPT}</option>
				{(field.choices ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
			</select>
		);
	}
	return (
		<input
			id={id}
			className="launcher-path-input"
			type={INPUT_TYPES[field.kind] ?? "text"}
			inputMode={INPUT_MODES[field.kind]}
			value={typeof value === "string" ? value : ""}
			aria-describedby={describedBy}
			aria-required={field.required}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.preventDefault();
			}}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

const NONE_CHANGED: ReadonlySet<string> = new Set();

/**
 * A connector's form, inside the panel's question: each field with its own
 * label, Required where the form needs it, the connector's words under it,
 * and the server's line where a Send's value didn't fit.
 */
export function ConnectorFormFields({ ask, values, onChange }: { ask: ApprovalItem; values: FormDraft; onChange: (name: string, value: ConnectorFormValue | undefined) => void }) {
	const formRef = useRef<HTMLDivElement>(null);
	// The fields the person changed since the app's last lines, kept with those lines: such a field shows no line until the next Send checks it again.
	const [changed, setChanged] = useState<{ lines: ApprovalItem["fieldLines"]; names: ReadonlySet<string> }>({ lines: undefined, names: new Set() });
	const changedNow = changed.lines === ask.fieldLines ? changed.names : NONE_CHANGED;
	const change = (name: string, value: ConnectorFormValue | undefined) => {
		setChanged((was) => ({ lines: ask.fieldLines, names: new Set(was.lines === ask.fieldLines ? was.names : []).add(name) }));
		onChange(name, value);
	};
	// The app's lines after a Send: the focus, which Send gave the message box, goes to the first field that doesn't fit.
	useEffect(() => {
		const first = (ask.fields ?? []).findIndex((field) => ask.fieldLines?.[field.name]);
		if (first < 0) return;
		// The whole field in view, its label and Required with it, not only its control at the scroll's edge.
		const field = formRef.current?.querySelectorAll(".ask-form-field")[first];
		field?.querySelector<HTMLElement>("input, select")?.focus({ preventScroll: true });
		field?.scrollIntoView({ block: "nearest" });
	}, [ask.fieldLines]);
	return (
		<div className="ask-form" ref={formRef}>
			{(ask.fields ?? []).map((field) => {
				const id = `form-field-${field.name}`;
				const line = changedNow.has(field.name) ? undefined : ask.fieldLines?.[field.name];
				const describedBy = [field.description ? `${id}-about` : "", line ? `${id}-line` : ""].filter(Boolean).join(" ") || undefined;
				const name = (
					<span id={`${id}-label`} className="ask-form-name">
						{field.label}
						{field.required && <span className="ask-form-required">{FORM_REQUIRED}</span>}
					</span>
				);
				return (
					<div key={field.name} className="settings-field ask-form-field" data-wrong={line ? "1" : "0"}>
						{field.kind === "yes-no" ? (
							<label className="ask-form-check">
								<input type="checkbox" checked={values[field.name] === true} aria-describedby={describedBy} onChange={(event) => change(field.name, event.target.checked)} />
								{name}
							</label>
						) : field.kind === "many" ? name : <label htmlFor={id}>{name}</label>}
						{field.description && <span id={`${id}-about`} className="ask-form-about">{field.description}</span>}
						<FieldControl field={field} value={values[field.name]} describedBy={describedBy} onChange={(value) => change(field.name, value)} />
						{line && <span id={`${id}-line`} className="ask-form-line" role="status">{line}</span>}
					</div>
				);
			})}
		</div>
	);
}
