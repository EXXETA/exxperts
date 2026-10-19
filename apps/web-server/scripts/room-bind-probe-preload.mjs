// Test-only, loaded with `node --import` by persistent-room-bind-order-smoke:
// records the bind's extension factories, or makes a tool leak into it.
import fs from "node:fs";

const recordFile = process.env.ROOM_BIND_PROBE_RECORD;
const leakTool = process.env.ROOM_BIND_PROBE_LEAK;

// NODE_OPTIONS also reaches npx and tsx; only the server process is patched.
if ((process.argv[1] ?? "").replace(/\\/g, "/").endsWith("src/index.ts") && (recordFile || leakTool)) {
	const runtime = await import("@exxeta/exxperts-runtime");

	const reload = runtime.DefaultResourceLoader.prototype.reload;
	runtime.DefaultResourceLoader.prototype.reload = async function (...args) {
		if (recordFile) {
			const names = (this.extensionFactories ?? []).map((factory) => factory?.name ?? "");
			fs.appendFileSync(recordFile, `${JSON.stringify(names)}\n`);
		}
		return reload.apply(this, args);
	};

	const bindExtensions = runtime.AgentSession.prototype.bindExtensions;
	runtime.AgentSession.prototype.bindExtensions = async function (...args) {
		const result = await bindExtensions.apply(this, args);
		if (leakTool && !this.agent.state.tools.some((tool) => tool.name === leakTool)) {
			this.agent.state.tools = [...this.agent.state.tools, {
				name: leakTool,
				label: leakTool,
				description: "probe tool",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: undefined }),
			}];
		}
		return result;
	};
}
