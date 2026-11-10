import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "../lib/config.js";
import type { ImplContext, QuotaSource, QuotaSourceResult } from "../lib/types.js";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function timestamp(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

const impl: QuotaSource = {
	async getUsage(ctx: ImplContext): Promise<QuotaSourceResult> {
		let credential: Record<string, unknown> | undefined;
		try {
			const auth = record(JSON.parse(readFileSync(join(resolveAgentDir(), "auth.json"), "utf8").replace(/^\uFEFF/, "")));
			credential = record(auth?.["github-copilot"]);
		} catch {
			throw new Error("Copilot quota: could not read the current login.");
		}
		if (credential?.type !== "oauth" || typeof credential.refresh !== "string" || !credential.refresh.trim()) {
			throw new Error("Copilot quota: sign in with GitHub Copilot first.");
		}
		if (credential.enterpriseUrl) {
			throw new Error("Copilot quota: Enterprise logins are unsupported.");
		}
		let data;
		try {
			ctx.signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(10_000);
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
			const response = await fetch("https://api.github.com/copilot_internal/user", {
				method: "GET", redirect: "manual", signal,
				headers: {
					Authorization: `token ${credential.refresh}`,
					Accept: "application/json",
					"User-Agent": "my-pi-quota",
					"X-GitHub-Api-Version": "2025-04-01",
				},
			});
			if (!response.ok) throw new Error();
			data = record(await response.json());
			signal.throwIfAborted();
		} catch {
			throw new Error("Copilot quota: usage request failed.");
		}
		if (data?.token_based_billing !== true) {
			throw new Error("Copilot quota: AI-credit billing is required; legacy premium-request billing is unsupported.");
		}
		const buckets = record(data.quota_snapshots);
		const source = record(buckets?.premium_models ?? buckets?.premium_interactions);
		if (source?.unlimited === true) return { snapshots: [], modelLimitIds: {} };
		const total = typeof source?.entitlement === "string" ? Number(source.entitlement) : source?.entitlement;
		const remaining = source?.quota_remaining;
		const percent = source?.percent_remaining;
		if (source?.unlimited !== false || !finite(total) || total <= 0 ||
			(!finite(remaining) && !(remaining === undefined && finite(percent) && percent >= 0 && percent <= 100))) {
			throw new Error("Copilot quota: invalid AI-credit allowance.");
		}
		// Only quota_remaining shares entitlement's credit basis; other counters may be rounded or request-based.
		const used = finite(remaining) ? Math.max(0, total - remaining) : total * (1 - (percent as number) / 100);
		const now = Date.now();
		const asOf = Math.min(now, timestamp(source.timestamp_utc) ?? now);
		const at = new Date(asOf);
		const windowEnd = finite(source.quota_reset_at) && source.quota_reset_at > 0
			? source.quota_reset_at * 1000
			: timestamp(data.quota_reset_date_utc) ?? timestamp(data.quota_reset_date)
				?? Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
		const end = new Date(windowEnd);
		if (windowEnd !== Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)) {
			throw new Error("Copilot quota: non-calendar billing windows are unsupported.");
		}
		const windowStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1);
		if (asOf < windowStart || asOf >= windowEnd) throw new Error("Copilot quota: inconsistent reporting window.");
		return {
			snapshots: [{ label: "Copilot AI credits", spend: used * 0.01, quota: total * 0.01, windowStart, windowEnd, asOf }],
			modelLimitIds: {},
		};
	},
};

export default impl;
