// The bench's memory model, offline, against the scripted gateway.
//
// The product runs Remember and Memorize on the room's Memory model, and a
// bench run names that model with RECALL_BENCH_MEMORY_MODEL. This smoke pins,
// with no provider at all, the model each checkpoint and each fold request
// names at the gateway:
//   - with a memory model named, every checkpoint and every fold runs on it;
//   - with RECALL_BENCH_FOLD_MODEL named as well, the fold follows that one;
//   - with neither, the checkpoint stays on the room model and the fold on the
//     profile's Memorize model, as every earlier run measured;
//   - the run's models line names each part and the setting behind it.

import fs from "node:fs";

import * as engine from "./memory-bench/recall-engine.mjs";
import { buildRecallFixture } from "./memory-bench/recall-fixtures.mjs";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const pass = (message: string) => console.log(`ok ${message}`);

const ROOM = "room-model";
const MEMORY = "memory-model";
const { home } = engine.prepareBenchHome("recall-bench-memory-model-smoke");
process.env.RECALL_BENCH_RETRY_SCHEDULE_MS = "10,10,10,10,10";
const sessions = buildRecallFixture({ language: "en", sessions: 4, questionsPerAbility: 1, conversationQuestions: 1 }).sessions.slice(0, 2);

/** Two conversations and one Memorize through the real ingest, with the settings given; what the gateway saw. */
async function ingest(settings: { memory?: string; fold?: string }) {
	const gateway = await engine.startScriptedRoomGateway({ questions: [], plants: [] });
	try {
		const lock = engine.writeScriptedProviderRecords({ gatewayPort: gateway.port, modelId: ROOM, memoryModelId: MEMORY });
		engine.setBenchModel(lock);
		if (settings.memory) process.env.RECALL_BENCH_MEMORY_MODEL = `${lock.provider}/${settings.memory}`;
		if (settings.fold) process.env.RECALL_BENCH_FOLD_MODEL = `${lock.provider}/${settings.fold}`;
		const line = engine.benchModelsLine(lock);
		const pair = await engine.createRealIngest({ roomModel: lock });
		const room = await engine.createBenchRoom({ home, name: `Memory Model ${Math.random().toString(36).slice(2, 6)}` });
		engine.startProviderRetryUnit();
		const report = await engine.ingestSessions({ roomId: room.roomId, sessions, remember: pair.remember, memorize: pair.memorize, foldEvery: 2 });
		assert(report.steps.length === 1 && report.failures.length === 0, `two conversations make one clean Memorize run, got ${report.steps.length} and ${report.failures.length} failure(s)`);
		return { models: gateway.models, line };
	} finally {
		delete process.env.RECALL_BENCH_MEMORY_MODEL;
		delete process.env.RECALL_BENCH_FOLD_MODEL;
		await gateway.close();
	}
}

const all = (calls: string[], model: string) => calls.length > 0 && calls.every((name) => name === model);

try {
	const memory = await ingest({ memory: MEMORY });
	assert(all(memory.models.checkpoint, MEMORY) && memory.models.checkpoint.length === 2, `every checkpoint runs on the memory model, got ${JSON.stringify(memory.models.checkpoint)}`);
	assert(all(memory.models.fold, MEMORY), `every fold runs on the memory model, got ${JSON.stringify(memory.models.fold)}`);
	assert(memory.line.includes(`checkpoint on openai-compatible/${MEMORY} (RECALL_BENCH_MEMORY_MODEL)`) && memory.line.includes(`fold on openai-compatible/${MEMORY} (RECALL_BENCH_MEMORY_MODEL)`) && memory.line.includes(`answers on openai-compatible/${ROOM}`), `the models line names the memory model for both, got ${JSON.stringify(memory.line)}`);
	pass("a named memory model does every checkpoint and every fold, and the room model answers");

	const fold = await ingest({ memory: MEMORY, fold: ROOM });
	assert(all(fold.models.checkpoint, MEMORY) && all(fold.models.fold, ROOM), `the fold setting wins for the fold, got checkpoints ${JSON.stringify(fold.models.checkpoint)} and folds ${JSON.stringify(fold.models.fold)}`);
	assert(fold.line.includes(`fold on openai-compatible/${ROOM} (RECALL_BENCH_FOLD_MODEL)`), `the models line names the fold setting, got ${JSON.stringify(fold.line)}`);
	pass("with both named, the checkpoint follows the memory model and the fold the fold model");

	const neither = await ingest({});
	assert(all(neither.models.checkpoint, ROOM) && all(neither.models.fold, ROOM), `with neither, the checkpoint stays on the room model and the fold on the profile's Memorize model, got checkpoints ${JSON.stringify(neither.models.checkpoint)} and folds ${JSON.stringify(neither.models.fold)}`);
	assert(neither.line.includes(`checkpoint on openai-compatible/${ROOM} (the room model)`) && neither.line.includes("fold on the profile's Memorize model"), `the models line says where each comes from, got ${JSON.stringify(neither.line)}`);
	pass("with neither, a run measures what earlier runs measured");

	console.log("recall-bench memory-model smoke passed");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
