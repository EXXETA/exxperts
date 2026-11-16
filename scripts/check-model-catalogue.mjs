#!/usr/bin/env node
// Checks the built-in model catalogue (runtime/packages/ai/src/models.generated.ts)
// against models.dev, the source its generator reads first. A person signed in
// to a provider can pick only the rows the catalogue has, so a model that
// provider serves and the catalogue lacks is a model they cannot use. Run it
// before a release: it exits 1 while a model is missing and is not on SKIPS
// below, and the fix is `npm run generate-models` in runtime/packages/ai.
//
// It also lists the catalogue rows that models.dev marks deprecated or no
// longer lists. Those never fail the check: the generator keeps every row a
// room may use, and taking one out is a person's decision.
//
// Usage:
//   node scripts/check-model-catalogue.mjs
//   node scripts/check-model-catalogue.mjs --from <api.json> --catalogue <models.generated.ts>
//     (saved copies in place of models.dev and the committed catalogue, so a
//     test runs with no network)
//
// Exit codes: 0 nothing missing, 1 a model is missing, 2 a source could not be read.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30_000;
const PROVIDERS = ["anthropic", "openai", "google", "github-copilot"];

// "<provider>/<model id>": why the catalogue goes without it. A missing model
// on this list passes the check and is still printed.
const SKIPS = {};

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a file path`);
  return value;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    fail(`could not read ${file}: ${err.message}`);
  }
}

// The generator writes each provider as a line `\t"<provider>": {` and each of
// its rows as `\t\t"<id>": {`, with the names as JSON strings; nothing else in
// the file starts a line that way.
function readCatalogue(file) {
  const catalogue = new Map();
  let rows;
  for (const line of readText(file).split(/\r?\n/)) {
    const provider = /^\t("(?:[^"\\]|\\.)*"): \{$/.exec(line);
    if (provider) {
      rows = new Set();
      catalogue.set(JSON.parse(provider[1]), rows);
      continue;
    }
    const row = /^\t\t("(?:[^"\\]|\\.)*"): \{$/.exec(line);
    if (row && rows) rows.add(JSON.parse(row[1]));
  }
  if (catalogue.size === 0) fail(`${file} holds no catalogue rows`);
  return catalogue;
}

async function readModelsDev(file) {
  if (file) {
    try {
      return JSON.parse(readText(file));
    } catch (err) {
      fail(`${file} is not JSON: ${err.message}`);
    }
  }
  let res;
  try {
    res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    fail(`could not fetch ${MODELS_DEV_URL}: ${err.cause?.message ?? err.message}`);
  }
  if (!res.ok) fail(`${MODELS_DEV_URL} answered ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch (err) {
    fail(`${MODELS_DEV_URL} sent no readable JSON: ${err.message}`);
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogueFile =
  argValue("--catalogue") ?? path.join(repoRoot, "runtime", "packages", "ai", "src", "models.generated.ts");
const catalogue = readCatalogue(catalogueFile);
const upstream = await readModelsDev(argValue("--from"));

const missing = [];
const skipped = [];
const deprecated = [];
const unlisted = [];
for (const provider of PROVIDERS) {
  const models = upstream?.[provider]?.models;
  // An empty list is a source that failed, not a provider with nothing missing.
  if (!models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length === 0) {
    fail(`models.dev lists no models for ${provider}`);
  }
  const rows = catalogue.get(provider) ?? new Set();
  for (const [id, model] of Object.entries(models)) {
    if (model?.tool_call !== true || model.status === "deprecated" || rows.has(id)) continue;
    const key = `${provider}/${id}`;
    if (Object.hasOwn(SKIPS, key)) skipped.push(`${key}: ${SKIPS[key]}`);
    else missing.push(`${key} (${model.name ?? id})`);
  }
  for (const id of rows) {
    if (!Object.hasOwn(models, id)) unlisted.push(`${provider}/${id}`);
    else if (models[id]?.status === "deprecated") deprecated.push(`${provider}/${id}`);
  }
}

function list(title, items) {
  if (items.length === 0) return;
  console.log(`${title}:`);
  for (const item of items.sort()) console.log(`  - ${item}`);
}

list("Kept though models.dev marks it deprecated", deprecated);
list("Kept though models.dev no longer lists it", unlisted);
list("Missing but skipped", skipped);
if (missing.length > 0) {
  console.error(`The catalogue lacks ${missing.length} model(s) models.dev lists with tools:`);
  for (const item of missing.sort()) console.error(`  - ${item}`);
  console.error("Fix: run `npm run generate-models` in runtime/packages/ai, or add a skip with its reason to scripts/check-model-catalogue.mjs.");
  process.exit(1);
}
console.log(`The catalogue has every model models.dev lists with tools for ${PROVIDERS.join(", ")}.`);
