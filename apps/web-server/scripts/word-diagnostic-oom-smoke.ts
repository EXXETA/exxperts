// An invented worker crash retains the existing bounded OOM classification.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

let oom = true;
childProcess.fork = (() => {
	const child = new EventEmitter() as any;
	child.stderr = new EventEmitter();
	child.kill = () => true;
	setImmediate(() => {
		child.stderr.emit("data", Buffer.from("x".repeat(9000)));
		child.stderr.emit("data", Buffer.from(oom ? "heap out of memory" : "invented crash"));
		child.emit("exit", 1, null);
		child.emit("close", 1, null);
	});
	return child;
}) as typeof childProcess.fork;
syncBuiltinESMExports();
const { runShelfParseWorker } = await import("../src/persistent-room-shelf-reading.js");
await assert.rejects(runShelfParseWorker("invented.docx", "docx"), (error: any) => error.code === "too_complex");
oom = false;
await assert.rejects(runShelfParseWorker("invented.docx", "docx"), (error: any) => error.code === "parse_failed");
console.log("word-diagnostic-oom smoke: ok");
