// Every long-lived holder of state in the server's memory, with what a restart
// does to it. restart-holders-smoke.ts finds the holders in the source and fails
// on one missing here or a line whose holder has gone.
//
// - rebuilt at start: the start, or the first use after it, fills it again, and
//   nothing is lost.
// - cache: read again from files or asked again; only time is lost.
// - ends by design: it dies with the process, and `told` says what the person
//   then meets.
// - gap: a person needs what it held and a restart loses it. `meets` says what
//   they meet, and `knownCase` names its line in restart-known-cases.ts.

export type RestartHolder = { holder: string } & (
	| { fate: "rebuilt at start" | "cache"; why: string }
	| { fate: "ends by design"; told: string }
	| { fate: "gap"; meets: string; knownCase: string }
);

const TEST_SEAM = "Only a smoke changes it; every process starts from the same value.";
const ONCE_PER_PROCESS = "Says that a once-per-process step was done, and the new process does it again.";

export const RESTART_HOLDERS: RestartHolder[] = [
	{ holder: "absorb-run.ts:RUNS", fate: "ends by design", told: "The run's journal is on disk: at the next start Memorize shows the run as stopped by a restart and offers to go on, the cut page counted as restarted." },
	{ holder: "absorb-run.ts:applyFold", fate: "rebuilt at start", why: TEST_SEAM },
	{ holder: "absorb-run.ts:foldRetryPauseMs", fate: "rebuilt at start", why: TEST_SEAM },
	{ holder: "absorb-run.ts:rateLimitPauseOverrideMs", fate: "rebuilt at start", why: TEST_SEAM },
	{ holder: "absorb-run.ts:slotWaitLines", fate: "ends by design", told: "A running Memorize's wait line goes with its run, which then reads as stopped by a restart." },
	{ holder: "ai-models.ts:WEB_CHAT_MODEL_LABELS", fate: "rebuilt at start", why: "A table of labels, finished while the module loads." },
	{ holder: "ai-models.ts:providerDisplayNameCache", fate: "cache", why: "Display names, worked out again on first use." },
	{ holder: "forget-erase.ts:ERASED", fate: "ends by design", told: "It only reaches turns and jobs running on a forgotten conversation, and those end with the process; the start's sweep looks after what they wrote." },
	{ holder: "forget-erase.ts:SWEPT", fate: "rebuilt at start", why: ONCE_PER_PROCESS },
	{ holder: "forget-erase.ts:heldBack", fate: "rebuilt at start", why: "A room that held a file back is swept again at the next start, from what is on disk." },
	{ holder: "gateway-model-find.ts:reads", fate: "cache", why: "A gateway's model list, kept a minute and read again." },
	{ holder: "index.ts:bashApprovalGrant", fate: "ends by design", told: "The one-time grant for rooms that ran commands before the approval card waits for Windows' check, up to 20 s after a start; elsewhere it is given at once. A stop in that wait leaves the rooms it picked asking before each command, as a failed grant does: the step was marked done when it picked them, so that no later start grants a room whose commands were turned on since." },
	{ holder: "index.ts:gatewayDeclarationsRefreshHandle", fate: "rebuilt at start", why: "A loop's handle, made at start." },
	{ holder: "index.ts:schedulerExecutionLoopHandle", fate: "rebuilt at start", why: "A loop's handle, made at start." },
	{ holder: "index.ts:schedulerPreflightLoopHandle", fate: "rebuilt at start", why: "A loop's handle, made at start." },
	{ holder: "killed-turn-line.ts:LOOKED", fate: "rebuilt at start", why: ONCE_PER_PROCESS },
	{ holder: "mcp-admin.ts:pendingLogins", fate: "ends by design", told: "A connector login in flight ends; the connector reads as not signed in, and the person signs in again." },
	{ holder: "memorize-discussion-keep.ts:ASKS", fate: "ends by design", told: "The asks' requests die with the process; a page whose request was cut asks again under the same id." },
	{ holder: "memorize-discussion-keep.ts:CANCELLED_EARLY", fate: "ends by design", told: "Nothing to tell: a Cancel kept a minute for an ask still on its way, and that ask dies with the connection." },
	{ holder: "memorize-discussion-keep.ts:READING", fate: "ends by design", told: "A first read in flight dies with its requests; the page's cut request asks again, and the read starts over." },
	{ holder: "memorize-discussion-keep.ts:unnamedAsks", fate: "rebuilt at start", why: "A counter for ids inside one process." },
	{ holder: "memory-commit.ts:chains", fate: "ends by design", told: "A save still queued gets no answer, so the page says it did not save and the person saves again; a save already begun has its intent on disk and is finished at the start." },
	{ holder: "memory-commit.ts:settlers", fate: "rebuilt at start", why: "Each save's settler registers while its module loads." },
	{ holder: "memory-commit.ts:settling", fate: "rebuilt at start", why: "A guard against settling a room twice at once; no settle outlives the process." },
	{ holder: "memory-search-sources.ts:ROOM_CORPUS", fate: "cache", why: "A room's search corpus, built again from its files." },
	{ holder: "memory-search-sources.ts:TURNS_BY_FILE", fate: "cache", why: "A transcript's turns by file, size and time, read again." },
	{ holder: "memory-use.ts:PENDING", fate: "ends by design", told: "Nothing to tell: a stop writes these, and a kill loses a few seconds of use counts that only rank notes. The person was never told they were saved." },
	{ holder: "memory-use.ts:exitFlushRegistered", fate: "rebuilt at start", why: ONCE_PER_PROCESS },
	{ holder: "model-call-causes.ts:keyRefusals", fate: "cache", why: "After a restart the next call to the provider tells again." },
	{ holder: "model-call-causes.ts:keySavedAt", fate: "cache", why: "Only compared with keyRefusals, which a restart empties with it." },
	{ holder: "model-call-causes.ts:roomCallWaits", fate: "ends by design", told: "The wait line of a request that dies with the process; the page's request fails and it asks again." },
	{ holder: "persistent-agent-row-cache.ts:entries", fate: "cache", why: "A room list's rows, read again from each room's files." },
	{ holder: "persistent-agent-store.ts:persistentAgentActiveTurns", fate: "ends by design", told: "A running turn ends with the process. A clean stop lands its line; after a kill, the turn's file in the room folder, with the person's message, makes the room's next read land that message and the same line under the turn, once (killed-turn-line.ts)." },
	{ holder: "persistent-agent-threads.ts:acceptedAnswerCuts", fate: "ends by design", told: "Nothing to tell: the cut is written to the conversation at once, and after a restart a later save of the whole part still keeps it cut. The stopped-words-come-back probe holds that." },
	{ holder: "persistent-agent-turns.ts:lastUsedEstimates", fate: "cache", why: "A room's last-used estimate, worked out again from its files." },
	{ holder: "persistent-agent-turns.ts:rememberGenerations", fate: "ends by design", told: "The reading marker on disk makes the progress poll answer \"restarted\" with the parts read, and Remember offers to generate again." },
	{ holder: "persistent-room-protection.ts:turnedOff", fate: "rebuilt at start", why: "Each room's protection, read again from its protection.json at the next start; a change made behind the app's back counts only from then, by design." },
	{ holder: "persistent-room-specialist-registry.ts:rooms", fate: "ends by design", told: "Specialists are switched off, so no task runs; a task of an older room ends with the process and its turn." },
	{ holder: "room-files.ts:globRegExps", fate: "cache", why: "Compiled patterns." },
	{ holder: "persistent-room-workspace-tools.ts:ripgrepEnsurePromise", fate: "cache", why: "The search program's path, looked up again." },
	{ holder: "prompt-diagnostics-store.ts:manifestLimit", fate: "rebuilt at start", why: "Starts from its default." },
	{ holder: "prompt-diagnostics-store.ts:manifests", fate: "ends by design", told: "Nothing to tell: redacted diagnostics of recent prompts, kept in memory on purpose, and the next prompts fill them." },
	{ holder: "provider-auth.ts:pending", fate: "ends by design", told: "A sign-in in flight ends; the page reads no login pending, and the person signs in again." },
	{ holder: "remember-job.ts:jobs", fate: "ends by design", told: "The reading marker on disk makes the progress poll answer \"restarted\" with the parts read, and Remember offers to generate again." },
	{ holder: "remote-qr.ts:vendored", fate: "cache", why: "A loaded module, loaded again on first use." },
	{ holder: "request-checks.ts:enrollBeginLimiter", fate: "ends by design", told: "Nothing to tell: a one-minute rate window starts over, and no person's work is in it." },
	{ holder: "request-checks.ts:enrollStatusLimiter", fate: "ends by design", told: "Nothing to tell: a one-minute rate window starts over, and no person's work is in it." },
	{ holder: "request-checks.ts:registeredRouteInventory", fate: "rebuilt at start", why: "Every route adds itself while the server loads." },
	{ holder: "request-checks.ts:remoteAudit", fate: "rebuilt at start", why: "A logger with no state of its own." },
	{ holder: "request-checks.ts:remoteAuthFailureLimiter", fate: "ends by design", told: "Nothing to tell: a one-minute rate window starts over, and no person's work is in it." },
	{ holder: "request-checks.ts:remoteDevices", fate: "ends by design", told: "Enrolled devices are on disk and load at start; an open pairing code and a pending approval die, which fails safe, and the phone scans again." },
	{ holder: "request-checks.ts:remoteMode", fate: "rebuilt at start", why: "Reads its state file at start and opens the tunnel listener again." },
	{ holder: "request-checks.ts:remoteRoomExposure", fate: "rebuilt at start", why: "Loads the hidden rooms from its file at start." },
	{ holder: "request-checks.ts:tunnelSecurityHeadersCache", fate: "cache", why: "Headers built again for the listener's identity." },
	{ holder: "review-run.ts:RUNS", fate: "ends by design", told: "The run's journal is on disk: at the next start Review shows the run as stopped by a restart, and notes it had not tidied say \"The app restarted before these notes were tidied.\"" },
	{ holder: "review-run.ts:tidyRetryPauseMs", fate: "rebuilt at start", why: TEST_SEAM },
	{ holder: "review-run.ts:tidyWaitLines", fate: "ends by design", told: "A running tidy's wait line goes with its run, which then reads as stopped by a restart." },
	{ holder: "room-command-tool.ts:credentialVariables", fate: "rebuilt at start", why: "Names only, read again from models.json and auth.json; a name a file has dropped goes with the sessions that signed in with it." },
	{ holder: "room-live-sessions.ts:detachedCookingRooms", fate: "ends by design", told: "A turn nobody watched ends with the process, as any running turn does; the room opens as idle." },
	{ holder: "room-live-sessions.ts:detachedCookingTurnHandles", fate: "ends by design", told: "A turn nobody watched ends with the process, as any running turn does; the room opens as idle." },
	{ holder: "room-live-sessions.ts:persistentRoomLiveSessions", fate: "ends by design", told: "Open connections end with the process; the page reconnects and the room opens from its files." },
	{ holder: "room-live-sessions.ts:reattachBufferProbe", fate: "rebuilt at start", why: "Filled only for smokes, by a test switch." },
	{ holder: "room-routes.ts:openFolderWindows", fate: "ends by design", told: "The stop closes every folder window still open, and its request ends without a folder. A pick is saved only after its window answers, so nothing chosen is lost, and the person presses Choose folder again." },
	{ holder: "room-socket.ts:constitutionUpgradeOnOpenSaidFor", fate: "rebuilt at start", why: "A once-per-process log line, said again once." },
	{ holder: "searxng-setup.ts:current", fate: "ends by design", told: "A web search setup in flight stops; its status reads idle, and the person starts it again." },
	{ holder: "searxng-setup.ts:last", fate: "ends by design", told: "The last setup's status reads idle again, and a probe of the saved address says whether it runs." },
	{ holder: "server-hooks.ts:registered", fate: "rebuilt at start", why: "An edition's entry file fills it before the server loads." },
	{ holder: "server-stop.ts:installed", fate: "rebuilt at start", why: ONCE_PER_PROCESS },
	{ holder: "server-stop.ts:liveConnections", fate: "ends by design", told: "Connections end with the process; each hears the stop frame when there is a stop." },
	{ holder: "server-stop.ts:runningWork", fate: "ends by design", told: "The stop ends this work with its own line; a kill ends it as it ends a turn." },
	{ holder: "server-stop.ts:stopping", fate: "rebuilt at start", why: "False in every new process." },
	{ holder: "server-stop.ts:waitEndsAt", fate: "rebuilt at start", why: "Set by a stop, for that process only." },
	{ holder: "skills-repo-fetch.ts:checkoutCache", fate: "ends by design", told: "An import in progress answers that the repository checkout expired and asks for a new scan of the URL, and the person scans again." },
	{ holder: "skills-repo-fetch.ts:exitHookInstalled", fate: "rebuilt at start", why: ONCE_PER_PROCESS },
	{ holder: "skills-repo-fetch.ts:featuredCache", fate: "cache", why: "The featured sources, fetched again." },
	{ holder: "skills-repo-fetch.ts:lastDeveloperToolsRequest", fate: "rebuilt at start", why: "A pause between two requests for Apple's install window; a restart only allows one sooner." },
	{ holder: "usage-api.ts:modelGroupCache", fate: "cache", why: "Model names grouped for the Wallet, worked out again." },
];
