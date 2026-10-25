// The one notice when the room's Memory model cannot be reached, or is too
// small for the room's memory, shared by Remember, Memorize and Review: one
// sentence in the product's words, and the
// real ways out (Try again, Choose another model, and Sign in when that is the
// cause). The provider's raw words never reach it; they go to the console.
// Also the calm line a busy model's wait shows, with the next try's time.

import { useState } from "react";
import { ApiRequestError } from "../api";
import type { CredentialKey } from "../../../web-server/src/model-not-offered";
import { clockTime, failureButtons, isGatewayFind, quotaCause, quotaOffersTryAgain, quotaWayOn, type GatewayFind, type QuotaWay } from "../turn-failure-line";
import { useRemoteClientContext } from "../remote-client-context";
import { canonicalModelName } from "../model-names";
import { ABSORB_CHOOSE_MODEL_LABEL, ABSORB_TRY_AGAIN_LABEL, memoryModelSignInLabel } from "../memory-v2-copy";

export type ModelNoticeDetail = "signed-out" | "quota" | "not-offered" | "not-on-account" | "region-or-plan" | "gateway-refused" | "gateway-not-found" | "not-answering" | "still-busy" | "too-small";

export interface ModelNotice {
	detail: ModelNoticeDetail;
	/** The sentence the notice leads with. */
	sentence: string;
	/** The provider to sign in to, when sign-in is the cause and it is known. */
	provider?: string;
	/** Signed out on a key connection: its key is missing, or saved and refused. */
	key?: CredentialKey;
	/** Out of quota: who can lift it, and a plan's reset when it is known. */
	quotaWay?: QuotaWay;
	/** The model as the app names it, for a sentence the page words itself. */
	modelName?: string;
	/** After a gateway's bare "not found": what its model list said. */
	gatewayFind?: GatewayFind;
}

/** The model's wait, as the server publishes it: busy, or not reached yet. */
export interface ModelWait {
	cause: "busy" | "unreached";
	detail: string;
	attempt: number;
	nextTryAt: string;
	/** An earlier wait already said the model is busy. */
	again?: boolean;
	/** For a server error: the provider as AI setup names it. */
	provider?: string;
}

/** The notice for a failed request, when the failure is the Memory model not being reachable; null for every other failure. */
export function modelNoticeFromError(error: unknown): ModelNotice | null {
	if (!(error instanceof ApiRequestError)) return null;
	const details = (error.details ?? {}) as { detail?: string; provider?: string; model?: string; label?: string; key?: CredentialKey; quotaWay?: QuotaWay; gatewayFind?: unknown };
	const key = details.key === "missing" || details.key === "refused" || details.key === "no-workspace" ? { key: details.key } : {};
	if (error.code === "model_unreachable" && isNoticeDetail(details.detail)) {
		console.warn("[exxperts] the Memory model could not be reached:", details.detail);
		const modelName = details.model ? canonicalModelName({ model: details.model, modelLabel: details.label, provider: details.provider }).name || details.model : undefined;
		return { detail: details.detail, sentence: error.message, ...(details.provider ? { provider: details.provider } : {}), ...key, ...(details.quotaWay ? { quotaWay: details.quotaWay } : {}), ...(modelName ? { modelName } : {}), ...(isGatewayFind(details.gatewayFind) ? { gatewayFind: details.gatewayFind } : {}) };
	}
	if (error.code === "provider_signed_out") return { detail: "signed-out", sentence: error.message, ...(details.provider ? { provider: details.provider } : {}), ...key };
	if (error.code === "room_model_unavailable") return { detail: "not-offered", sentence: error.message };
	// The Memory model's window no longer holds the room's memory: the way out is another model.
	if (error.code === "memory_model_too_small") return { detail: "too-small", sentence: error.message };
	return null;
}

/**
 * Whether Try again can work for this cause: signed out, no longer offered, not on the account, refused for the
 * region or plan, refused or not found by a gateway or too small meets the same refusal again, and so does a spent quota whose
 * way on is unknown, or a plan whose reset is unknown (`quotaOffersTryAgain`). A model its gateway lists may run on a later try.
 */
export function retryCanHelp(cause: string, quotaWay?: QuotaWay, gatewayFind?: GatewayFind): boolean {
	if (cause === "quota") return quotaWay !== undefined && quotaOffersTryAgain(quotaWay);
	if (cause === "gateway-not-found") return gatewayFind === "model-listed";
	return cause !== "signed-out" && cause !== "not-offered" && cause !== "not-on-account" && cause !== "region-or-plan" && cause !== "gateway-refused" && cause !== "gateway-not-found" && cause !== "too-small";
}

/**
 * The ways on a memory screen offers for its Memory model's stop, decided here
 * once so the screens never drift. The key's button where a sign-in or key is
 * gone, or for a gateway's bare 403, which may be its key, and AI setup's for
 * a gateway's bare 404: as in the chat, on a shared server the gateway is the
 * admin's, so no button offers it. Try again
 * where it can help, and again once the person took another way, so the way
 * that worked leads on. Choose another model leads where neither of the others
 * is offered, or where `chooseFirst` says so, as after the same failure twice.
 */
export function useMemoryWaysOn<P>(cause: string | undefined, quotaWay: QuotaWay | undefined, ways: { onTryAgain?: () => void; onChooseModel?: () => void; onSignIn?: (provider: P) => void; provider: P; chooseFirst?: boolean; gatewayFind?: GatewayFind }) {
	const [wayTaken, setWayTaken] = useState(false);
	const { sharedServer } = useRemoteClientContext();
	const took = (action?: () => void) => action && (() => { setWayTaken(true); action(); });
	const { onSignIn, provider } = ways;
	const gatewayButtons = failureButtons(cause === "gateway-refused" || cause === "gateway-not-found" ? cause : undefined, undefined, sharedServer, ways.gatewayFind);
	const keyButton = cause === "signed-out" || gatewayButtons.replaceKey || gatewayButtons.aiSetup;
	const signIn = keyButton && onSignIn ? took(() => onSignIn(provider)) : undefined;
	const chooseModel = took(ways.onChooseModel);
	const tryAgain = !cause || retryCanHelp(cause, quotaWay, ways.gatewayFind) || wayTaken ? ways.onTryAgain : undefined;
	return { signIn, tryAgain, chooseModel, chooseLeads: Boolean(chooseModel) && !signIn && (Boolean(ways.chooseFirst) || !tryAgain) };
}

/**
 * The ways-on buttons, in the order every memory screen shows them. In a
 * notice the key's button alone is the main one; in a card's own row (`row`)
 * the way that leads is. A restart says nothing about the model: it answered,
 * so Continue is the one way on.
 */
export function MemoryWaysOnButtons({ ways, cause, credentialKey, row, busy }: { ways: ReturnType<typeof useMemoryWaysOn>; cause: string | undefined; credentialKey?: CredentialKey; row?: boolean; busy?: boolean }) {
	const { signIn, tryAgain, chooseModel, chooseLeads } = ways;
	const choose = chooseModel && cause !== "restarted" && <button type="button" className={`rs-btn${row && chooseLeads ? " rs-btn-primary" : ""}`} disabled={busy} onClick={chooseModel}>{ABSORB_CHOOSE_MODEL_LABEL}</button>;
	const again = tryAgain && <button type="button" className={`rs-btn${row && !signIn && !chooseLeads ? " rs-btn-primary" : ""}`} disabled={busy} onClick={tryAgain}>{cause === "restarted" ? "Continue" : ABSORB_TRY_AGAIN_LABEL}</button>;
	return (
		<>
			{signIn && <button type="button" className="rs-btn rs-btn-primary" disabled={busy} onClick={signIn}>{cause === "gateway-not-found" ? "Open AI setup" : memoryModelSignInLabel(credentialKey)}</button>}
			{row ? choose : again}
			{row ? again : choose}
		</>
	);
}

/** The sentence the notice leads with. A quota's is worded here from its way on, as the cards word it: a plan's reset in the viewer's clock, counted at each render. */
export function modelNoticeSentence(notice: ModelNotice): string {
	if (notice.detail !== "quota" || !notice.quotaWay || !notice.modelName) return notice.sentence;
	const wayOn = quotaWayOn(notice.quotaWay);
	return `${notice.modelName} ${quotaCause(notice.quotaWay)}. Nothing was lost.${wayOn ? ` ${wayOn}` : ""}`;
}

function isNoticeDetail(value: unknown): value is ModelNoticeDetail {
	return value === "signed-out" || value === "quota" || value === "not-offered" || value === "not-on-account" || value === "region-or-plan" || value === "gateway-refused" || value === "gateway-not-found" || value === "not-answering" || value === "still-busy";
}

/**
 * The line a model's wait shows (draft wording). It changes on every try:
 * a first call that could not connect says so, a dropped connection says so,
 * a busy model's first wait names the wait, every later one says it is still
 * busy, and each names the time of the next try.
 */
export function modelWaitLine(wait: ModelWait): string {
	const at = clockTime(wait.nextTryAt);
	if (wait.cause === "unreached") return `Can't reach the Memory model right now. Trying again at ${at}.`;
	if (wait.detail === "stalled" || wait.detail === "timed-out") return `The answer stopped coming. Asking again at ${at}.`;
	if (wait.detail === "connection") return `The connection to the Memory model dropped. Trying again at ${at}.`;
	if (wait.detail === "server-error" && wait.provider) return `${wait.provider} has a problem on its side. Trying again at ${at}.`;
	if (!wait.again) return `The Memory model is busy. Trying again at ${at}.`;
	return `Still busy. Trying again at ${at}.`;
}

export function ModelNoticePanel({ notice, kept, onTryAgain, onChooseModel, onSignIn, onClose, busy }: {
	notice: ModelNotice;
	/** What is kept, in one short sentence, when there is something to say. */
	kept?: string | null;
	onTryAgain?: () => void;
	onChooseModel?: () => void;
	/** Shown only when sign-in is the cause. */
	onSignIn?: (provider: string | undefined) => void;
	/** Where the notice stands alone in a dialog, Close is one of its ways out. */
	onClose?: () => void;
	busy?: boolean;
}) {
	const ways = useMemoryWaysOn(notice.detail, notice.quotaWay, { onTryAgain, onChooseModel, onSignIn, provider: notice.provider, gatewayFind: notice.gatewayFind });
	return (
		<div className="memory-action-note model-notice" role="status">
			<p>{modelNoticeSentence(notice)}{kept ? ` ${kept}` : ""}</p>
			<div className="absorb-run-note-actions">
				<MemoryWaysOnButtons ways={ways} cause={notice.detail} credentialKey={notice.key} busy={busy} />
				{onClose && <button type="button" className="rs-btn" onClick={onClose}>Close</button>}
			</div>
		</div>
	);
}
