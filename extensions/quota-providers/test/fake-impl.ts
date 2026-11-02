/**
 * Fake ProviderImplementation for integration tests.
 *
 * Reads all behavior from ctx.settings so tests can control it via the
 * quota-providers.json config block without any network calls.
 *
 * Imported by runner.mjs via jiti (TypeScript, no build step).
 */

import type { ProviderImplementation, ModelEntry, TokenResult, UsageSnapshot, ImplContext } from "../lib/types.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

function failSeamsIncludes(ctx: ImplContext, seam: string): boolean {
	const list = ctx.settings.failSeams;
	return Array.isArray(list) && list.includes(seam);
}

const fakeImpl: ProviderImplementation = {
	id: "fake",
	baseUrl: "https://fake.example.com",

	async discoverModels(ctx: ImplContext): Promise<ModelEntry[]> {
		if (failSeamsIncludes(ctx, "discover")) {
			throw new Error("fake: discoverModels seam failure (failSeams includes 'discover')");
		}
		return (ctx.settings.models as ModelEntry[]) ?? [];
	},

	async getToken(ctx: ImplContext): Promise<TokenResult> {
		if (failSeamsIncludes(ctx, "token")) {
			throw new Error("fake: getToken seam failure (failSeams includes 'token')");
		}

		const ttl =
			typeof ctx.settings.tokenTtlMs === "number" ? ctx.settings.tokenTtlMs : 3_600_000;

		const counterFile = ctx.settings.counterFile as string | undefined;
		if (counterFile) {
			let count = 0;
			if (existsSync(counterFile)) {
				try {
					const parsed = JSON.parse(readFileSync(counterFile, "utf-8"));
					if (typeof parsed?.count === "number") count = parsed.count;
				} catch {
					// Corrupt counter — start from 0.
				}
			}
			writeFileSync(counterFile, JSON.stringify({ count: count + 1 }), "utf-8");
		}

		return { token: "fake-token", expiresAt: Date.now() + ttl };
	},

	async getUsage(ctx: ImplContext): Promise<UsageSnapshot | UsageSnapshot[]> {
		if (typeof ctx.settings.usageCounterFile === "string") {
			appendFileSync(ctx.settings.usageCounterFile, "call\n");
		}
		const delayMs = ctx.settings.usageDelayMs;
		if (typeof delayMs === "number") {
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
		if (failSeamsIncludes(ctx, "usage") || !ctx.settings.usage) {
			throw Object.assign(new Error("fake: usage failure (credential=do-not-log)"), { code: ctx.settings.usageErrorCode });
		}
		return ctx.settings.usage as UsageSnapshot | UsageSnapshot[];
	},
};

export default fakeImpl;
