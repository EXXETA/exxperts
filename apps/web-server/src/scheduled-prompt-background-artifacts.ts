import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	backgroundRunsRootPath,
	validateBackgroundRunId,
	type BackgroundRunArtifacts,
	type BackgroundRunRecord,
} from "./background-runs.js";
import { getPersistentAgentThread } from "./persistent-agents.js";
import {
	scheduledAnswerKey,
	scheduledPromptBackgroundAssistantItemId,
	scheduledPromptBackgroundThreadId,
	scheduledPromptBackgroundUserItemId,
} from "./persistent-room-background-execution.js";

export interface ScheduledPromptBackgroundRunArtifactPaths {
	inputRelPath: string;
	outputRelPath: string;
}

export interface WriteScheduledPromptBackgroundRunInputArtifactInput {
	run: BackgroundRunRecord;
	prompt: string;
	snapshottedAt?: Date;
}

export interface WriteScheduledPromptBackgroundRunOutputArtifactInput {
	run: BackgroundRunRecord;
	assistantText: string;
	completedAt?: Date;
}

export interface ScheduledPromptBackgroundRunIdempotencyEvidence {
	runId: string;
	roomId?: string;
	threadId?: string;
	userItemId: string;
	assistantItemId: string;
	hasInputArtifact: boolean;
	hasOutputArtifact: boolean;
	hasUserItem: boolean;
	hasAssistantItem: boolean;
	alreadyCompleted: boolean;
}

function artifactRelPath(runIdRaw: unknown, filename: "input.md" | "output.md"): string {
	const runId = validateBackgroundRunId(runIdRaw);
	return `runs/${runId}/${filename}`;
}

export function scheduledPromptBackgroundRunArtifactPaths(runIdRaw: unknown): ScheduledPromptBackgroundRunArtifactPaths {
	return {
		inputRelPath: artifactRelPath(runIdRaw, "input.md"),
		outputRelPath: artifactRelPath(runIdRaw, "output.md"),
	};
}

export function mergeScheduledPromptBackgroundRunArtifacts(
	existing: BackgroundRunArtifacts | undefined,
	paths: Partial<BackgroundRunArtifacts>,
): BackgroundRunArtifacts {
	return {
		...(existing ?? {}),
		...paths,
	};
}

function resolveArtifactPath(relPathRaw: unknown): string {
	const relPath = String(relPathRaw ?? "").trim();
	if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0") || relPath.split(/[\\/]+/).includes("..")) {
		throw new Error("invalid scheduled prompt background artifact path");
	}
	const root = path.resolve(backgroundRunsRootPath());
	const file = path.resolve(root, relPath);
	if (file !== root && !file.startsWith(root + path.sep)) throw new Error("scheduled prompt background artifact path escaped root");
	return file;
}

function artifactExists(relPath: string): boolean {
	try {
		const stat = fs.statSync(resolveArtifactPath(relPath));
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

function atomicWritePrivateText(file: string, content: string, options: { overwrite?: boolean } = {}): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	if (!options.overwrite && fs.existsSync(file)) return;
	const tempFile = path.join(path.dirname(file), `.artifact.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
	try {
		fs.writeFileSync(tempFile, content, { mode: 0o600 });
		if (options.overwrite) fs.renameSync(tempFile, file);
		else {
			try {
				fs.linkSync(tempFile, file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			fs.rmSync(tempFile, { force: true });
		}
		try { fs.chmodSync(file, 0o600); } catch {}
	} catch (error) {
		try { fs.rmSync(tempFile, { force: true }); } catch {}
		throw error;
	}
}

function normalizeDate(date: Date | undefined): Date {
	const value = date ? new Date(date) : new Date();
	if (Number.isNaN(value.getTime())) throw new Error("invalid scheduled prompt background artifact timestamp");
	return value;
}

function quoted(value: unknown): string {
	return JSON.stringify(String(value ?? ""));
}

function runRoomId(run: BackgroundRunRecord): string | undefined {
	return run.scope.kind === "persistent-room" ? run.scope.roomId : undefined;
}

function inputArtifactMarkdown(run: BackgroundRunRecord, prompt: string, snapshottedAt: Date): string {
	return [
		"---",
		`runId: ${quoted(run.runId)}`,
		`roomId: ${quoted(runRoomId(run) ?? "")}`,
		`scheduleId: ${quoted(run.source.schedulerJobId ?? "")}`,
		`dueAt: ${quoted(run.source.dueAt ?? "")}`,
		`snapshottedAt: ${quoted(snapshottedAt.toISOString())}`,
		"---",
		"",
		prompt,
		"",
	].join("\n");
}

function outputArtifactMarkdown(run: BackgroundRunRecord, assistantText: string, completedAt: Date): string {
	return [
		"---",
		`runId: ${quoted(run.runId)}`,
		`roomId: ${quoted(runRoomId(run) ?? "")}`,
		`scheduleId: ${quoted(run.source.schedulerJobId ?? "")}`,
		`dueAt: ${quoted(run.source.dueAt ?? "")}`,
		`completedAt: ${quoted(completedAt.toISOString())}`,
		"---",
		"",
		assistantText,
		"",
	].join("\n");
}

function currentArtifactPaths(run: BackgroundRunRecord): BackgroundRunArtifacts {
	const paths = scheduledPromptBackgroundRunArtifactPaths(run.runId);
	return {
		...(run.artifacts ?? {}),
		...(run.artifacts?.inputRelPath ? {} : artifactExists(paths.inputRelPath) ? { inputRelPath: paths.inputRelPath } : {}),
		...(run.artifacts?.outputRelPath ? {} : artifactExists(paths.outputRelPath) ? { outputRelPath: paths.outputRelPath } : {}),
	};
}

export function writeScheduledPromptBackgroundRunInputArtifact(input: WriteScheduledPromptBackgroundRunInputArtifactInput): BackgroundRunArtifacts {
	const prompt = String(input.prompt ?? "");
	if (!prompt.trim()) throw new Error("scheduled prompt background input artifact prompt is empty");
	const paths = scheduledPromptBackgroundRunArtifactPaths(input.run.runId);
	atomicWritePrivateText(
		resolveArtifactPath(paths.inputRelPath),
		inputArtifactMarkdown(input.run, prompt, normalizeDate(input.snapshottedAt)),
	);
	return mergeScheduledPromptBackgroundRunArtifacts(currentArtifactPaths(input.run), { inputRelPath: paths.inputRelPath });
}

export function writeScheduledPromptBackgroundRunOutputArtifact(input: WriteScheduledPromptBackgroundRunOutputArtifactInput): BackgroundRunArtifacts {
	const assistantText = String(input.assistantText ?? "");
	if (!assistantText.trim()) throw new Error("scheduled prompt background output artifact text is empty");
	const paths = scheduledPromptBackgroundRunArtifactPaths(input.run.runId);
	atomicWritePrivateText(
		resolveArtifactPath(paths.outputRelPath),
		outputArtifactMarkdown(input.run, assistantText, normalizeDate(input.completedAt)),
	);
	return mergeScheduledPromptBackgroundRunArtifacts(currentArtifactPaths(input.run), { outputRelPath: paths.outputRelPath });
}

export function scheduledPromptBackgroundRunHasInputArtifact(run: BackgroundRunRecord): boolean {
	const relPath = run.artifacts?.inputRelPath ?? scheduledPromptBackgroundRunArtifactPaths(run.runId).inputRelPath;
	return artifactExists(relPath);
}

export function scheduledPromptBackgroundRunHasOutputArtifact(run: BackgroundRunRecord): boolean {
	const relPath = run.artifacts?.outputRelPath ?? scheduledPromptBackgroundRunArtifactPaths(run.runId).outputRelPath;
	return artifactExists(relPath);
}

function itemExists(items: unknown[], itemId: string | ((id: string) => boolean), kind: "user" | "assistant"): boolean {
	const named = typeof itemId === "string" ? (id: string) => id === itemId : itemId;
	return items.some((item: any) => item?.kind === kind && typeof item?.id === "string" && named(item.id) && typeof item?.text === "string" && item.text.trim().length > 0);
}

/** A run through the room's live session landed under its key: the question as the key, the answer as `<key>-a<n>` (thread-items-by-id.ts). */
function keyedAnswerPart(key: string): (id: string) => boolean {
	return (id) => id.startsWith(`${key}-a`) && /^\d+$/.test(id.slice(key.length + 2));
}

export function inspectScheduledPromptBackgroundRunIdempotency(input: { run: BackgroundRunRecord; threadId?: string }): ScheduledPromptBackgroundRunIdempotencyEvidence {
	const runId = validateBackgroundRunId(input.run.runId);
	const roomId = runRoomId(input.run);
	const userItemId = scheduledPromptBackgroundUserItemId(runId);
	const assistantItemId = scheduledPromptBackgroundAssistantItemId(runId);
	const targetThreadId = input.threadId
		?? input.run.target?.threadId
		?? (input.run.target?.kind === "fresh-thread" && roomId ? scheduledPromptBackgroundThreadId(runId) : undefined);
	let items: unknown[] = [];
	if (roomId && targetThreadId) {
		try {
			items = getPersistentAgentThread(roomId, targetThreadId)?.items ?? [];
		} catch {
			items = [];
		}
	}
	const hasInputArtifact = scheduledPromptBackgroundRunHasInputArtifact(input.run);
	const hasOutputArtifact = scheduledPromptBackgroundRunHasOutputArtifact(input.run);
	const key = scheduledAnswerKey(runId);
	const hasUserItem = itemExists(items, userItemId, "user") || itemExists(items, key, "user");
	const hasAssistantItem = itemExists(items, assistantItemId, "assistant") || itemExists(items, keyedAnswerPart(key), "assistant");
	return {
		runId,
		...(roomId ? { roomId } : {}),
		...(targetThreadId ? { threadId: targetThreadId } : {}),
		userItemId,
		assistantItemId,
		hasInputArtifact,
		hasOutputArtifact,
		hasUserItem,
		hasAssistantItem,
		alreadyCompleted: hasOutputArtifact && hasAssistantItem,
	};
}
