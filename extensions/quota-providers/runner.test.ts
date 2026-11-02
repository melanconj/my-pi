/**
 * Integration tests for runner.mjs — exercises all four subcommands against
 * the fake ProviderImplementation.
 */

import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Paths

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "runner.mjs");
const FAKE_IMPL_PATH = join(__dirname, "test", "fake-impl.ts");

// Helpers

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "quota-runner-test-"));
}

interface ProviderSettings {
	models?: unknown[];
	tokenTtlMs?: number;
	usage?: unknown;
	failSeams?: string[];
	counterFile?: string;
	[key: string]: unknown;
}

function writeConfig(
	configPath: string,
	settings: ProviderSettings,
): void {
	const config = {
		providers: {
			fake: {
				module: FAKE_IMPL_PATH,
				enabled: true,
				...settings,
			},
		},
	};
	writeFileSync(configPath, JSON.stringify(config), "utf-8");
}

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runRunner(args: string[]): RunResult {
	const result = spawnSync(process.execPath, [RUNNER_PATH, ...args], {
		encoding: "utf-8",
		timeout: 30_000,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

// Tests

describe("runner.mjs — discover", () => {
	let tmpDir: string;
	let configPath: string;
	let cachePath: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		configPath = join(tmpDir, "quota-providers.json");
		cachePath = join(tmpDir, "models.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes models.json with writtenAt and models array", () => {
		const models = [
			{ id: "fake-model-1", modelName: "gpt-4o", api: "openai" },
			{ id: "fake-model-2", modelName: "claude-3-5-sonnet", api: "anthropic" },
		];
		writeConfig(configPath, { models });

		const result = runRunner([
			"discover",
			"--module", FAKE_IMPL_PATH,
			"--impl", "fake",
			"--config", configPath,
			"--cache", cachePath,
		]);

		expect(result.status).toBe(0);
		expect(existsSync(cachePath)).toBe(true);

		const written = JSON.parse(readFileSync(cachePath, "utf-8"));
		expect(typeof written.writtenAt).toBe("number");
		expect(written.writtenAt).toBeGreaterThan(0);
		expect(written.models).toEqual(models);
	});

	it("exits non-zero and writes to stderr when seam throws", () => {
		writeConfig(configPath, { models: [], failSeams: ["discover"] });

		const result = runRunner([
			"discover",
			"--module", FAKE_IMPL_PATH,
			"--impl", "fake",
			"--config", configPath,
			"--cache", cachePath,
		]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("discover");
		// Cache must not be written.
		expect(existsSync(cachePath)).toBe(false);
	});
});

describe("runner.mjs — token", () => {
	let tmpDir: string;
	let configPath: string;
	let cachePath: string;
	let counterFile: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		configPath = join(tmpDir, "quota-providers.json");
		cachePath = join(tmpDir, "token.json");
		counterFile = join(tmpDir, "counter.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function readCounter(): number {
		if (!existsSync(counterFile)) return 0;
		try {
			return JSON.parse(readFileSync(counterFile, "utf-8")).count ?? 0;
		} catch {
			return 0;
		}
	}

	function runToken(): RunResult {
		return runRunner([
			"token",
			"--module", FAKE_IMPL_PATH,
			"--impl", "fake",
			"--config", configPath,
			"--cache", cachePath,
		]);
	}

	it("cold miss — prints fake-token and writes cache, incrementing counter", () => {
		writeConfig(configPath, { counterFile });

		const result = runToken();

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("fake-token");
		expect(existsSync(cachePath)).toBe(true);
		expect(readCounter()).toBe(1);

		const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
		expect(typeof cache.accessToken).toBe("string");
		expect(cache.accessToken).toBe("fake-token");
		expect(typeof cache.softExpiresAt).toBe("number");
		expect(typeof cache.hardExpiresAt).toBe("number");
	});

	it("second call inside soft margin returns cached token without re-invoking seam", () => {
		writeConfig(configPath, { counterFile });

		// First call — cold miss.
		const first = runToken();
		expect(first.status).toBe(0);
		expect(readCounter()).toBe(1);

		// Second call — cache is fresh (1-hour TTL, both margins far in the future).
		const second = runToken();
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("fake-token");
		// Seam must NOT have been called again.
		expect(readCounter()).toBe(1);
	});

	it("hard-expired cache — re-invokes seam and returns fresh token", () => {
		writeConfig(configPath, { counterFile });

		// Write a fake cache with both margins in the past.
		const pastMs = Date.now() - 60_000;
		writeFileSync(
			cachePath,
			JSON.stringify({
				accessToken: "stale-token",
				softExpiresAt: pastMs - 10_000,
				hardExpiresAt: pastMs,
			}),
			"utf-8",
		);

		const result = runToken();

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("fake-token");
		// Seam was called once to refresh.
		expect(readCounter()).toBe(1);
	});
});

describe("runner.mjs — usage", () => {
	let tmpDir: string;
	let configPath: string;
	let cachePath: string;
	let ledgerPath: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		configPath = join(tmpDir, "quota-providers.json");
		cachePath = join(tmpDir, "usage.json");
		ledgerPath = join(tmpDir, "ledger.jsonl");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const snapshot = {
		spend: 10.5,
		quota: 100,
		windowStart: Date.now() - 86_400_000,
		windowEnd: Date.now() + 86_400_000,
		asOf: Date.now() - 5_000, // authoritative up to 5 s ago
	};

	function runUsage(maxPollSeconds = 300): RunResult {
		return runRunner([
			"usage",
			"--module", FAKE_IMPL_PATH,
			"--impl", "fake",
			"--config", configPath,
			"--cache", cachePath,
			"--ledger", ledgerPath,
			"--max-poll-seconds", String(maxPollSeconds),
		]);
	}

	it("writes snapshot to cache and prunes ledger entries <= asOf, keeping later ones", () => {
		writeConfig(configPath, { usage: snapshot });

		// Write a ledger with one old entry (before asOf) and one new one (after asOf).
		const oldEntry = JSON.stringify({ timestamp: snapshot.asOf - 1_000, cost: 0.05 });
		const newEntry = JSON.stringify({ timestamp: snapshot.asOf + 1_000, cost: 0.07 });
		writeFileSync(ledgerPath, `${oldEntry}\n${newEntry}\n`, "utf-8");

		const result = runUsage();
		expect(result.status).toBe(0);

		// Cache written.
		expect(existsSync(cachePath)).toBe(true);
		const written = JSON.parse(readFileSync(cachePath, "utf-8"));
		expect(typeof written.writtenAt).toBe("number");
		expect(written.snapshot).toMatchObject({ spend: snapshot.spend, quota: snapshot.quota });

		// Old ledger entry pruned; new entry kept.
		const ledger = readFileSync(ledgerPath, "utf-8");
		expect(ledger).not.toContain(oldEntry);
		expect(ledger).toContain(newEntry);
	});

	it("creates the usage cache directory without a prior discovery", () => {
		cachePath = join(tmpDir, "new-provider", "usage.json");
		ledgerPath = join(tmpDir, "new-provider", "ledger.jsonl");
		writeConfig(configPath, { usage: snapshot });
		const result = runUsage();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(readFileSync(cachePath, "utf-8")).snapshot).toMatchObject(snapshot);
	});

	it("second immediate usage run exits 0 without rewriting (stampede guard)", () => {
		writeConfig(configPath, { usage: snapshot });

		// First run — writes cache.
		const first = runUsage();
		expect(first.status).toBe(0);
		expect(existsSync(cachePath)).toBe(true);

		const firstWrittenAt = JSON.parse(readFileSync(cachePath, "utf-8")).writtenAt as number;

		// Second run immediately — cache is fresh, should exit 0 without rewriting.
		const second = runUsage(300);
		expect(second.status).toBe(0);

		const secondWrittenAt = JSON.parse(readFileSync(cachePath, "utf-8")).writtenAt as number;
		// writtenAt must be unchanged — the second run did not rewrite.
		expect(secondWrittenAt).toBe(firstWrittenAt);
	});
});
