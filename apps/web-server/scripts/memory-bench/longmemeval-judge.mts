// LongMemEval's judge, ported (memory v2, stream 41.4).
//
// LongMemEval scores an answer with a model rather than with a string match:
// `evaluate_qa.py` asks a judge "is the model response correct?" once per
// question, with a prompt chosen by the question's type, and counts the replies
// that contain the word "yes". This file is that judge, in TypeScript, so a
// recall run can be judged without a Python environment and so the SAME judge
// can be pointed at our own fixture's answers.
//
// Two rules hold it to the original, and both are worth more than any
// improvement anyone could make here:
//
//   - The six templates below are the upstream strings, character for
//     character. Trailing spaces included: two of them end "answer no. " and
//     "still correct. " before the blank line, which is an artefact of the
//     original and is kept, because a judge prompt that differs by a character
//     is a different judge and its numbers are not comparable with anybody's.
//   - The label is `'yes' in reply.lower()`, the whole rule. A judge that
//     answers "No, the response does not..." is a no; a judge that answers
//     "Yes." is a yes; a judge that writes an essay containing the word "yes"
//     anywhere is a yes, which is why upstream asks for "yes or no only" and
//     caps the reply at ten tokens. We ask the same, and the cap is carried by
//     the caller: a judge call hands the worker the model with `maxTokens` set
//     to ten (`maxOutputTokens` on a maintenance-worker call), which is the
//     only place in this bench where a reply is deliberately cut short.
//
// Nothing here calls a provider. `generate` is handed in, so the caller decides
// whether the judge is a real model or a scripted reply, and a smoke can pin
// the port with no provider at all.

/** The six question types LongMemEval labels its instances with. */
export const LONGMEMEVAL_QUESTION_TYPES = [
	"single-session-user",
	"single-session-assistant",
	"single-session-preference",
	"multi-session",
	"temporal-reasoning",
	"knowledge-update",
] as const;

export type LongMemEvalQuestionType = (typeof LONGMEMEVAL_QUESTION_TYPES)[number];

/** The extra row an abstention question is counted in; `_abs` in the id is what marks one. */
export const ABSTENTION_KEY = "abstention" as const;

/**
 * The upstream templates, keyed by the task name `get_anscheck_prompt`
 * branches on, plus the `abstention` branch that ignores the task entirely.
 *
 * Three of the six types share ONE string upstream — the branch reads
 * `task in ['single-session-user', 'single-session-assistant',
 * 'multi-session']` — so the three keys below hold the same characters on
 * purpose. Keying by type rather than by branch is what lets a caller print a
 * table per type without knowing which types were grouped.
 */
export const LONGMEMEVAL_JUDGE_TEMPLATES: Record<LongMemEvalQuestionType | typeof ABSTENTION_KEY, string> = {
	"single-session-user": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
	"single-session-assistant": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
	"multi-session": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
	"temporal-reasoning": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
	"knowledge-update": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
	"single-session-preference": "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
	abstention: "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.",
};

/**
 * Python's `str.format` with positional `{}` holes: the nth hole takes the nth
 * value, and a value that itself contains `{}` is never rescanned. A naive
 * chain of `replace` would substitute into a hypothesis that happens to carry
 * braces, which is exactly the answer a judge should be shown unaltered.
 */
function format(template: string, values: readonly string[]): string {
	let out = "";
	let at = 0;
	let taken = 0;
	for (;;) {
		const hole = template.indexOf("{}", at);
		if (hole < 0 || taken >= values.length) break;
		out += template.slice(at, hole) + values[taken];
		at = hole + 2;
		taken += 1;
	}
	return out + template.slice(at);
}

export interface JudgePromptInput {
	/** The instance's `question_type`; ignored when `abstention` is true, as upstream ignores it. */
	questionType: string;
	question: string;
	/** The gold answer — the rubric for a preference question, the explanation for an abstention. */
	answer: string;
	/** What the system under test said. */
	hypothesis: string;
	abstention?: boolean;
}

/**
 * `get_anscheck_prompt`, hole for hole: question, then answer, then response.
 *
 * An unknown type is a throw, where upstream raises NotImplementedError — a
 * type nobody wrote a template for must never be judged by the template of
 * some other type, because the run would report a number for it anyway.
 */
export function judgePrompt(input: JudgePromptInput): string {
	const values = [input.question, input.answer, input.hypothesis];
	if (input.abstention) return format(LONGMEMEVAL_JUDGE_TEMPLATES.abstention, values);
	const template = (LONGMEMEVAL_JUDGE_TEMPLATES as Record<string, string | undefined>)[input.questionType];
	if (template === undefined || input.questionType === ABSTENTION_KEY) throw new Error(`no judge template for question type "${input.questionType}"`);
	return format(template, values);
}

/**
 * The verdict, upstream's whole rule: the reply, lowercased, contains "yes".
 * The trim mirrors the `.strip()` upstream applies before the test and changes
 * nothing about the outcome.
 */
export function judgeLabel(reply: string): boolean {
	return String(reply ?? "").trim().toLowerCase().includes("yes");
}

/** Whether an id is one of the abstention questions: the `_abs` upstream marks them with. */
export function isAbstentionId(questionId: string): boolean {
	return String(questionId ?? "").includes("_abs");
}

/** One line of a hypothesis file: what upstream reads with `json.loads` per line. */
export interface JudgeHypothesisLine {
	question_id: string;
	hypothesis: string;
	[key: string]: unknown;
}

/** One reference instance; the data file's own fields, and only the four the judge reads. */
export interface JudgeReference {
	question_id: string;
	question_type: string;
	question: string;
	answer: string;
}

export interface JudgedLine extends JudgeHypothesisLine {
	autoeval_label: { model: string | null; label: boolean };
}

export interface JudgeAccuracyRow {
	label: string;
	correct: number;
	total: number;
	/** null when nothing of this kind was judged, so an empty row never reads as 0%. */
	accuracy: number | null;
}

export interface JudgeAccuracyTable {
	rows: JudgeAccuracyRow[];
	overall: JudgeAccuracyRow;
}

export interface JudgeHypothesesInput {
	lines: readonly JudgeHypothesisLine[];
	references: readonly JudgeReference[];
	/** One judge call. The caller decides what is behind it: a model, or a scripted reply in a smoke. */
	generate: (prompt: string) => Promise<string>;
	/** Who was asked, for the `autoeval_label` the judged file carries; null when the caller does not say. */
	model?: string | null;
	/** Called after each verdict, for a long run that wants to say where it is. */
	onVerdict?: (input: { index: number; total: number; questionId: string; label: boolean }) => void;
}

/**
 * Every hypothesis judged, and the table the numbers are read off.
 *
 * The grouping is upstream's: one row per question TYPE, with every id of that
 * type in it, abstention ids included — they are questions of their type whose
 * right answer happens to be "I can't tell you". The `abstention` row is an
 * ADDITION, over the `_abs` ids of every type, because "does the room refuse
 * when it should" is the one thing the per-type rows cannot be read for. An id
 * therefore counts in two rows, and the overall line counts it once.
 *
 * A hypothesis for a question the references do not hold is skipped and named,
 * as upstream skips and warns: a run over a sample must not be scored against a
 * denominator it never answered.
 */
export async function judgeHypotheses(input: JudgeHypothesesInput): Promise<{ judged: JudgedLine[]; skipped: string[]; table: JudgeAccuracyTable }> {
	const byId = new Map(input.references.map((reference) => [reference.question_id, reference] as const));
	const judged: JudgedLine[] = [];
	const skipped: string[] = [];
	const model = input.model ?? null;
	const answered = input.lines.filter((line) => byId.has(line.question_id));
	for (const line of input.lines) {
		const reference = byId.get(line.question_id);
		if (!reference) {
			skipped.push(line.question_id);
			continue;
		}
		const abstention = isAbstentionId(line.question_id);
		const prompt = judgePrompt({
			questionType: reference.question_type,
			question: reference.question,
			answer: reference.answer,
			hypothesis: line.hypothesis,
			abstention,
		});
		const label = judgeLabel(await input.generate(prompt));
		judged.push({ ...line, autoeval_label: { model, label } });
		input.onVerdict?.({ index: judged.length, total: answered.length, questionId: line.question_id, label });
	}

	const rowFor = (label: string, rows: readonly JudgedLine[]): JudgeAccuracyRow => {
		const correct = rows.filter((row) => row.autoeval_label.label).length;
		return { label, correct, total: rows.length, accuracy: rows.length === 0 ? null : correct / rows.length };
	};
	const typeOf = (line: JudgedLine) => byId.get(line.question_id)?.question_type ?? "";
	const types = [...new Set(judged.map(typeOf))].sort();
	const rows = types.map((type) => rowFor(type, judged.filter((line) => typeOf(line) === type)));
	const abstentions = judged.filter((line) => isAbstentionId(line.question_id));
	if (abstentions.length > 0) rows.push(rowFor(ABSTENTION_KEY, abstentions));
	return { judged, skipped, table: { rows, overall: rowFor("all", judged) } };
}

/** The table as lines of text, widest label first so the numbers line up. */
export function renderJudgeTable(table: JudgeAccuracyTable): string[] {
	const all = [...table.rows, table.overall];
	const width = Math.max(...all.map((row) => row.label.length));
	return all.map((row) => `  ${row.label.padEnd(width)}  ${row.accuracy === null ? "-" : `${row.correct}/${row.total} ${Math.round(row.accuracy * 100)}%`}`);
}
