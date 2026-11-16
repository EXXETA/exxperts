import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@exxeta/exxperts-runtime";

import { BoxFault, FolderMoved } from "./box-process.js";

const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Copies into a new file made exclusively, with no following a link, then removes the source. */
export async function moveSpill(from: string, to: string): Promise<void> {
	const target = await fs.open(to, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
	try {
		const source = await fs.open(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			for await (const chunk of source.createReadStream({ autoClose: false })) await target.write(chunk as Buffer);
		} finally {
			await source.close();
		}
	} finally {
		await target.close();
	}
	await fs.rm(from, { force: true });
}

/** File tools that open by name outside the box can't reach the private temp, so `read` stays closed to it there. */
const READ_SPILL_LINE = "Read it with a command, such as tail or sed: the read tool can't open it.";

/**
 * Moves one command's long output out of the shared temp, which the box and the
 * file tools close, into the run's private temp, and rewrites its name wherever
 * it shows. A command can write in the private temp, so the file is made under a
 * random name, exclusively, with no following a link: nothing waiting there can
 * catch it. The private temp itself can't be swapped (boxRules).
 */
class SpillMove {
	private from: string | null = null;
	private to: string | null = null;
	// The runtime's own name for a spill; a line a command prints can't rename anything else.
	// Thrown text carries the spill only in the runtime's footer; a result names it in its details.
	private readonly runtimeFooter = new RegExp(`Full output: (${escapeForRegex(path.join(os.tmpdir(), "pi-bash-"))}[0-9a-f]{16}\\.log)\\]`, "g");

	constructor(private readonly temp: string, private readonly readable: boolean, private readonly readLine: string) {}

	private note(spill: string): string {
		if (this.from !== spill) {
			this.from = spill;
			this.to = path.join(this.temp, `${randomBytes(16).toString("hex")}.log`);
		}
		return this.to as string;
	}

	private rewritten(text: string): string {
		if (!this.from || !this.to) return text;
		const named = text.replaceAll(this.from, this.to);
		return this.readable ? named : named.replace(`${this.to}]`, `${this.to}]\n${this.readLine}`);
	}

	rewriteText(text: string): string {
		const footer = [...text.matchAll(this.runtimeFooter)].at(-1);
		if (footer) this.note(footer[1]);
		return this.rewritten(text);
	}

	rewriteResult<T extends { content?: { type?: string; text?: string }[]; details?: { fullOutputPath?: string } }>(result: T): T {
		const spill = result?.details?.fullOutputPath;
		const moved = spill ? this.note(spill) : null;
		return {
			...result,
			...(Array.isArray(result?.content) ? { content: result.content.map((part) => (part?.type === "text" && typeof part.text === "string" ? { ...part, text: this.rewritten(part.text) } : part)) } : {}),
			...(moved ? { details: { ...result.details, fullOutputPath: moved } } : {}),
		};
	}

	/** The moved file's exact path, or null when output that only looks like the footer named no file. */
	async finish(): Promise<string | null> {
		if (!this.from || !this.to) return null;
		try {
			await moveSpill(this.from, this.to);
			return this.to;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return null;
		}
	}
}

/** Where a run's long output lands, and who may read it there after. */
export interface SpillPlace {
	/** Stop, given as `signal`, may end the wait for it. */
	privateTemp(signal?: AbortSignal): Promise<string>;
	/** The file tools read a moved spill by this exact path, in the box, until the turn ends. */
	noteSpill(file: string): void;
	/** Whether the file tools read in this box, so they can open a moved spill. */
	readsSpills(): boolean;
}

/**
 * A tool whose long output lands in the run's private temp, with the path right
 * in streamed, returned and thrown text. `readLine` follows the path where the
 * file tools can't read it: how a command reads it in the box's shell.
 */
export function withPrivateSpill(tool: ToolDefinition<any, any>, place: SpillPlace, notStarted: (toolCallId: string) => void, readLine = READ_SPILL_LINE): ToolDefinition<any, any> {
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let temp: string;
			try {
				temp = await place.privateTemp(signal);
			} catch (error) {
				notStarted(toolCallId);
				throw error;
			}
			const spill = new SpillMove(temp, place.readsSpills(), readLine);
			const finish = async () => {
				const moved = await spill.finish();
				if (moved) place.noteSpill(moved);
			};
			const update = onUpdate ? (partial: any) => onUpdate(spill.rewriteResult(partial)) : undefined;
			try {
				const result = await tool.execute(toolCallId, params, signal, update, ctx);
				const rewritten = spill.rewriteResult(result as any);
				await finish();
				return rewritten;
			} catch (error) {
				// None starts the command: the record of what ran leaves it out.
				const neverRan = error instanceof BoxFault || error instanceof FolderMoved;
				if (neverRan) notStarted(toolCallId);
				if (!(error instanceof Error)) throw error;
				const message = spill.rewriteText(error.message);
				await finish();
				throw neverRan ? error : new Error(message);
			}
		},
	};
}
