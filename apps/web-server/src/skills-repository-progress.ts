import { AsyncLocalStorage } from "node:async_hooks";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

interface RepositoryProgress {
	message: string;
	completed?: number;
	total?: number;
	status: "running" | "complete" | "failed";
	updatedAt: number;
}
interface ProgressRecord { profile: string; progress: RepositoryProgress }
const records = new Map<string, ProgressRecord>();
const context = new AsyncLocalStorage<ProgressRecord>();
const TTL = 15 * 60_000;
function validId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid repository progress identifier.");
}

/** Display-only, scoped to this request and profile; never changes an import or approval. */
export async function withRepositoryProgress<T>(id: unknown, work: () => Promise<T>): Promise<T> {
	if (id === undefined) return work();
	validId(id);
	for (const [key, record] of records) if (record.progress.status !== "running" && Date.now() - record.progress.updatedAt > TTL) records.delete(key);
	if (records.has(id)) throw Object.assign(new Error("Repository progress identifier already in use."), { statusCode: 409 });
	if (records.size >= 128) {
		const oldest = [...records].find(([, record]) => record.progress.status !== "running");
		if (oldest) records.delete(oldest[0]);
		else throw Object.assign(new Error("Too many repository operations are running."), { statusCode: 503 });
	}
	const record: ProgressRecord = { profile: productAppStatePath(), progress: { message: "Starting repository operation", status: "running", updatedAt: Date.now() } };
	records.set(id, record);
	return context.run(record, async () => {
		try { const result = await work(); record.progress = { ...record.progress, status: "complete", updatedAt: Date.now() }; return result; }
		catch (error) { record.progress = { ...record.progress, status: "failed", updatedAt: Date.now() }; throw error; }
	});
}

export function reportRepositoryProgress(message: string, completed?: number, total?: number): void {
	const record = context.getStore();
	if (record) record.progress = { message, ...(completed === undefined ? {} : { completed }), ...(total === undefined ? {} : { total }), status: "running", updatedAt: Date.now() };
}

export function readRepositoryProgress(id: unknown): RepositoryProgress | null {
	validId(id);
	const record = records.get(id);
	if (!record || record.profile !== productAppStatePath() || Date.now() - record.progress.updatedAt > TTL) return null;
	return { ...record.progress };
}
