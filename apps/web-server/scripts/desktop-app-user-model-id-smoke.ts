// Windows drops the desktop app's notifications unless its AppUserModelID
// equals electron-builder's appId; the two live in different files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
const builderConfig = fs.readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
const mainSource = fs.readFileSync(path.join(desktopDir, "src", "main.ts"), "utf8");

const appIds = [...builderConfig.matchAll(/^appId:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)].map((match) => match[1]);
assert(appIds.length === 1, `electron-builder.yml should set appId once at the top level, found ${appIds.length}`);
const modelIds = [...mainSource.matchAll(/setAppUserModelId\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((match) => match[1]);
assert(modelIds.length === 1, `main.ts should call setAppUserModelId once with a literal id, found ${modelIds.length}`);
assert(modelIds[0] === appIds[0], `the AppUserModelID (${modelIds[0]}) must equal electron-builder's appId (${appIds[0]})`);

console.log("desktop app user model id smoke ok");
