import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import chalk from "chalk";
import { getAgentDir, getModelsPath } from "../config.js";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_PROVIDER_LABEL = "OpenAI-compatible gateway";
const OPENAI_COMPATIBLE_API = "openai-completions";
const OPENAI_COMPATIBLE_PROFILE_ID = "openai-compatible";
const OPENAI_COMPATIBLE_POLICY_FILE_NAME = "openai-compatible-ai-profile.json";

const SIMPLE_PROVIDER_KEYS = new Set(["name", "baseUrl", "api", "models"]);
// `input` and `contextWindow` belong here, not in the "advanced config we must
// not touch" bucket: the app writes them per model when someone marks a gateway
// model as image-capable or corrects its context size. Treating them as
// surprises made this wizard refuse to run against a config the app itself had
// produced.
const SIMPLE_MODEL_KEYS = new Set(["id", "name", "input", "contextWindow"]);

type JsonObject = Record<string, unknown>;

type JsonFileState = {
	path: string;
	exists: boolean;
	data?: unknown;
	parseError?: string;
};

/** Per-model capability facts the app records and this wizard must not erase. */
export type OpenAiCompatibleModelCapabilities = {
	/** True when the model accepts images; written as input: ["text","image"]. */
	vision?: boolean;
	/** Token window for the model; omitted means the runtime default applies. */
	contextWindow?: number;
};

export type OpenAiCompatibleSetupConfig = {
	displayName: string;
	baseUrl: string;
	primaryRoomModelId: string;
	additionalRoomModelIds: string[];
	maintenanceModelId: string;
	/**
	 * Keyed by model id. The terminal wizard never asks for these; it inherits
	 * whatever the app already stored so a re-run keeps a model's image support
	 * and context size instead of quietly resetting them to the defaults.
	 */
	modelCapabilities?: Record<string, OpenAiCompatibleModelCapabilities>;
};

export type OpenAiCompatibleSetupPlan = {
	agentDir: string;
	modelsPath: string;
	appPolicyPath: string;
	modelsState: JsonFileState;
	appPolicyState: JsonFileState;
	config: OpenAiCompatibleSetupConfig;
	changes: string[];
	conflicts: string[];
	warnings: string[];
};

export type OpenAiCompatibleSetupWriteResult = {
	backups: string[];
	updated: string[];
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): JsonFileState {
	if (!existsSync(path)) {
		return { path, exists: false };
	}

	try {
		return { path, exists: true, data: JSON.parse(readFileSync(path, "utf-8")) as unknown };
	} catch (error) {
		return {
			path,
			exists: true,
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
}

function fileStatusLabel(state: JsonFileState): string {
	if (!state.exists) return "missing";
	if (state.parseError) return "invalid JSON";
	return "present";
}

function describeList(items: readonly string[], emptyText: string): void {
	if (items.length === 0) {
		console.log(`  - ${emptyText}`);
		return;
	}
	for (const item of items) {
		console.log(`  - ${item}`);
	}
}

function modelIdsForConfig(config: OpenAiCompatibleSetupConfig): string[] {
	const ordered = [config.primaryRoomModelId, ...config.additionalRoomModelIds, config.maintenanceModelId];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ordered) {
		const trimmed = id.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

function inspectSimpleProvider(provider: JsonObject, conflicts: string[]): void {
	const surprisingProviderKeys = Object.keys(provider).filter((key) => !SIMPLE_PROVIDER_KEYS.has(key));
	if (surprisingProviderKeys.length > 0) {
		conflicts.push(
			`${OPENAI_COMPATIBLE_PROVIDER_ID} has advanced provider config (${surprisingProviderKeys.join(", ")}) that setup should not overwrite automatically.`,
		);
	}

	if (provider.api !== undefined && provider.api !== OPENAI_COMPATIBLE_API) {
		conflicts.push(
			`${OPENAI_COMPATIBLE_PROVIDER_ID}.api already exists and differs from "${OPENAI_COMPATIBLE_API}".`,
		);
	}

	if (provider.models !== undefined && !Array.isArray(provider.models)) {
		conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID}.models must be an array.`);
		return;
	}

	if (!Array.isArray(provider.models)) return;
	for (const [index, model] of provider.models.entries()) {
		if (!isObject(model)) {
			conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID}.models[${index}] must be a JSON object.`);
			continue;
		}
		if (typeof model.id !== "string" || model.id.trim().length === 0) {
			conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID}.models[${index}].id must be a non-empty string.`);
		}
		if (model.name !== undefined && typeof model.name !== "string") {
			conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID}.models[${index}].name must be a string when present.`);
		}
		if (model.input !== undefined && (!Array.isArray(model.input) || model.input.some((value) => value !== "text" && value !== "image"))) {
			conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID}.models[${index}].input must list only "text" and "image" when present.`);
		}
		if (model.contextWindow !== undefined && (typeof model.contextWindow !== "number" || !(model.contextWindow > 0))) {
			conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID}.models[${index}].contextWindow must be a positive number when present.`);
		}
		const surprisingModelKeys = Object.keys(model).filter((key) => !SIMPLE_MODEL_KEYS.has(key));
		if (surprisingModelKeys.length > 0) {
			conflicts.push(
				`${OPENAI_COMPATIBLE_PROVIDER_ID}/${typeof model.id === "string" ? model.id : `models[${index}]`} has advanced model config (${surprisingModelKeys.join(", ")}).`,
			);
		}
	}
}

function getOpenAiCompatibleAppPolicyPath(): string {
	return join(homedir(), ".exxperts", "app", OPENAI_COMPATIBLE_POLICY_FILE_NAME);
}

function inspectAppPolicyConfig(state: JsonFileState, changes: string[], conflicts: string[]): void {
	if (!state.exists) {
		changes.push(`Create ${OPENAI_COMPATIBLE_POLICY_FILE_NAME} with product-approved OpenAI-compatible model policy.`);
		return;
	}
	if (state.parseError) {
		conflicts.push(`${OPENAI_COMPATIBLE_POLICY_FILE_NAME} is invalid JSON: ${state.parseError}`);
		return;
	}
	if (!isObject(state.data)) {
		conflicts.push(`${OPENAI_COMPATIBLE_POLICY_FILE_NAME} must contain a JSON object at the top level.`);
		return;
	}
	changes.push(`Update ${OPENAI_COMPATIBLE_POLICY_FILE_NAME} with the configured room and maintenance model policy.`);
}

function inspectModelsConfig(state: JsonFileState, config: OpenAiCompatibleSetupConfig, changes: string[], conflicts: string[]): void {
	if (!state.exists) {
		changes.push(`Create models.json with ${OPENAI_COMPATIBLE_PROVIDER_ID} runtime provider config.`);
		return;
	}
	if (state.parseError) {
		conflicts.push(`models.json is invalid JSON: ${state.parseError}`);
		return;
	}
	if (!isObject(state.data)) {
		conflicts.push("models.json must contain a JSON object at the top level.");
		return;
	}

	const providers = state.data.providers;
	if (providers === undefined) {
		changes.push(`Add a providers object containing ${OPENAI_COMPATIBLE_PROVIDER_ID}.`);
		return;
	}
	if (!isObject(providers)) {
		conflicts.push("models.json providers must be a JSON object.");
		return;
	}

	const provider = providers[OPENAI_COMPATIBLE_PROVIDER_ID];
	if (provider === undefined) {
		changes.push(`Add ${config.displayName} provider (${OPENAI_COMPATIBLE_PROVIDER_ID}) to models.json.`);
		return;
	}
	if (!isObject(provider)) {
		conflicts.push(`${OPENAI_COMPATIBLE_PROVIDER_ID} in models.json must be a JSON object.`);
		return;
	}

	inspectSimpleProvider(provider, conflicts);
	if (provider.name !== config.displayName) {
		changes.push(`Set ${OPENAI_COMPATIBLE_PROVIDER_ID}.name to "${config.displayName}".`);
	}
	if (provider.baseUrl !== config.baseUrl) {
		changes.push(`Set ${OPENAI_COMPATIBLE_PROVIDER_ID}.baseUrl to the configured gateway URL.`);
	}
	if (provider.api !== OPENAI_COMPATIBLE_API) {
		changes.push(`Set ${OPENAI_COMPATIBLE_PROVIDER_ID}.api to "${OPENAI_COMPATIBLE_API}".`);
	}

	const desiredModelIds = modelIdsForConfig(config);
	const existingModelIds = Array.isArray(provider.models)
		? provider.models
				.map((model) => (isObject(model) && typeof model.id === "string" ? model.id : undefined))
				.filter((id): id is string => Boolean(id))
		: [];
	if (JSON.stringify(existingModelIds) !== JSON.stringify(desiredModelIds)) {
		changes.push(`Set ${OPENAI_COMPATIBLE_PROVIDER_ID}.models to the configured model id list.`);
	}
}

export function normalizeOpenAiCompatibleSetupConfig(
	config: OpenAiCompatibleSetupConfig,
): OpenAiCompatibleSetupConfig {
	const displayName = config.displayName.trim() || OPENAI_COMPATIBLE_PROVIDER_LABEL;
	const baseUrl = config.baseUrl.trim();
	const primaryRoomModelId = config.primaryRoomModelId.trim();
	const maintenanceModelId = config.maintenanceModelId.trim() || primaryRoomModelId;
	const additionalRoomModelIds = config.additionalRoomModelIds.map((id) => id.trim()).filter(Boolean);

	return {
		displayName,
		baseUrl,
		primaryRoomModelId,
		additionalRoomModelIds,
		maintenanceModelId,
		...(config.modelCapabilities ? { modelCapabilities: config.modelCapabilities } : {}),
	};
}

// What models.json already says about each model's image support and context
// size. Read back so a wizard run that only changes the URL or the model list
// does not throw away facts it never asked about.
function existingModelCapabilities(state: JsonFileState): Record<string, OpenAiCompatibleModelCapabilities> {
	const capabilities: Record<string, OpenAiCompatibleModelCapabilities> = {};
	if (!isObject(state.data)) return capabilities;
	const providers = state.data.providers;
	if (!isObject(providers)) return capabilities;
	const provider = providers[OPENAI_COMPATIBLE_PROVIDER_ID];
	if (!isObject(provider) || !Array.isArray(provider.models)) return capabilities;
	for (const model of provider.models) {
		if (!isObject(model) || typeof model.id !== "string") continue;
		const entry: OpenAiCompatibleModelCapabilities = {};
		if (Array.isArray(model.input) && model.input.includes("image")) entry.vision = true;
		if (typeof model.contextWindow === "number" && model.contextWindow > 0) entry.contextWindow = model.contextWindow;
		if (entry.vision || entry.contextWindow) capabilities[model.id] = entry;
	}
	return capabilities;
}

export function buildOpenAiCompatibleSetupPlan(
	config: OpenAiCompatibleSetupConfig,
	paths: { agentDir?: string; modelsPath?: string; appPolicyPath?: string } = {},
): OpenAiCompatibleSetupPlan {
	const agentDir = paths.agentDir ?? getAgentDir();
	const modelsPath = paths.modelsPath ?? getModelsPath();
	const appPolicyPath = paths.appPolicyPath ?? getOpenAiCompatibleAppPolicyPath();
	const modelsState = readJsonFile(modelsPath);
	const normalizedConfig = normalizeOpenAiCompatibleSetupConfig({
		...config,
		modelCapabilities: config.modelCapabilities ?? existingModelCapabilities(modelsState),
	});
	const appPolicyState = readJsonFile(appPolicyPath);
	const changes: string[] = [];
	const conflicts: string[] = [];
	const warnings: string[] = [];

	if (!normalizedConfig.baseUrl) {
		conflicts.push("Gateway base URL is required.");
	}
	if (!normalizedConfig.primaryRoomModelId) {
		conflicts.push("Primary room model id is required.");
	}
	if (!normalizedConfig.maintenanceModelId) {
		conflicts.push("Maintenance model id is required.");
	}

	inspectModelsConfig(modelsState, normalizedConfig, changes, conflicts);
	inspectAppPolicyConfig(appPolicyState, changes, conflicts);

	if (modelsState.exists) {
		warnings.push("Existing models.json will be backed up before mutation.");
	}
	if (appPolicyState.exists) {
		warnings.push(`Existing ${OPENAI_COMPATIBLE_POLICY_FILE_NAME} will be backed up before mutation.`);
	}

	return { agentDir, modelsPath, appPolicyPath, modelsState, appPolicyState, config: normalizedConfig, changes, conflicts, warnings };
}

function makeTimestamp(): string {
	const date = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

function uniqueBackupPath(path: string, timestamp: string): string {
	const base = `${path}.bak-${timestamp}`;
	if (!existsSync(base)) return base;
	for (let index = 1; index < 1000; index++) {
		const candidate = `${base}-${index}`;
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not choose a backup path for ${path}`);
}

function chmodBestEffort(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Ignore chmod failures on filesystems that do not support POSIX modes.
	}
}

function ensureDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodBestEffort(path, 0o700);
}

function backupExistingFile(state: JsonFileState, timestamp: string): string | undefined {
	if (!state.exists) return undefined;
	const backupPath = uniqueBackupPath(state.path, timestamp);
	copyFileSync(state.path, backupPath);
	chmodBestEffort(backupPath, 0o600);
	return backupPath;
}

function writeJsonFile(path: string, data: unknown): void {
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	chmodBestEffort(tempPath, 0o600);
	renameSync(tempPath, path);
	chmodBestEffort(path, 0o600);
}

function canonicalModel(id: string, capabilities: OpenAiCompatibleModelCapabilities | undefined): JsonObject {
	const model: JsonObject = { id, name: id };
	// A gateway model is text-only unless someone says otherwise; saying so out
	// loud is what lets attached images reach it instead of being replaced by a
	// placeholder further down.
	if (capabilities?.vision) model.input = ["text", "image"];
	if (capabilities?.contextWindow && capabilities.contextWindow > 0) model.contextWindow = capabilities.contextWindow;
	return model;
}

function canonicalProvider(config: OpenAiCompatibleSetupConfig): JsonObject {
	return {
		name: config.displayName,
		baseUrl: config.baseUrl,
		api: OPENAI_COMPATIBLE_API,
		models: modelIdsForConfig(config).map((id) => canonicalModel(id, config.modelCapabilities?.[id])),
	};
}

function roomModelIdsForConfig(config: OpenAiCompatibleSetupConfig): string[] {
	const ordered = [config.primaryRoomModelId, ...config.additionalRoomModelIds];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ordered) {
		const trimmed = id.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

function canonicalAppPolicy(config: OpenAiCompatibleSetupConfig): JsonObject {
	return {
		profileId: OPENAI_COMPATIBLE_PROFILE_ID,
		providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
		label: config.displayName,
		roomModels: roomModelIdsForConfig(config).map((modelId) => ({ modelId, label: modelId })),
		maintenanceModel: config.maintenanceModelId,
	};
}

export function nextOpenAiCompatibleModelsJsonData(plan: OpenAiCompatibleSetupPlan): JsonObject {
	const root = isObject(plan.modelsState.data) ? { ...plan.modelsState.data } : {};
	const providers = isObject(root.providers) ? { ...root.providers } : {};
	providers[OPENAI_COMPATIBLE_PROVIDER_ID] = canonicalProvider(plan.config);
	root.providers = providers;
	return root;
}

export function nextOpenAiCompatibleAppPolicyData(plan: OpenAiCompatibleSetupPlan): JsonObject {
	return canonicalAppPolicy(plan.config);
}

export function writeOpenAiCompatibleSetupFiles(plan: OpenAiCompatibleSetupPlan): OpenAiCompatibleSetupWriteResult {
	if (plan.conflicts.length > 0) {
		throw new Error("OpenAI-compatible setup plan has conflicts; refusing to write files.");
	}

	ensureDirectory(plan.agentDir);
	ensureDirectory(dirname(plan.appPolicyPath));
	const timestamp = makeTimestamp();
	const backups = [backupExistingFile(plan.modelsState, timestamp), backupExistingFile(plan.appPolicyState, timestamp)].filter((path): path is string => Boolean(path));

	writeJsonFile(plan.modelsPath, nextOpenAiCompatibleModelsJsonData(plan));
	writeJsonFile(plan.appPolicyPath, nextOpenAiCompatibleAppPolicyData(plan));

	return {
		backups,
		updated: [plan.modelsPath, plan.appPolicyPath],
	};
}

function printSetupIntro(): void {
	console.log(chalk.bold("OpenAI-compatible gateway setup"));
	console.log("");
	console.log("This command stores non-secret gateway/model config in runtime models.json");
	console.log("and product-approved model policy in app state.");
	console.log("It does not ask for or store an API key. Add the key later with:");
	console.log(chalk.dim("  exxperts cli -> /login -> Use an API key -> OpenAI-compatible gateway"));
	console.log("");
}

function printSetupPlan(plan: OpenAiCompatibleSetupPlan): void {
	console.log(chalk.bold("Local files"));
	console.log(`  agent dir:          ${plan.agentDir}`);
	console.log(`  models.json:        ${plan.modelsPath} (${fileStatusLabel(plan.modelsState)})`);
	console.log(`  app policy:         ${plan.appPolicyPath} (${fileStatusLabel(plan.appPolicyState)})`);
	console.log(`  auth.json:          not read or written by this setup command`);
	console.log("");

	console.log(chalk.bold("Gateway config"));
	console.log(`  provider id:       ${OPENAI_COMPATIBLE_PROVIDER_ID}`);
	console.log(`  display name:      ${plan.config.displayName}`);
	console.log(`  base URL:          ${plan.config.baseUrl}`);
	console.log(`  primary model:     ${plan.config.primaryRoomModelId}`);
	console.log(`  additional models: ${plan.config.additionalRoomModelIds.length > 0 ? plan.config.additionalRoomModelIds.join(", ") : "none"}`);
	console.log(`  maintenance model: ${plan.config.maintenanceModelId}`);
	console.log("");

	if (plan.conflicts.length > 0) {
		console.log(chalk.bold.red("Conflicts"));
		describeList(plan.conflicts, "No conflicts detected.");
		console.log("");
		console.log("Setup cannot continue safely until these conflicts are resolved.");
		console.log(chalk.dim("No files were changed."));
		return;
	}

	console.log(chalk.bold("Planned changes"));
	describeList(plan.changes, "No config changes detected; setup will refresh the provider config after confirmation.");
	console.log("");
	console.log(chalk.bold("Backups"));
	describeList(plan.warnings, "No existing setup files need backup before writing.");
	console.log("");
}

async function promptYesNo(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`${question} [y/N] `);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

async function promptWithDefault(rl: Interface, question: string, defaultValue: string): Promise<string> {
	const answer = await rl.question(`${question} [${defaultValue}] `);
	return answer.trim() || defaultValue;
}

async function promptRequired(rl: Interface, question: string): Promise<string> {
	while (true) {
		const answer = (await rl.question(`${question} `)).trim();
		if (answer) return answer;
		console.log(chalk.yellow("Please enter a value."));
	}
}

async function collectSetupConfig(): Promise<OpenAiCompatibleSetupConfig> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const displayName = await promptWithDefault(rl, "Gateway display name", OPENAI_COMPATIBLE_PROVIDER_LABEL);
		const baseUrl = await promptRequired(rl, "Gateway base URL (example https://gateway.example.com/v1):");
		const primaryRoomModelId = await promptRequired(rl, "Primary room model id:");
		const additionalRaw = await rl.question("Additional room model ids (comma-separated, optional): ");
		const additionalRoomModelIds = additionalRaw
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		const maintenanceRaw = await rl.question(`Maintenance model id [${primaryRoomModelId.trim()}]: `);
		const maintenanceModelId = maintenanceRaw.trim() || primaryRoomModelId.trim();

		return normalizeOpenAiCompatibleSetupConfig({
			displayName,
			baseUrl,
			primaryRoomModelId,
			additionalRoomModelIds,
			maintenanceModelId,
		});
	} finally {
		rl.close();
	}
}

export async function runOpenAiCompatibleSetupPlanner(): Promise<void> {
	printSetupIntro();

	if (!process.stdin.isTTY) {
		console.log("Run this command in an interactive terminal to answer the non-secret setup prompts.");
		console.log(chalk.dim("No files were changed."));
		process.exitCode = 1;
		return;
	}

	let config: OpenAiCompatibleSetupConfig;
	try {
		config = await collectSetupConfig();
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		console.log(chalk.dim("No files were changed."));
		process.exitCode = 1;
		return;
	}

	const plan = buildOpenAiCompatibleSetupPlan(config);
	printSetupPlan(plan);

	if (plan.conflicts.length > 0) {
		process.exitCode = 1;
		return;
	}

	const confirmed = await promptYesNo("Continue and write runtime models.json plus local app policy?");
	if (!confirmed) {
		console.log("Cancelled.");
		console.log(chalk.dim("No files were changed."));
		return;
	}

	try {
		const result = writeOpenAiCompatibleSetupFiles(plan);
		console.log("");
		console.log(chalk.bold.green("OpenAI-compatible gateway setup complete."));
		console.log("");
		console.log(chalk.bold("Updated"));
		describeList(result.updated, "No files updated.");
		console.log("");
		console.log(chalk.bold("Backups"));
		describeList(result.backups, "No existing setup files needed backup.");
		console.log("");
		console.log("Next: add your API key with exxperts cli -> /login -> Use an API key -> OpenAI-compatible gateway.");
	} catch (error) {
		console.error(chalk.red(`Setup failed: ${error instanceof Error ? error.message : String(error)}`));
		console.log(chalk.dim("No API key was requested or written by this command."));
		process.exitCode = 1;
	}
}

function printSetupUsage(): void {
	console.log(`${chalk.bold("Usage:")}
  exxperts setup openai-compatible

Configure provider setup for exxperts on this computer.

Targets:
  openai-compatible  Configure non-secret OpenAI-compatible gateway/model config in models.json.

Repo/development equivalent:
  ./scripts/exxperts-cli setup openai-compatible
`);
}

export async function handleSetupCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "setup") {
		return false;
	}

	const target = args[1];
	const wantsHelp = target === undefined || target === "--help" || target === "-h" || args.includes("--help") || args.includes("-h");
	if (wantsHelp) {
		printSetupUsage();
		return true;
	}

	if (args.length > 2) {
		console.error(chalk.red(`Unexpected argument: ${args[2]}`));
		console.error(chalk.dim("Usage: exxperts setup openai-compatible"));
		process.exitCode = 1;
		return true;
	}

	if (target === "openai-compatible") {
		await runOpenAiCompatibleSetupPlanner();
		return true;
	}

	console.error(chalk.red(`Unknown setup target: ${target}`));
	console.error(chalk.dim("Usage: exxperts setup openai-compatible"));
	process.exitCode = 1;
	return true;
}
