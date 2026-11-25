import fs from "node:fs";

import type { BashOperations, ToolDefinition } from "@exxeta/exxperts-runtime";
import { createBashToolDefinition } from "@exxeta/exxperts-runtime";
import { Type } from "typebox";

import { COMMAND_DECLINED, NOBODY_TO_APPROVE_COMMAND } from "../persistent-room-bash-approval.js";
import { PERSISTENT_ROOM_SHELL_MISSING_SENTENCE, persistentRoomBashFound } from "../persistent-room-shell-missing.js";
import { OUTSIDE_COMMAND_MAX_CHARS, RUN_OUTSIDE_BOX_TOOL_NAME } from "./card-text.js";
import type { NotNowCount } from "./folder-question.js";
import { WINDOWS_OUTSIDE_COMMAND_INPUT, WINDOWS_OUTSIDE_DESCRIPTION, WINDOWS_OUTSIDE_POWERSHELL_COMMAND_INPUT, WINDOWS_OUTSIDE_POWERSHELL_DESCRIPTION } from "./windows/model-lines.js";

/** The slice of the room's question bridge this tool uses. */
export interface OutsideQuestions {
	watcher(): "computer" | "phone" | "none";
	askOutside(card: { command: string; reason: string }): Promise<boolean>;
}

export interface OutsideToolOptions {
	questions: OutsideQuestions;
	/** Takes the tool out of, or puts it back in, what the model is offered. */
	setOffered: (offered: boolean) => void;
	/** Marks a call that started nothing, so its record never says a command ran. */
	notStarted: (toolCallId: string) => void;
	/** Whether a shell to run the command in can be found. */
	shellFound: () => boolean;
	/** The Not nows this card shares with the room's asks: enough of them end the offer until the person writes. */
	notNow: NotNowCount;
	/** Why the room's commands can't run now, or null while they're on: read before the card and again after its yes. */
	commandsOff: () => string | null;
	/** Beside the Windows box, whose commands are PowerShell: the shell this tool's command runs in. With bash, and none found any more, it refuses before its card. */
	besideWindowsBox?: "bash" | "powershell";
}

/** What the model reads of this tool: the Mac's texts, or Windows' by the shell the command runs in. */
const TEXTS = {
	mac: { description: "Ask the person to run one command outside this room's protection, with all their rights, when the room's commands can't do it: git push over SSH, git clone in their folder, opening an app. They see the full command and your reason on a card and must say yes each time. Use this only when the bash tool has failed for that reason, never just to get at a place the room's protection keeps closed on purpose, such as the person's keys or a local address, unless the person asks.", command: "The one bash command to run outside this room" },
	bash: { description: WINDOWS_OUTSIDE_DESCRIPTION, command: WINDOWS_OUTSIDE_COMMAND_INPUT },
	powershell: { description: WINDOWS_OUTSIDE_POWERSHELL_DESCRIPTION, command: WINDOWS_OUTSIDE_POWERSHELL_COMMAND_INPUT },
};

const outsideSchema = (command: string) => Type.Object({
	command: Type.String({ description: command }),
	reason: Type.String({ description: "Why this needs to run outside the room, for the person, in plain words" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

/**
 * The one way out of the box: a tool of its own, so a boxed command can never
 * become an outside one by what it says. Its plain operations live only here.
 * Every call shows the card and runs the one `command` value the card showed.
 */
export function createOutsideTool(cwd: string, plain: BashOperations, options: OutsideToolOptions): { tool: ToolDefinition<any, any>; personSpoke: () => void } {
	const inner: ToolDefinition<any, any> = createBashToolDefinition(cwd, { operations: plain });
	const { notNow } = options;
	const texts = TEXTS[options.besideWindowsBox ?? "mac"];
	const refuse = (toolCallId: string, sentence: string): never => {
		options.notStarted(toolCallId);
		throw new Error(sentence);
	};
	const tool: ToolDefinition<any, any> = {
		...inner,
		name: RUN_OUTSIDE_BOX_TOOL_NAME,
		label: RUN_OUTSIDE_BOX_TOOL_NAME,
		description: texts.description,
		promptSnippet: "Ask the person to run one command outside the room's protection",
		// On its own in a batch: a boxed command beside it would run by rules made before it changed the room.
		executionMode: "sequential",
		parameters: outsideSchema(texts.command),
		async execute(toolCallId, params: { command: string; reason?: string; timeout?: number }, signal, onUpdate, ctx) {
			const command = String(params.command ?? "");
			const offBefore = options.commandsOff();
			if (offBefore) return refuse(toolCallId, offBefore);
			// On a Mac a shell is always there; on Windows a card would ask for a yes that can run nothing. Only no shell at all counts: a settings path that is wrong reaches the runtime's own words.
			if (options.besideWindowsBox === "bash" && !persistentRoomBashFound()) return refuse(toolCallId, PERSISTENT_ROOM_SHELL_MISSING_SENTENCE);
			if (notNow.reached()) return refuse(toolCallId, `${COMMAND_DECLINED} They have declined several times, so do not ask again until they write.`);
			if (options.questions.watcher() !== "computer") return refuse(toolCallId, NOBODY_TO_APPROVE_COMMAND);
			if (command.length > OUTSIDE_COMMAND_MAX_CHARS) return refuse(toolCallId, `This command is longer than ${OUTSIDE_COMMAND_MAX_CHARS} characters, too long to show on the card, so nothing ran.`);
			const approved = await options.questions.askOutside({ command, reason: String(params.reason ?? "") }).catch((error: Error) => refuse(toolCallId, error.message));
			if (!approved) {
				notNow.notNow();
				if (notNow.reached()) options.setOffered(false);
				return refuse(toolCallId, `${COMMAND_DECLINED} Do not run it or retry variants of it unless the user asks.`);
			}
			notNow.yes();
			// Turn off may have been pressed while the card waited.
			const offAfter = options.commandsOff();
			if (offAfter) return refuse(toolCallId, offAfter);
			// The runtime's own words say why; the record must not say a command ran.
			if (!fs.existsSync(cwd) || !options.shellFound()) options.notStarted(toolCallId);
			return inner.execute(toolCallId, { command, timeout: params.timeout }, signal, onUpdate, ctx);
		},
	};
	return {
		tool,
		personSpoke() {
			notNow.personSpoke();
			options.setOffered(true);
		},
	};
}
