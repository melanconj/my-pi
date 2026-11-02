import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaPolicy } from "./types.js";

// Policy keys — reserved in each provider config block.
// Everything else passes through as ImplContext.settings.

export const POLICY_KEYS = [
	"module",
	"enabled",
	"bypassAllowed",
	"lookaheadHours",
	"maxPollSeconds",
	"enforceHardCap",
] as const;

// Types

export interface ResolvedProvider {
	id: string;
	modulePath: string;
	enabled: boolean;
	policy: QuotaPolicy;
	settings: Record<string, unknown>;
}

// Pure parsing

const POLICY_DEFAULTS: QuotaPolicy = {
	bypassAllowed: true,
	lookaheadHours: 6,
	maxPollSeconds: 300,
	enforceHardCap: false,
};

/**
 * Parse raw JSON from a quota-providers.json file into resolved providers.
 * Pure: all I/O is via the `expandHome` callback.
 * Malformed entries are dropped and described in `warnings`.
 */
export function parseProvidersConfig(
	raw: string,
	expandHome: (p: string) => string,
): { providers: ResolvedProvider[]; warnings: string[] } {
	const warnings: string[] = [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`quota-providers: failed to parse config JSON: ${msg}`);
		return { providers: [], warnings };
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as Record<string, unknown>).providers !== "object" ||
		(parsed as Record<string, unknown>).providers === null ||
		Array.isArray((parsed as Record<string, unknown>).providers)
	) {
		warnings.push('quota-providers: config must have a "providers" object at top level');
		return { providers: [], warnings };
	}

	const rawProviders = (parsed as Record<string, unknown>).providers as Record<string, unknown>;
	const providers: ResolvedProvider[] = [];

	for (const [id, block] of Object.entries(rawProviders)) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) {
			warnings.push(`quota-providers: provider "${id}" is not an object — skipping`);
			continue;
		}

		const entry = block as Record<string, unknown>;

		if (typeof entry.module !== "string" || entry.module === "") {
			warnings.push(
				`quota-providers: provider "${id}" has missing or non-string "module" — skipping`,
			);
			continue;
		}

		const modulePath = expandHome(entry.module);

		const enabled = entry.enabled !== false;

		const policy: QuotaPolicy = {
			bypassAllowed:
				typeof entry.bypassAllowed === "boolean"
					? entry.bypassAllowed
					: POLICY_DEFAULTS.bypassAllowed,
			lookaheadHours:
				typeof entry.lookaheadHours === "number"
					? entry.lookaheadHours
					: POLICY_DEFAULTS.lookaheadHours,
			maxPollSeconds:
				typeof entry.maxPollSeconds === "number"
					? entry.maxPollSeconds
					: POLICY_DEFAULTS.maxPollSeconds,
			enforceHardCap:
				typeof entry.enforceHardCap === "boolean"
					? entry.enforceHardCap
					: POLICY_DEFAULTS.enforceHardCap,
		};

		// Everything not in POLICY_KEYS passes through as settings.
		const policyKeySet = new Set<string>(POLICY_KEYS);
		const settings: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(entry)) {
			if (!policyKeySet.has(k)) {
				settings[k] = v;
			}
		}

		providers.push({ id, modulePath, enabled, policy, settings });
	}

	return { providers, warnings };
}

// I/O shell

/**
 * Resolve the pi agent directory, mirroring azure-foundry's resolveAgentDir().
 * Honors PI_CODING_AGENT_DIR (with ~ expansion); falls back to ~/.pi/agent.
 */
export function resolveAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
	return join(homedir(), ".pi", "agent");
}

function expandHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Load the quota-providers config from disk.
 * Missing file → empty providers, no warning (graceful degradation).
 */
export function loadProvidersConfig(path?: string): {
	providers: ResolvedProvider[];
	warnings: string[];
} {
	const agentDir = resolveAgentDir();
	const configPath = path ?? join(agentDir, "quota-providers.json");

	if (!existsSync(configPath)) {
		return { providers: [], warnings: [] };
	}

	const raw = readFileSync(configPath, "utf-8");
	return parseProvidersConfig(raw, expandHome);
}

// Cache path layout

export interface CachePaths {
	dir: string;
	models: string;
	token: string;
	usage: string;
	ledger: string;
}

/**
 * Pure: returns all cache paths for a given implementation under
 * `<agentDir>/cache/quota-providers/<implId>/`.
 */
export function cachePaths(agentDir: string, implId: string): CachePaths {
	const dir = join(agentDir, "cache", "quota-providers", implId);
	return {
		dir,
		models: join(dir, "models.json"),
		token: join(dir, "token.json"),
		usage: join(dir, "usage.json"),
		ledger: join(dir, "ledger.jsonl"),
	};
}
