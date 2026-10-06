# Provider setup

Audience: users who need to connect a provider before using rooms, and anyone who wants to know which model a room runs on.

## Current setup model

There are two setup paths, depending on how the provider authenticates:

- **Subscription (OAuth) providers (Claude, ChatGPT Plus/Pro):** sign in directly from the web app's **AI setup** page. Each provider that is not connected yet shows a **Sign in** button; it opens the provider's login in a new browser tab, and the page updates when the sign-in completes. The CLI `/login` flow remains available as an alternative; both paths write to the same local credential store.
- **API-key providers, including OpenAI-compatible gateways:** set up in the web app: open **AI setup**, then **Add provider**, then **Add gateway**; give the gateway a name, enter its base URL and API key, load the models it routes, and approve the ones your rooms may use. You can save several gateways, for example a personal endpoint and a company one; each appears as its own row in AI setup, and its approved models join the model pickers. The terminal wizard (`exxperts setup openai-compatible`, with the API key entered through the CLI `/login` prompt) remains available for the first gateway.

In both cases:

- Credentials stay on your machine in the local runtime auth store (`~/.exxperts/agent/auth.json`), shared between the web app and the CLI.
- The web app's **AI setup** page shows every provider's status and room models, and the **Default models** (see [Which model a room uses](#which-model-a-room-uses)).
- Persistent-agent room state references provider/model identity only; provider credentials and transport details stay outside room memory/state.
- The `./scripts/exxperts-cli` repo wrapper used throughout this page is a bash script (macOS/Linux/Git Bash); on Windows PowerShell/cmd, run `node bin\exxperts-cli.cjs` with the same arguments instead.

## Current first-class providers

These are the providers the product approves for rooms, with the profile ids the app stores for them:

| Product profile | User-facing label | Runtime provider | Setup path |
| --- | --- | --- | --- |
| `chatgpt-codex` | ChatGPT Plus/Pro | `openai-codex` | In-app sign-in (or CLI `/login`). Requires an eligible ChatGPT Plus/Pro Codex subscription. |
| `anthropic` | Claude | `anthropic` | In-app sign-in (or CLI `/login`). Requires a Claude Pro/Max subscription. |
| `openai-compatible` | The name you gave your first gateway | `openai-compatible` | In-app **Add gateway**, or terminal setup + CLI `/login` API-key entry; bring-your-own gateway for advanced users/orgs. |
| `gateway-<name>` | The name you gave that gateway | `gateway-<name>` | In-app **Add gateway**. Every gateway after the first gets ids of its own so the first one's ids never move. |

Any other provider the runtime knows (Google Gemini, Groq, Mistral, DeepSeek, OpenRouter, xAI, and about 25 more) can be added from the web app: open **AI setup** and use **Add provider**, then sign in with a subscription where the provider offers one, or paste an API key. After signing in, approve the models that provider may use in rooms and pick its recommended memory model. Approval creates the provider's AI profile and puts its models in the pickers; without it, the provider is signed in but not usable in rooms.

## Which model a room uses

Every room has two model rows in **Room settings, Model**:

- **Conversation**: the model the room talks with. A new conversation starts on it, and so do the room's scheduled tasks.
- **Memory**: the model that does the room's memory work: Remember, Memorize and Review, and also its file and document tasks, Consult and Ask memory. Ask memory across several rooms runs on the Memory default.

Each row has one picker with the approved models grouped by provider. In the Memory picker, each provider's recommended memory model is marked **Recommended**.

A row without a model of its own reads **Default ·** and the model's name, and follows the **Default models** in **Settings, AI setup** (Conversation and Memory). Pick a model on the row to give the room its own. Rooms that existed before 0.14 keep the model they used; the defaults apply to new rooms and to every Memory row that has no model of its own.

A room never switches models on its own. If a row's model can no longer run (its provider signed out, or the model was removed), the row shows it struck through and the room waits: nothing runs on another model in its place. A new conversation, a scheduled run, Remember, Memorize, Review and the room's other memory work are refused with a sentence that names the model, its provider and the way out: sign in again in **Settings, AI setup**, or pick another model on the row. The same holds for a row that follows a default that can no longer run. So a work room on a company gateway never quietly continues on a personal subscription. Only on a first run, before any default is set, does the first signed-in provider's model serve, and it then becomes the default.

### Switching the open conversation

A conversation keeps the model it started on. Changing the Conversation row applies to your next conversation, and while a conversation is open the pane also offers **Switch the open conversation too**:

- The conversation continues on the new model, and a line "Continued on" with the model's name marks where it switched. The first answer after a switch reads the whole conversation again.
- If the conversation is too long for the new model, the switch is refused and says how much it needs and how much the model holds. Remember it and continue on the new model, or Forget it.
- The switch waits while the room is answering or remembering, and while the CLI or a scheduled task holds the room. The pane says which.

A conversation with no messages yet simply follows a new pick at its first message.

### Remember reads the whole conversation

Remember runs on the Memory row and reads the whole conversation: in one pass when it fits the model's window, and in parts when it does not. Very long tool outputs are shortened and counted on the proposal; nothing else is cut.

## ChatGPT Plus/Pro / Codex setup

Use this path for the current `chatgpt-codex` product profile.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `chatgpt-codex` |
| Web profile label | ChatGPT Plus/Pro |
| Runtime provider id | `openai-codex` |
| CLI/TUI OAuth option | ChatGPT Plus/Pro (Codex Subscription) |
| Primary approved persistent-room model | `openai-codex/gpt-5.5` |

Requirements:

- An installed Exxperts package, or a repo clone.
- A real ChatGPT Plus/Pro account with Codex/subscription entitlement.

### 1. Sign in from the web app (primary path)

Open the web app's **AI setup** page. On the **ChatGPT Plus/Pro** row, click **Sign in**. The provider's login opens in a new browser tab; complete it there. Back in Exxperts, the page updates automatically once the sign-in finishes (use **Cancel** on the row to abort a stuck attempt, then retry).

One sign-in can run at a time. If your browser blocks the login tab, allow pop-ups for the Exxperts page and retry.

Alternative (CLI `/login`): start the CLI/TUI (`exxperts cli`, `exxperts-cli`, or the repo wrapper `./scripts/exxperts-cli`), run `/login`, select `Use a subscription`, then `ChatGPT Plus/Pro (Codex Subscription)`, and complete the browser OAuth flow. If the CLI/TUI asks you to paste a redirect URL or code, paste it only into the CLI/TUI prompt. Both paths store credentials in the same local auth store.

Do not paste redirect URLs, auth codes, tokens, screenshots, or raw auth files into docs, issues, or chat. Provider OAuth labels and browser screens can change outside this repository.

### 2. Choose where its models run

When ChatGPT Plus/Pro shows as connected, its approved models appear in every model picker. Choose them in **AI setup** under **Default models**, or for one room in **Room settings, Model** (see [Which model a room uses](#which-model-a-room-uses)).

A provider that is not ready keeps its models out of the pickers, and its row says what is missing. To disconnect later, open the row's menu and use **Sign out**.

## Claude / Anthropic setup

Use this path for the current `anthropic` product profile.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `anthropic` |
| Web profile label | Claude |
| Runtime provider id | `anthropic` |
| CLI/TUI OAuth option | Anthropic (Claude Pro/Max) |
| Recommended approved persistent-room model | `anthropic/claude-opus-4-8` |

Requirements:

- An installed Exxperts package, or a repo clone.
- A real Claude Pro/Max account with Anthropic subscription/OAuth access.

### 1. Sign in from the web app (primary path)

Open the web app's **AI setup** page. On the **Claude** row, click **Sign in**. The provider's login opens in a new browser tab; complete it there. Back in Exxperts, the page updates automatically once the sign-in finishes (use **Cancel** on the row to abort a stuck attempt, then retry).

The sign-in flow uses a local callback on port `53692`; one sign-in can run at a time. If your browser blocks the login tab, allow pop-ups for the Exxperts page and retry.

Alternative (CLI `/login`): start the CLI/TUI (`exxperts cli`, `exxperts-cli`, or the repo wrapper `./scripts/exxperts-cli`), run `/login`, select `Use a subscription`, then `Anthropic (Claude Pro/Max)`, and complete the browser OAuth flow. If the CLI/TUI asks you to paste a redirect URL or code, paste it only into the CLI/TUI prompt. Both paths store credentials in the same local auth store.

Do not paste redirect URLs, auth codes, tokens, screenshots, or raw auth files into docs, issues, or chat. Anthropic/Claude OAuth labels, browser screens, and account entitlement behavior can change outside this repository.

> Note: Anthropic API-key setup exists in the embedded runtime, but this product profile is documented as a subscription/OAuth profile. API-key product setup is deferred.

### 2. Choose where its models run

When Claude shows as connected, its approved models appear in every model picker. Choose them in **AI setup** under **Default models**, or for one room in **Room settings, Model** (see [Which model a room uses](#which-model-a-room-uses)).

A provider that is not ready keeps its models out of the pickers, and its row says what is missing. To disconnect later, open the row's menu and use **Sign out**.

## OpenAI-compatible gateway setup

Use this path when you or your organization operate an OpenAI Chat Completions-compatible gateway, for example a LiteLLM deployment or another gateway that exposes a compatible `/v1/chat/completions` surface.

You can save as many gateways as you need. Each one has its own name, base URL, API key and approved models, and each appears as its own row in AI setup next to ChatGPT and Claude, and its approved models join the pickers the same way. A personal endpoint and a company gateway can sit side by side without one overwriting the other.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `openai-compatible` for the first gateway, `gateway-<name>` for each one after it |
| Web profile label | The name you gave the gateway |
| Runtime provider id | Same as the product profile id |
| Setup command | `exxperts setup openai-compatible` (first gateway only) |
| CLI/TUI API-key option | OpenAI-compatible gateway (first gateway only) |
| Transport/API mode | `openai-completions` |

The first gateway keeps the ids it has always had. Every room thread stores the provider and model it is locked to, so those ids are load-bearing: an existing setup carries over untouched and nothing needs re-approving. Gateways added afterwards get ids derived from the name you give them.

Requirements:

- A gateway base URL, for example `https://gateway.example.com/v1`.
- A real API key for that gateway.
- Non-confidential test prompts for validation.
- Terminal access, if you use the terminal wizard rather than the app.

Rooms call tools on every turn, so a model has to support function calling to be usable in one. A model that does not is not a good candidate to approve as a room model, however well it writes.

### Add a gateway in the web app

Open **AI setup**, then **Add provider**, then **Add gateway**. Give the gateway a name, enter its base URL and API key, and choose **Load models from gateway**. Exxperts calls the gateway's `/models` and shows what it routes, so you approve from a list instead of copying ids by hand. If your gateway does not publish a model list, **enter ids manually** takes exact ids instead.

Each model in the list carries four decisions:

- **Approve**: whether rooms may run on this model.
- **Supports images**: whether attached images are sent to the model. A model left unticked is registered as text-only, and an attached image is not sent to it. The room says so plainly rather than passing the image along silently.
- **Supports web search**: whether this model may search the web through the gateway's own search machinery. Ticking it makes Exxperts ask for provider-side search on every request to that model, so the model can look things up itself instead of only through the room's `web_search` tool. Leave it unticked unless the gateway really runs search for that model. A gateway that does not will do one of two things, and only one of them is loud: some reject that model's requests outright, others accept the request, ignore the field and answer without searching. Because the second failure is silent, confirm a newly ticked model with a question about something current before relying on it. The room's own `web_search` tool stays available either way, and the two coexist. Detection ticks this for you where a gateway declares it; otherwise it is yours to set. See [`web-search.md`](web-search.md) for the app's own search, which is a separate setting.
- **Context window**: the token budget Exxperts assumes for this model. It drives the room's context reading and decides when a conversation is compacted, so a wrong number here is felt as premature compaction or as a chip that never fills.

Below the list, pick the gateway's **Recommended memory model**: it is marked Recommended in the Memory picker for this gateway, and rooms still choose theirs in Room settings, Model. Save, and the gateway appears as a row in AI setup.

Model ids are exact strings supplied by your gateway and are often case-sensitive. If you are unsure whether the id is `gpt-5.5`, `GPT-5.5`, `gpt5.5`, or another alias, ask the gateway owner/admin or check the gateway's API/model documentation before approving it.

### What auto-detection fills in, and when it cannot

After loading the model list, Exxperts asks the gateway what it is willing to say about its own models and pre-fills the fields above from the answer. Nothing announces this; the values are simply there, and every field stays editable. Whatever you save is what counts.

Three shapes are understood:

- **LiteLLM `/model/info`**: per-model image support, web-search support, token limits, prices and whether the deployment supports prompt caching. The most complete answer, and the one that wins where sources disagree, because it describes the deployment rather than a catalogue entry.
- **LiteLLM `/models`**: a LiteLLM deployment also states `max_input_tokens` on its ordinary model rows, so context windows fill in from there even when the richer route is unavailable.
- **OpenRouter `/models`**: modality, `context_length` and prices on the model rows, which fills in image support, the context window and the price. Web search is only ever declared on LiteLLM's `/model/info`, so it stays yours to set here.

A gateway that publishes none of this is not a lesser gateway. The form opens on the defaults, a context window of 128000 shown rather than hidden, and you fill in what you know. Prices and caching have no field of their own: they come from detection only, and a price nobody published is shown in the Wallet as "no price on file", never as zero.

Detection is not a one-time trip. The server re-reads every saved gateway's declarations shortly after it starts and once a day, so prices, capabilities and effort levels that changed on the platform side show up without a visit to this panel. A gateway that cannot be reached or rejects its key is left exactly as it was, a field the gateway did not answer keeps its previous value, and your own overrides are never touched.

**Restricted virtual keys.** A LiteLLM virtual key is often scoped to the `llm_api_routes` group, which does not include the model info route. Such a key gets a `403` naming the allowed routes, and that is a correctly configured company gateway, not a broken one. Detection stays useful: context windows still fill in from `max_input_tokens` on the plain `/models` rows, while the images and web-search ticks are left to you and prices stay unknown (the Wallet shows "no price on file" for that gateway), since no shape available to that key carries them. If you want full detection, the gateway administrator can allow the model info route on virtual keys.

### Edit and remove a gateway

Every gateway's row on the **AI setup** page carries its own menu:

- **Approve models** changes the model set and the per-model fields. The address and key are untouched.
- **Edit gateway** owns the name, base URL and API key. Leaving the key field blank keeps the stored key as long as the address still names the same server; an address on a different host or port asks for the key again, so a stored key is never sent to a server it was not given to (correcting the path, say `/v1` to `/`, does not count). Gateway checks stop at the address you typed and do not follow redirects.
- **Remove gateway…** deletes that gateway's model catalog entry, its stored key, and its profile. Other gateways keep their models and stay signed in.

Removing a gateway is not reversible from inside the app, and it does not migrate rooms. A room row that named one of its models waits, and says so, until you pick another model on it, and a conversation running on one of them cannot continue there until you switch it to another model in Room settings, Model (or Remember or Forget it), so prefer editing a gateway over removing and re-adding one. A gateway added again later gets a new provider id even if you give it the same name, precisely so that rooms still pointing at the removed one do not silently re-attach to a different endpoint.

### Terminal setup for the first gateway

The terminal wizard remains available and manages the first gateway only. It and the app write the same files, so a gateway set up in the terminal is editable in the app and an edit made in the app is visible to the wizard. The wizard does not ask about image support, web search or context windows; it preserves whatever the app recorded rather than resetting it.

### 1. Configure non-secret gateway and model policy

Run the setup command in Terminal:

```bash
exxperts setup openai-compatible
```

For repo/branch validation, prefer:

```bash
./scripts/exxperts-cli setup openai-compatible
```

The setup command prompts only for non-secret values:

- gateway display name, default `OpenAI-compatible gateway`;
- gateway base URL;
- primary persistent-room model id or gateway alias;
- optional additional persistent-room model ids or gateway aliases;
- optional maintenance model id or gateway alias (the gateway's recommended memory model), defaulting to the primary model.

Model ids are exact strings supplied by your gateway. They are often case-sensitive, and Exxperts does not discover or validate them during setup. If you are unsure whether the id is `gpt-5.5`, `GPT-5.5`, `gpt5.5`, or another alias, ask the gateway owner/admin or check the gateway's API/model documentation before approving it for Exxperts.

It writes non-secret runtime transport/model config to:

```text
~/.exxperts/agent/models.json
```

It also writes the product-approved local process/model policy to:

```text
~/.exxperts/app/openai-compatible-ai-profile.json
```

It does **not** ask for, store, or print the API key.

### 2. Add the API key through `/login`

Start the CLI/TUI:

```bash
exxperts cli
```

For repo/branch validation:

```bash
./scripts/exxperts-cli
```

Inside the CLI/TUI, run:

```text
/login
```

Then select:

```text
Use an API key
```

Then select:

```text
OpenAI-compatible gateway
```

Paste the API key only into the CLI/TUI prompt. The key is stored in runtime auth state under `~/.exxperts/agent/auth.json`; do not paste it into docs, issues, pull requests, chat, screenshots, or `models.json`.

### 3. Check the gateway in AI setup

Return to the web app and open **AI setup**.

A gateway is readiness-gated. Its models reach the pickers only when all of these are true:

1. The gateway is described either by `~/.exxperts/app/openai-compatible-gateways.json` or, for the first gateway, by `~/.exxperts/app/openai-compatible-ai-profile.json`.
2. `~/.exxperts/agent/models.json` contains the gateway's provider entry and the mapped model ids.
3. Credentials are configured for that gateway's provider id through `/login`, the app, or another runtime-supported auth source.

When ready, the pickers offer only the room models approved for it.

### 4. Understand the local policy

The local app policy approves only the model ids you approved:

| Process | Mapping |
| --- | --- |
| Conversation row | Explicit `roomModels` for that gateway |
| Memory row (Remember, Memorize, Review, and the other memory work) | Any approved model; `maintenanceModel` is the gateway's recommended memory model |

A memory-only model is included in runtime `models.json` so memory work can use it, but it is not offered for conversation unless you also list it as a room model.

### 5. Gateway limitations and responsibilities

OpenAI-compatible gateway support means Exxperts can call a configured Chat Completions-compatible endpoint with model ids you approve locally. It does not mean Exxperts can guarantee every upstream model behavior.

You or your organization remain responsible for:

- upstream provider configuration, entitlements, billing, quotas, and rate limits;
- gateway logging, data retention, security posture, and access control;
- model aliases, availability, routing, failover, and context-window claims;
- tool/function-calling behavior, image support, streaming behavior, and system/developer role compatibility;
- prompt caching, TTL, reasoning/thinking controls, and related billing semantics;
- capability validation with non-confidential prompts before relying on a gateway for real work.

One of those the app does handle for you: a Claude model behind a gateway that declares prompt caching gets Anthropic cache markers on its prompt prefix automatically, so long conversations reuse it; nothing to configure, and the Wallet's "Caching saved" figure shows the effect.

The terminal setup command does not fetch `/models`, list available model ids, validate reachability, validate the API key, or automatically approve every model exposed by the gateway. The app's **Add gateway** and **Approve models** steps do fetch the model list and read whatever capabilities the gateway publishes, but neither approves anything on your behalf and neither validates that a model actually works. If a disposable validation room later fails with a non-secret error such as "model not found" or "unknown model", correct the model id in **Approve models**, or rerun the terminal setup with the exact id or alias expected by the gateway.

Capability values that were auto-detected are still the gateway's claims, not verified behavior. A model marked as supporting images may still refuse them upstream, and a declared context window may not match what the upstream provider enforces. Validate with non-confidential prompts before relying on either.

## Current ChatGPT/Codex process-model policy

The provider catalog may contain more `openai-codex` models than the product approves. Persistent-room workflows use the curated process/model policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`.

Current `chatgpt-codex` mapping:

| Process | Approved provider/model |
| --- | --- |
| Persistent-room conversation | `openai-codex/gpt-6-sol`, `openai-codex/gpt-6.1-sol`, `openai-codex/gpt-6-astra`, `openai-codex/gpt-6-luna`, `openai-codex/gpt-5.6-sol`, `openai-codex/gpt-5.6-terra`, `openai-codex/gpt-5.6-luna` |
| Memory row (Remember, Memorize, Review, and the other memory work) | Any approved model; recommended: `openai-codex/gpt-6-sol` |

`gpt-6-sol` is the default/recommended model. The list follows the order of OpenAI's Codex app.

The room list of these two providers is fixed by the release. Each room picks its Conversation and Memory models from it in Room settings, Model. A conversation keeps the model it started on even after a list change; new conversations start on the room's Conversation row.

## Current Claude/Anthropic process-model policy

The provider catalog may contain more `anthropic` models than the product approves. Persistent-room workflows use the curated process/model policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`.

Current `anthropic` mapping:

| Process | Approved provider/model |
| --- | --- |
| Persistent-room conversation | `anthropic/claude-opus-5-5`, `anthropic/claude-fable-5-1`, `anthropic/claude-sonnet-5-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4-5`, `anthropic/claude-opus-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-fable-5`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6` |
| Memory row (Remember, Memorize, Review, and the other memory work) | Any approved model; recommended: `anthropic/claude-opus-5-5` |

`claude-opus-5-5` is the default/recommended model. The list follows Anthropic's tier order, newest first inside a tier.

The room list of these two providers is fixed by the release. Each room picks its Conversation and Memory models from it in Room settings, Model. A conversation keeps the model it started on even after a list change; new conversations start on the room's Conversation row.

### Maintainer checklist for newly released provider models

Provider catalogs may contain models that Exxperts has not approved. Product AI profiles may list only models that the runtime registry can resolve. Updating npm packages is not necessarily what updates the registry; in this repo, the model generator fetches upstream model catalogs and writes `runtime/packages/ai/src/models.generated.ts`.

When adding a newly released provider model to an approved AI profile:

1. Run:

   ```bash
   npm run generate-models --workspace @exxeta/exxperts-ai
   ```

2. Inspect `runtime/packages/ai/src/models.generated.ts` and confirm the exact `provider/model` IDs generated for the target provider.
3. Only after the runtime registry contains the model, add it to the approved product AI profile policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`, limited to the process or processes explicitly approved.
4. Update display labels / curated model labels in `apps/web-server/src/index.ts` if the model should appear in UI.
5. Update docs/current mapping tables.
6. Run model-policy/status smokes.
7. Manually validate with an eligible account before claiming real-provider validation.

Do not add hand-written fallback entries unless upstream catalogs do not contain the model and the fallback metadata is explicitly approved.

## Privacy and no-secret rules

Do not paste or commit:

- API keys;
- OAuth access tokens or refresh tokens;
- redirect URLs or auth codes;
- browser cookies;
- raw `auth.json` contents;
- screenshots that include credentials or account-identifying details;
- unreviewed raw status endpoint output.

Current storage boundaries:

| Path | Purpose |
| --- | --- |
| `~/.exxperts/app/` | Product/app state: the Default models, saved gateway policy, and persistent rooms (each room's Conversation and Memory rows live in its `runtime/models.json`). |
| `~/.exxperts/agent/` | Embedded runtime provider/auth/model/settings/session state, including gateway `models.json` and runtime `auth.json`. |

Status endpoints and UI should be used for readiness checks, not for copying or sharing credential files.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| **Sign in** does nothing or the login tab never opens | Allow pop-ups for the Exxperts page and retry. Only one sign-in can run at a time; use **Cancel** on the provider row to clear a stuck attempt first. |
| In-app sign-in reports "Sign-in timed out" | The flow expires after 5 minutes. Retry from **AI setup**; if it keeps failing, try the CLI `/login` path and report a non-secret description. |
| ChatGPT Plus/Pro or Anthropic option is not visible in `/login` | Confirm you chose `Use a subscription`; provider labels may have changed; escalate with a non-secret description. |
| OpenAI-compatible gateway is not visible under `/login` → `Use an API key` | Run `exxperts setup openai-compatible` first so runtime `models.json` defines provider `openai-compatible`; restart the CLI/TUI if needed. |
| Gateway validation fails with `model not found`, `unknown model`, or similar | Confirm the exact model id/alias with the gateway owner/admin. Model ids can be case-sensitive. Correct it in **Approve models**, or rerun `exxperts setup openai-compatible` with the corrected id; do not paste raw gateway logs or keys. |
| A gateway model ignores an attached image | The model is registered as text-only. Tick **supports images** for it in **Approve models**, and confirm with the gateway owner/admin that the model really accepts image input. |
| A room compacts far too early, or its context reading never moves | The model's context window is wrong. Correct it per model in **Approve models**; auto-detection fills it in only where the gateway declares it. |
| Sign-in succeeds but the web still shows not connected | Close and reopen AI setup; restart the web app if needed; do not inspect or share raw credential files. |
| A provider's models are missing from the pickers | The readiness gate likely still sees missing auth, missing runtime model config, or missing/invalid local app policy. Reopen AI setup and read the provider row's status. |
| A conversation stops because its provider signed out | The room says which provider is signed out and keeps a **Reconnect**. Sign in again and the room continues by itself, or switch the conversation to another model in Room settings, Model. |
| Switching the open conversation is refused as too long | The new model's window cannot hold the conversation. Remember it and continue on the new model, or Forget it. |
| Status output appears to contain secrets | Stop and escalate before sharing screenshots/output. |

## Related docs

- [How Exxperts works](how-exxperts-works.md): where providers and each room's models fit in the architecture.
