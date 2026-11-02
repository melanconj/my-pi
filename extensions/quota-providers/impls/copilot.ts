import { homedir } from "node:os";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { NativeProviderImplementation, UsageSnapshot } from "../lib/types.js";

type CopilotErrorCode = "not-authenticated" | "unauthorized" | "rate-limited" | "unavailable" | "invalid-response" | "unsupported-account" | "unsupported-billing";

class CopilotError extends Error {
	constructor(public readonly code: CopilotErrorCode) {
		super(code === "unsupported-billing"
			? "Copilot quota: AI-credit billing is required; legacy premium-request billing is unsupported."
			: code === "unsupported-account"
				? "Copilot quota: enterprise accounts or non-calendar quota windows are unsupported."
				: `Copilot quota: ${code}`);
	}
}

const ENDPOINT = "https://api.github.com/copilot_internal/user";
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const USD_PER_AI_CREDIT = 0.01;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return undefined;
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) return undefined;
	const date = value.slice(0, 10);
	if (new Date(Date.parse(date)).toISOString().slice(0, 10) !== date) return undefined;
	return ms;
}

/** Only compatible AI-credit quota fields participate in the dollar budget. */
export function parseCopilotUsage(raw: unknown, now = Date.now()): UsageSnapshot[] {
	const data = record(raw);
	if (!data) throw new CopilotError("invalid-response");
	if (data.token_based_billing !== true) throw new CopilotError("unsupported-billing");
	const snapshots = record(data.quota_snapshots);
	if (!snapshots) throw new CopilotError("invalid-response");
	const source = record(snapshots[Object.hasOwn(snapshots, "premium_models") ? "premium_models" : "premium_interactions"]);
	if (!source || typeof source.unlimited !== "boolean") throw new CopilotError("invalid-response");
	if (source.unlimited) return [];
	const entitlement = typeof source.entitlement === "string" && source.entitlement.trim()
		? Number(source.entitlement)
		: source.entitlement;
	if (!finite(entitlement) || entitlement <= 0) throw new CopilotError("invalid-response");
	const quota = entitlement * USD_PER_AI_CREDIT;
	let spend: number;
	if (source.quota_remaining !== undefined) {
		if (!finite(source.quota_remaining)) throw new CopilotError("invalid-response");
		// Same-basis subtraction includes negative balances; scale first to avoid overflow.
		spend = Math.max(0, quota - source.quota_remaining * USD_PER_AI_CREDIT);
	} else {
		if (!finite(source.percent_remaining) || source.percent_remaining < 0 || source.percent_remaining > 100) {
			throw new CopilotError("invalid-response");
		}
		spend = quota * ((100 - source.percent_remaining) / 100);
	}
	const asOf = Math.min(now, timestamp(source.timestamp_utc) ?? now);
	if (!finite(asOf) || asOf < 0) throw new CopilotError("invalid-response");
	const at = new Date(asOf);
	const categoryReset = finite(source.quota_reset_at) && source.quota_reset_at > 0 && source.quota_reset_at * 1000 <= 8.64e15
		? source.quota_reset_at * 1000
		: undefined;
	const windowEnd = categoryReset ?? timestamp(data.quota_reset_date_utc) ?? timestamp(data.quota_reset_date)
		?? Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
	const end = new Date(windowEnd);
	if (end.getUTCDate() !== 1 || end.getUTCHours() !== 0 || end.getUTCMinutes() !== 0 || end.getUTCSeconds() !== 0 || end.getUTCMilliseconds() !== 0) {
		throw new CopilotError("unsupported-account");
	}
	const windowStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1);
	if (asOf < windowStart || asOf >= windowEnd) throw new CopilotError("invalid-response");
	return [{ label: "Copilot AI credits", spend, quota, windowStart, windowEnd, asOf }];
}

async function readJson(response: Response): Promise<unknown> {
	const length = response.headers.get("content-length");
	if (length !== null && Number(length) > MAX_BODY_BYTES) {
		await response.body?.cancel();
		throw new CopilotError("invalid-response");
	}
	if (!response.body) throw new CopilotError("invalid-response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new CopilotError("invalid-response");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new CopilotError("invalid-response");
	}
}

const copilot: NativeProviderImplementation = {
	id: "github-copilot",
	name: "Copilot",
	nativeProviderId: "github-copilot",
	accounting: "provider",
	async getUsage(ctx) {
		try {
			ctx.signal?.throwIfAborted();
			const configuredPath = ctx.settings.authPath;
			if (configuredPath !== undefined && (typeof configuredPath !== "string" || !configuredPath.trim())) {
				throw new CopilotError("not-authenticated");
			}
			const authPath = typeof configuredPath === "string" && configuredPath.startsWith("~/")
				? join(homedir(), configuredPath.slice(2))
				: configuredPath as string | undefined;
			const credential = record(readStoredCredential("github-copilot", authPath));
			if (credential?.type !== "oauth" || typeof credential.refresh !== "string" || !credential.refresh.trim()) {
				throw new CopilotError("not-authenticated");
			}
			if (credential.enterpriseUrl !== undefined && credential.enterpriseUrl !== "") {
				throw new CopilotError("unsupported-account");
			}
			const signal = AbortSignal.any([
				AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				...(ctx.signal ? [ctx.signal] : []),
			]);
			const response = await fetch(ENDPOINT, {
				method: "GET",
				redirect: "manual",
				signal,
				headers: {
					Authorization: `token ${credential.refresh}`,
					Accept: "application/json",
					"User-Agent": "my-pi-quota",
					"X-GitHub-Api-Version": "2025-04-01",
				},
			});
			if (!response.ok) {
				await response.body?.cancel();
				const rateLimited = response.status === 429 || (response.status === 403 && (
					response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
				));
				throw new CopilotError(
					rateLimited ? "rate-limited"
						: response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable",
				);
			}
			const raw = await readJson(response);
			signal.throwIfAborted();
			return parseCopilotUsage(raw);
		} catch (error) {
			if (error instanceof CopilotError) throw error;
			throw new CopilotError("unavailable");
		}
	},
};

export default copilot;
