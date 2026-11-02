/**
 * Quota-aware Provider Extension
 *
 * Registers provider implementations declared in ~/.pi/agent/quota-providers.json.
 * Each implementation is an out-of-repo TypeScript module that satisfies
 * ProviderImplementation (lib/types.ts). Discovery and token fetch are delegated
 * to the out-of-band runner (runner.mjs) so neither blocks the extension-factory
 * path.
 */

import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { loadProvidersConfig, cachePaths, resolveAgentDir } from "./lib/config.js";
import type { CachePaths } from "./lib/config.js";
import {
	readModelsCache,
	groupModels,
	buildProviderConfig,
	buildExistingProvider,
	discoveryRefreshDue,
} from "./lib/registration.js";
import { guardStreamSimple, type ProviderStreamSimple } from "./lib/stream-guard.js";
import { mapRetryableErrors } from "./lib/retryable-errors.js";
import type { ProviderImplementation, QuotaPolicy } from "./lib/types.js";
import { appendLedgerEntry, readLedger } from "./lib/ledger.js";
import { readUsageSnapshot } from "./lib/snapshot.js";
import { readBypass, writeBypass, resolveRequestStore } from "./lib/bypass.js";
import { evaluateQuota, effectiveSpend, applicableSnapshots, firstHitSnapshot } from "./lib/quota.js";
import {
	getOrCreateSessionTreeStore,
	registerSessionIdTreeStore,
	unregisterSessionIdTreeStore,
} from "../subagents/scoped-store.js";
import type { SessionTreeStore } from "../../lib/session-tree-store.js";
import { decideBlock } from "./lib/enforce.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Module-level state — init-then-freeze; consumed by Steps 10–13.

export interface ProviderRecord {
	id: string;
	implPath: string;
	configPath: string;
	paths: CachePaths;
	policy: QuotaPolicy;
	hasUsageSeam: boolean;
	providerIds: string[];
	modelLimitIds: ReadonlyMap<string, string[]>;
}

type QuotaRecordFacts = Pick<ProviderRecord, "paths" | "policy" | "hasUsageSeam" | "modelLimitIds">;

/**
 * Evaluate every active limit that applies to the selected model. Returning
 * undefined means no applicable, usable window is cached yet.
 */
function evaluateProviderQuota(
	record: QuotaRecordFacts,
	store: SessionTreeStore | undefined,
	now = Date.now(),
	modelId?: string,
): ReturnType<typeof decideBlock> | undefined {
	if (!record.hasUsageSeam) return undefined;
	const cached = readUsageSnapshot(record.paths.usage);
	if (!cached) return undefined;

	const limitIds = modelId ? record.modelLimitIds.get(modelId) ?? [] : [];
	const snapshots = applicableSnapshots(cached.snapshots, limitIds, now)
		.sort((a, b) => a.windowEnd - b.windowEnd);
	if (snapshots.length === 0) return undefined;

	const ledger = readLedger(record.paths.ledger);
	const bypassActive = record.policy.bypassAllowed && store ? readBypass(store) : false;
	const decisions = snapshots.map((snapshot) => {
		const decision = decideBlock({
			verdict: evaluateQuota(snapshot, ledger, record.policy, now),
			policy: record.policy,
			bypassActive,
		});
		return decision.blocked && snapshot.label
			? { ...decision, message: `${snapshot.label}: ${decision.message}` }
			: decision;
	});
	return decisions.find((decision) => decision.blocked && decision.kind === "hard") ??
		decisions.find((decision) => decision.blocked) ??
		{ blocked: false };
}

// Helpers

function formatDollars(amount: number): string {
	// Whole dollars drop the cents — every character counts on mobile layouts.
	return `$${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
}

function formatShortDate(ms: number): string {
	return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Days ahead of/behind budget: one decimal below 10d (near-cap precision), whole beyond. */
function formatDaysAhead(days: number): string {
	const magnitude = Math.abs(days);
	const text = magnitude < 10
		? magnitude.toFixed(1).replace(/\.0$/, "")
		: String(Math.round(magnitude));
	return `${days < 0 ? "-" : "+"}${text}d`;
}

/**
 * Build the compact one-line footer for a single provider, or undefined when
 * there is nothing worth showing. Scoped to the active model's keys and
 * rendered for the single scope it will hit first — least remaining headroom,
 * ties to the latest reset. The tier name is omitted to keep the line short on
 * mobile layouts; expired windows are omitted until a background poll replaces
 * them.
 */
function buildFooterLine(
	record: ProviderRecord,
	now: number,
	store: SessionTreeStore,
	modelId?: string,
): string | undefined {
	if (!record.hasUsageSeam) return undefined;
	const cached = readUsageSnapshot(record.paths.usage);
	if (!cached) return undefined;
	const ledger = readLedger(record.paths.ledger);
	const bypassActive = record.policy.bypassAllowed && readBypass(store);
	const limitIds = modelId ? record.modelLimitIds.get(modelId) ?? [] : [];
	const snapshot = firstHitSnapshot(cached.snapshots, limitIds, ledger, now);
	if (!snapshot) return undefined;

	const verdict = evaluateQuota(snapshot, ledger, record.policy, now);
	const spend = effectiveSpend(snapshot, ledger);
	const delta = formatDaysAhead(verdict.daysAhead);
	const resetDate = formatShortDate(verdict.resetAt);

	// Hard cap takes precedence over bypass display — hard cap is never bypassable.
	let suffix = "";
	if (verdict.state === "hard-exceeded") suffix = " · HARD CAP";
	else if (bypassActive) suffix = " · bypassed";
	else if (verdict.state === "soft-exceeded") suffix = " · soft cap";

	return `quota: ${formatDollars(spend)}/${formatDollars(snapshot.quota)} ${delta}→${resetDate}${suffix}`;
}

/**
 * Push (or clear) the footer statusline, scoped to the active model's provider.
 * Pass the resolved record for the current provider, or null/undefined to clear
 * (e.g. the active model is on a provider with no quota tracking).
 */
export function refreshStatusline(
	record: ProviderRecord | null | undefined,
	ctx: ExtensionContext,
): void {
	if (!ctx.hasUI || typeof ctx.ui?.setStatus !== "function") return;
	const store = getOrCreateSessionTreeStore(ctx.sessionManager);
	const line = record ? buildFooterLine(record, Date.now(), store, ctx.model?.id) : undefined;
	ctx.ui.setStatus("quota-providers", line);
}

// Helpers

/** Fire-and-forget background discover; never blocks, never throws. */
function spawnRefreshDetached(args: string[]): void {
	try {
		const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// best-effort
	}
}

/** Load an implementation module via jiti (same mechanism as runner.mjs). */
async function loadImpl(modulePath: string): Promise<ProviderImplementation> {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	return jiti.import(modulePath) as Promise<ProviderImplementation>;
}

// Extension Entry Point

export default async function (pi: ExtensionAPI) {
	// Distinguish process cold start from /new or /reload within the same process.
	// jiti loads extensions with moduleCache:false, so module scope is wiped on
	// every factory re-run — a globalThis sentinel survives re-imports within one
	// process but is fresh in every new process.
	const SENTINEL = Symbol.for("quota-providers/process-seen");
	const g = globalThis as Record<symbol, unknown>;
	const firstRunInProcess = !g[SENTINEL];
	g[SENTINEL] = true;

	const { providers, warnings } = loadProvidersConfig();
	for (const w of warnings) console.warn(w);

	const agentDir = resolveAgentDir();
	const configPath = join(agentDir, "quota-providers.json");
	const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));
	const now = Date.now();

	// The provider stream guard resolves the bypass store per request from
	// `options.sessionId` (the only identity at the provider boundary — closures
	// here can serve other sessions because the model runtime is shared within a
	// host process). This captured store is the fallback for requests that carry
	// no session id; it is set during session_start/agent_start.
	let treeStore: SessionTreeStore | undefined;
	const records: ProviderRecord[] = [];
	const existingProviders = new Map<string, Provider>();

	for (const resolved of providers) {
		if (!resolved.enabled) continue;

		const { id, modulePath: implPath, policy } = resolved;
		const paths = cachePaths(agentDir, id);

		// Load the impl to get its top-level metadata (baseUrl, name, authHeader,
		// hasUsageSeam). The runner also loads it independently for each subcommand —
		// this is intentionally redundant: the factory needs the metadata synchronously
		// to call buildProviderConfig, and keeping impl loading out of the runner's
		// responsibility keeps both sides simple.
		let impl: ProviderImplementation;
		try {
			impl = await loadImpl(implPath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`quota-providers: skipping "${id}" — failed to load impl module: ${msg}`);
			continue;
		}

		if (!impl.discoverModels) {
			if (!impl.getUsage || existingProviders.has(impl.id)) {
				console.warn(`quota-providers: skipping "${id}" — usage-only providers require getUsage and a unique provider id`);
				continue;
			}
			const record: ProviderRecord = Object.freeze({
				id,
				implPath,
				configPath,
				paths,
				policy,
				hasUsageSeam: true,
				providerIds: [impl.id],
				modelLimitIds: new Map<string, string[]>(),
			});
			try {
				const provider = await buildExistingProvider(impl.id, (stream) => {
					const gated = guardStreamSimple(stream, (model, options) => {
						maybeRefreshUsage(record);
						return evaluateProviderQuota(
							record,
							resolveRequestStore(options?.sessionId, treeStore),
							Date.now(),
							model.id,
						);
					});
					return impl.isRetryableError ? mapRetryableErrors(gated, impl.isRetryableError) : gated;
				});
				pi.registerProvider(provider);
				existingProviders.set(impl.id, provider);
				records.push(record);
			} catch (err) {
				console.warn(`quota-providers: skipping "${id}" — ${err instanceof Error ? err.message : String(err)}`);
			}
			continue;
		}
		if (typeof impl.baseUrl !== "string" || !impl.getToken) {
			console.warn(`quota-providers: skipping "${id}" — discovered models require baseUrl and getToken`);
			continue;
		}

		let cache = readModelsCache(paths.models);

		if (!cache) {
			// Cold cache miss: block once to populate it, then read it back.
			try {
				execFileSync(
					process.execPath,
					[
						runnerPath,
						"discover",
						"--module",
						implPath,
						"--impl",
						id,
						"--config",
						configPath,
						"--cache",
						paths.models,
					],
					{ stdio: ["ignore", "ignore", "pipe"], timeout: 35_000 },
				);
			} catch (err) {
				const runnerStderr =
					(err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString()?.trim();
				const msg = err instanceof Error ? err.message : String(err);
				const detail = runnerStderr ? `\n  Runner output: ${runnerStderr}` : "";
				console.warn(`quota-providers: skipping "${id}" — discovery failed: ${msg}${detail}`);
				continue;
			}
			cache = readModelsCache(paths.models);
			if (!cache) {
				console.warn(`quota-providers: skipping "${id}" — discovery produced no cache`);
				continue;
			}
		} else {
			// Warm cache: maybe kick a detached background refresh for next time.
			//  - cold start: always, unless cache younger than the floor (absorbs
			//    bursts of process/subagent spawns).
			//  - /new or /reload: only when older than the TTL (don't spawn per /new).
			if (discoveryRefreshDue(cache.writtenAt, now, firstRunInProcess)) {
				spawnRefreshDetached([
					runnerPath,
					"discover",
					"--module",
					implPath,
					"--impl",
					id,
					"--config",
					configPath,
					"--cache",
					paths.models,
				]);
			}
		}

		const groups = groupModels(id, cache.models, impl.authHeader);
		const modelLimitIds = new Map<string, string[]>();
		for (const model of cache.models) {
			if (model.quotaLimitIds?.length) modelLimitIds.set(model.id, model.quotaLimitIds);
		}
		const hasUsageSeam = typeof impl.getUsage === "function";
		let providerRecord: ProviderRecord | undefined;

		// Single-quote escaping for /bin/sh -c — safe against $, backticks, and
		// embedded double quotes in paths. Replace ' with '\'' to embed a literal
		// single quote inside a single-quoted segment.
		const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}' `;
		// sq() adds a trailing space so each token is already separated.
		const apiKeyCmd = `!${sq(process.execPath)}${sq(runnerPath)}token --module ${sq(implPath)}--impl ${sq(id)}--config ${sq(configPath)}--cache ${sq(paths.token)}`.trimEnd();

		const implMeta = {
			id: impl.id,
			name: impl.name,
			baseUrl: impl.baseUrl,
			authHeader: impl.authHeader,
			headers: impl.headers,
		};

		const providerIds: string[] = [];
		for (const group of groups) {
			// The stream guard is the authoritative gate. It runs after session
			// orchestration has selected a provider but before that provider can issue
			// an HTTP request, including for triggerTurn/custom-message paths.

			// The retryable-error mapper sits outside the gate: only errors the impl
			// classifies as transient are rewritten into pi's retryable vocabulary.
			let streamSimple: ProviderStreamSimple | undefined;
			if (hasUsageSeam || impl.isRetryableError) {
				const apiStreamSimple: ProviderStreamSimple = (model, context, options) => {
					const apiProvider = getApiProvider(group.api);
					if (!apiProvider) {
						throw new Error(`No API provider registered for api: ${group.api}`);
					}
					return apiProvider.streamSimple(model, context, options);
				};
				const gated = hasUsageSeam
					? guardStreamSimple(apiStreamSimple, (model, options) => {
							if (providerRecord) maybeRefreshUsage(providerRecord);
							return evaluateProviderQuota(
								{ paths, policy, hasUsageSeam, modelLimitIds },
								resolveRequestStore(options?.sessionId, treeStore),
								Date.now(),
								model.id,
							);
						})
					: apiStreamSimple;
				streamSimple = impl.isRetryableError
					? mapRetryableErrors(gated, impl.isRetryableError)
					: gated;
			}
			pi.registerProvider(
				group.providerId,
				buildProviderConfig(implMeta, group, apiKeyCmd, streamSimple),
			);
			providerIds.push(group.providerId);
		}

		providerRecord = Object.freeze({
			id,
			implPath,
			configPath,
			paths,
			policy,
			hasUsageSeam,
			providerIds,
			modelLimitIds,
		});
		records.push(providerRecord);
	}

	const providerRecords = Object.freeze(records);

	// Build provider-id → record lookup used by event handlers.
	const providerIdToRecord = new Map<string, ProviderRecord>();
	for (const record of records) {
		for (const pid of record.providerIds) {
			providerIdToRecord.set(pid, record);
		}
	}

	/** Kick a detached usage-poll if cache is stale; best-effort. */
	function maybeRefreshUsage(record: ProviderRecord): void {
		if (!record.hasUsageSeam) return;
		const cached = readUsageSnapshot(record.paths.usage);
		const now = Date.now();
		// Force a refresh when any cached limit window has already reset, regardless
		// of snapshot age — stale windows must not linger below the poll floor.
		const windowEnded = cached
			? cached.snapshots.some((snapshot) => now >= snapshot.windowEnd)
			: false;
		const age = cached ? (now - cached.writtenAt) / 1000 : Infinity;
		if (!windowEnded && age < record.policy.maxPollSeconds) return;
		try {
			const child = spawn(process.execPath, [
				runnerPath, "usage",
				"--module", record.implPath,
				"--impl", record.id,
				"--config", configPath,
				"--cache", record.paths.usage,
				"--ledger", record.paths.ledger,
				"--max-poll-seconds", String(record.policy.maxPollSeconds),
			], { detached: true, stdio: "ignore" });
			child.unref();
		} catch { /* best-effort */ }
	}

	// The store is owned by the current root's AgentSessionRegistry. The
	// subagents extension associates child session managers with that same store
	// before their session_start hooks run. Independent roots get independent
	// stores even when they live in one Node process.
	//
	// The session id index is what the provider boundary resolves against, so
	// every session (roots and managed children) must register one.
	const sessionIdOf = (manager: object): string | undefined =>
		(manager as { getSessionId?: () => string }).getSessionId?.call(manager);

	function bindTreeStore(ctx: { sessionManager: object }): void {
		treeStore = getOrCreateSessionTreeStore(ctx.sessionManager);
		const sessionId = sessionIdOf(ctx.sessionManager);
		if (sessionId) registerSessionIdTreeStore(sessionId, treeStore);
	}

	pi.on("session_start", (_event, ctx) => {
		bindTreeStore(ctx);
		const record = providerIdToRecord.get(ctx.model?.provider ?? "");
		if (record) maybeRefreshUsage(record);
		refreshStatusline(record, ctx);
	});

	// A session_start handler from another extension can enqueue a triggerTurn
	// before this extension's session_start handler runs. Capture the tree store
	// again at the universal agent boundary so bypass state is available for that
	// first provider request too.
	pi.on("agent_start", (_event, ctx) => {
		if (!treeStore) treeStore = getOrCreateSessionTreeStore(ctx.sessionManager);
		const sessionId = sessionIdOf(ctx.sessionManager);
		if (sessionId) registerSessionIdTreeStore(sessionId, treeStore);
	});

	// Drop the session-id index entry when this session goes away; the tree
	// store itself is owned and disposed by the subagents extension.
	pi.on("session_shutdown", (_event, ctx) => {
		for (const [id, provider] of existingProviders) {
			if (ctx.modelRegistry.getRegisteredNativeProvider(id) === provider) pi.unregisterProvider(id);
		}
		existingProviders.clear();
		const sessionId = sessionIdOf(ctx.sessionManager);
		if (sessionId) unregisterSessionIdTreeStore(sessionId, treeStore);
	});

	// Retarget the footer to the newly-selected model's provider (or clear it when
	// that provider isn't quota-tracked).
	pi.on("model_select", (event, ctx) => {
		const record = providerIdToRecord.get(event.model.provider ?? "");
		if (record) maybeRefreshUsage(record);
		refreshStatusline(record, ctx);
	});

	// Append ledger entries after each assistant message and maybe refresh usage.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const record = providerIdToRecord.get(event.message.provider ?? "");
		if (!record) return;
		const quotaLimitIds = record.modelLimitIds.get(event.message.model);
		appendLedgerEntry(
			record.paths.ledger,
			{
				timestamp: event.message.timestamp,
				cost: event.message.usage?.cost?.total ?? 0,
				...(quotaLimitIds ? { quotaLimitIds } : {}),
			},
			`${record.paths.ledger}.lock`, // hold the ledger lock so cmdUsage prune can't clobber us
		);
		maybeRefreshUsage(record);
		refreshStatusline(providerIdToRecord.get(ctx.model?.provider ?? ""), ctx);
	});

	// Quota blocks surface as provider-stream errors: guardStreamSimple above
	// throws before the provider is invoked, so a blocked prompt fails like a
	// real provider error. Pi appends the submitted message to the session and
	// the failed turn keeps it visible. The block text carries no retriable
	// wording, so pi-ai's text classifier marks it non-retryable and fails fast
	// without auto-retry or a retry affordance.
	//
	// This handler only refreshes usage and the status line before the run.
	pi.on("input", (event, ctx) => {
		const record = providerIdToRecord.get(ctx.model?.provider ?? "");
		if (!record || !record.hasUsageSeam) return;
		maybeRefreshUsage(record);
		refreshStatusline(record, ctx);
	});

	// /quota command

	pi.registerCommand("quota", {
		description: "Show quota status or toggle bypass (/quota bypass [on|off])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts[0] === "bypass") {
				// bypass on / bypass off / bypass (toggle)
				const seamed = providerRecords.filter((r) => r.hasUsageSeam);
				if (seamed.length === 0) {
					ctx.ui.notify(
						"No providers with a usage seam configured — quota bypass is unavailable.",
						"warning",
					);
					return;
				}
				const allowed = seamed.filter((r) => r.policy.bypassAllowed);
				if (allowed.length === 0) {
					ctx.ui.notify(
						"Bypass is disabled for all managed providers (bypassAllowed: false in config).",
						"warning",
					);
					return;
				}

				const store = treeStore ?? getOrCreateSessionTreeStore(ctx.sessionManager);
				const subcommand = parts[1]; // "on", "off", or undefined (toggle)
				const shouldEnable =
					subcommand === "on" ? true : subcommand === "off" ? false : !readBypass(store);

				writeBypass(store, shouldEnable);
				const newState = shouldEnable;

				ctx.ui.notify(`Quota bypass turned ${newState ? "on" : "off"}.`);
				refreshStatusline(providerIdToRecord.get(ctx.model?.provider ?? ""), ctx);
				return;
			}

			// Status display (no args) — scoped to the active model's provider, surfaced
			// as the compact footer line rather than a multi-line notify wall.
			if (providerRecords.length === 0) {
				ctx.ui.notify("No quota providers configured.");
				return;
			}

			const record = providerIdToRecord.get(ctx.model?.provider ?? "");
			if (!record) {
				ctx.ui.notify("Current model's provider isn't quota-tracked.");
				return;
			}
			if (!record.hasUsageSeam) {
				ctx.ui.notify(`${record.id}: no usage seam — quota not tracked.`);
				return;
			}

			maybeRefreshUsage(record);
			const store = treeStore ?? getOrCreateSessionTreeStore(ctx.sessionManager);
			const line = buildFooterLine(record, Date.now(), store, ctx.model?.id);
			if (!line) {
				ctx.ui.notify(`${record.id}: no quota data yet.`);
				return;
			}
			refreshStatusline(record, ctx);
			ctx.ui.notify(line);
		},
	});
}
