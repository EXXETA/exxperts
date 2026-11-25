/**
 * A connector's form: the details it asks the person for while one of its
 * tools runs (pi-mcp-adapter's elicitation-handler.ts, reached through
 * scripts/patch-mcp-adapter.mjs, patch 28). The fields as the room's card
 * draws them, the line under a field whose value doesn't fit, and the words
 * around the card and for the model. web-ui-context.ts builds the card and
 * checks an answer with the adapter's own rule; the page's
 * connector-form-card.tsx draws it. No imports: the page reads this file.
 */

/** The kinds of field the adapter's own check knows, as the card draws them. */
export type ConnectorFormFieldKind = "text" | "number" | "integer" | "email" | "url" | "date" | "date-time" | "one" | "many" | "yes-no";

export interface ConnectorFormField {
	/** The key the connector reads the value by. */
	name: string;
	label: string;
	description?: string;
	required: boolean;
	kind: ConnectorFormFieldKind;
	/** One of a list, several of a list: each choice's value and its words. */
	choices?: Array<{ value: string; label: string }>;
	/** What the connector fills in, as the field shows it. */
	default?: string | boolean | string[];
}

/** A value as the page sends it: what was typed, ticked or picked. A field left empty is left out. */
export type ConnectorFormValue = string | boolean | string[];

/** What the adapter's check takes and gives back (`coerceAndValidateFormValues`): it throws for a value that doesn't fit. */
export interface ConnectorFormParams {
	message: string;
	requestedSchema: { type: "object"; properties: Record<string, Record<string, unknown>>; required?: string[] };
}
export type ConnectorFormContent = Record<string, string | number | boolean | string[]>;
export type ConnectorFormCheck = (params: ConnectorFormParams, values: Record<string, ConnectorFormValue | undefined>) => ConnectorFormContent;

export const connectorFormTitle = (connector: string): string => `${connector} asks for some details`;
export const connectorFormFrom = (connector: string): string => `From ${connector}`;
export const connectorFormGoesTo = (connector: string): string => `What you send goes to ${connector}.`;
export const connectorFormGaveUpLine = (connector: string): string => `${connector} stopped waiting for this, so nothing was sent.`;
export const FORM_REQUIRED = "Required";
export const FORM_SEND = "Send";
/** An answered form's row: the details went. */
export const FORM_SENT = "Sent";
/** A one-of-a-list field's first choice, shown while nothing is picked; it goes as no value. Its verb is its line's, `FORM_FIELD_LINES.pickOne`. */
export const FORM_PICK_PROMPT = "Pick one";

/** The line under a field whose value doesn't fit. */
export const FORM_FIELD_LINES = {
	fill: "Fill this in.",
	number: "Use a number.",
	integer: "Use a whole number.",
	email: "Use an email address.",
	url: "Use a web address.",
	date: "Use a date.",
	dateTime: "Use a date and time.",
	pickOne: "Pick one.",
	atLeast: (count: number) => `Pick at least ${count}.`,
	atMost: (count: number) => `Pick at most ${count}.`,
	orMore: (bound: number) => `Use ${bound} or more.`,
	orLess: (bound: number) => `Use ${bound} or less.`,
	minLength: (count: number) => `Use at least ${count} characters.`,
	maxLength: (count: number) => `Use at most ${count} characters.`,
} as const;

/** How a form ended, for the model's line on the call that asked it. */
export type ConnectorFormOutcome = "sent" | "not-now" | "nobody";

/** The model's line after a form; it never holds a value the person typed. */
export function connectorFormModelLine(outcome: ConnectorFormOutcome, connector: string): string {
	if (outcome === "sent") return `The person filled in ${connector}'s form and sent it.`;
	if (outcome === "not-now") return `The person saw ${connector}'s form and chose Not now, so nothing was sent.`;
	return `Nobody answered ${connector}'s form before it closed, so nothing was sent.`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A key as people read it, as the adapter's own cards name a field without a title: "start_date" reads "Start date". */
function fieldWords(name: string): string {
	return name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());
}

/** A list's choices, for one of a list (`enum`, `oneOf`, the older `enumNames`) and several of a list (`items.enum`, `items.anyOf`). */
function choicesOf(schema: Record<string, unknown>): Array<{ value: string; label: string }> | undefined {
	const titled = (options: unknown) => (Array.isArray(options) ? options.filter(isRecord).map((option) => ({ value: String(option.const ?? ""), label: String(option.title ?? option.const ?? "") })) : undefined);
	if (schema.type === "array") {
		const items = isRecord(schema.items) ? schema.items : {};
		return titled(items.anyOf) ?? (Array.isArray(items.enum) ? items.enum.map((value) => ({ value: String(value), label: String(value) })) : []);
	}
	if (Array.isArray(schema.oneOf)) return titled(schema.oneOf);
	if (!Array.isArray(schema.enum)) return undefined;
	const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
	return schema.enum.map((value, at) => ({ value: String(value), label: String(names[at] ?? value) }));
}

function kindOf(schema: Record<string, unknown>): ConnectorFormFieldKind {
	if (schema.type === "array") return "many";
	if (schema.type === "boolean") return "yes-no";
	if (schema.type === "number") return "number";
	if (schema.type === "integer") return "integer";
	if (Array.isArray(schema.enum) || Array.isArray(schema.oneOf)) return "one";
	if (schema.format === "email") return "email";
	if (schema.format === "uri") return "url";
	if (schema.format === "date") return "date";
	if (schema.format === "date-time") return "date-time";
	return "text";
}

/** What the connector fills in, as the field holds it: a number as its text. */
function defaultOf(value: unknown): ConnectorFormField["default"] {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return Array.isArray(value) ? value.map(String) : undefined;
}

/** The fields of a connector's form, in its order. `shown` writes out what a person can't see in the connector's words. */
export function connectorFormFields(params: ConnectorFormParams, shown: (text: string) => string): ConnectorFormField[] {
	const required = new Set(params.requestedSchema.required ?? []);
	return Object.entries(params.requestedSchema.properties).map(([name, schema]) => {
		const choices = choicesOf(schema);
		const fallback = defaultOf(schema.default);
		return {
			name,
			label: shown(typeof schema.title === "string" && schema.title.trim() ? schema.title : fieldWords(name)),
			...(typeof schema.description === "string" && schema.description.trim() ? { description: shown(schema.description) } : {}),
			required: required.has(name),
			kind: kindOf(schema),
			...(choices ? { choices: choices.map((choice) => ({ value: choice.value, label: shown(choice.label) })) } : {}),
			...(fallback !== undefined ? { default: fallback } : {}),
		};
	});
}

/** The fields of a card's frame, read where they enter the page: a field without a name or a kind the card knows is left out. */
export function readConnectorFormFields(value: unknown): ConnectorFormField[] {
	const kinds: ReadonlySet<unknown> = new Set<ConnectorFormFieldKind>(["text", "number", "integer", "email", "url", "date", "date-time", "one", "many", "yes-no"]);
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).filter((field) => typeof field.name === "string" && kinds.has(field.kind)).map((field) => ({
		name: String(field.name),
		label: typeof field.label === "string" ? field.label : String(field.name),
		...(typeof field.description === "string" ? { description: field.description } : {}),
		required: field.required === true,
		kind: field.kind as ConnectorFormFieldKind,
		...(Array.isArray(field.choices) ? { choices: field.choices.filter(isRecord).map((choice) => ({ value: String(choice.value ?? ""), label: String(choice.label ?? choice.value ?? "") })) } : {}),
		...(typeof field.default === "string" || typeof field.default === "boolean" ? { default: field.default } : Array.isArray(field.default) ? { default: field.default.map(String) } : {}),
	}));
}

/** The values of a page's Send, read where they enter the server: only the form's own fields, each a value the card can give. */
export function readConnectorFormValues(params: ConnectorFormParams, value: unknown): Record<string, ConnectorFormValue> | null {
	if (!isRecord(value) || !isRecord(value.values)) return null;
	// No inherited keys: a field named `constructor` the person left empty stays empty.
	const values: Record<string, ConnectorFormValue> = Object.create(null);
	for (const name of Object.keys(params.requestedSchema.properties)) {
		const given = Object.hasOwn(value.values, name) ? value.values[name] : undefined;
		if (typeof given === "string" || typeof given === "boolean") values[name] = given;
		else if (Array.isArray(given) && given.every((item) => typeof item === "string")) values[name] = given;
	}
	return values;
}

/**
 * Why a value the adapter's check refused doesn't fit, from what the field
 * asks for: the check alone decides that it doesn't, this only words it.
 */
function lineFor(schema: Record<string, unknown>, value: ConnectorFormValue | undefined): string {
	const kind = kindOf(schema);
	if (value === undefined) return kind === "one" ? FORM_FIELD_LINES.pickOne : FORM_FIELD_LINES.fill;
	if (kind === "number" || kind === "integer") {
		const number = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
		const [minimum, maximum] = [numberOf(schema.minimum), numberOf(schema.maximum)];
		if (!Number.isFinite(number)) return FORM_FIELD_LINES.number;
		if (kind === "integer" && !Number.isInteger(number)) return FORM_FIELD_LINES.integer;
		if (minimum !== undefined && number < minimum) return FORM_FIELD_LINES.orMore(minimum);
		if (maximum !== undefined && number > maximum) return FORM_FIELD_LINES.orLess(maximum);
		return FORM_FIELD_LINES.number;
	}
	if (kind === "many") {
		const count = Array.isArray(value) ? value.length : 0;
		const [fewest, most] = [numberOf(schema.minItems), numberOf(schema.maxItems)];
		if (most !== undefined && count > most) return FORM_FIELD_LINES.atMost(most);
		return FORM_FIELD_LINES.atLeast(fewest ?? 1);
	}
	if (kind === "one") return FORM_FIELD_LINES.pickOne;
	const length = String(value).length;
	const [shortest, longest] = [numberOf(schema.minLength), numberOf(schema.maxLength)];
	if (shortest !== undefined && length < shortest) return FORM_FIELD_LINES.minLength(shortest);
	if (longest !== undefined && length > longest) return FORM_FIELD_LINES.maxLength(longest);
	if (kind === "email") return FORM_FIELD_LINES.email;
	if (kind === "url") return FORM_FIELD_LINES.url;
	if (kind === "date") return FORM_FIELD_LINES.date;
	if (kind === "date-time") return FORM_FIELD_LINES.dateTime;
	return FORM_FIELD_LINES.fill;
}

/**
 * A Send checked by the adapter's own rule (`check`): field by field, as the
 * adapter checks each card's value, so each field that doesn't fit gets its
 * line; then the whole form, for what goes to the connector.
 */
export function checkConnectorForm(params: ConnectorFormParams, values: Record<string, ConnectorFormValue>, check: ConnectorFormCheck): { content: ConnectorFormContent } | { lines: Record<string, string> } {
	const required = new Set(params.requestedSchema.required ?? []);
	const lines: Record<string, string> = {};
	for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
		try {
			check({ ...params, requestedSchema: { type: "object", properties: { [name]: schema }, ...(required.has(name) ? { required: [name] } : {}) } }, { [name]: values[name] });
		} catch {
			lines[name] = lineFor(schema, values[name]);
		}
	}
	if (Object.keys(lines).length > 0) return { lines };
	return { content: check(params, values) };
}
