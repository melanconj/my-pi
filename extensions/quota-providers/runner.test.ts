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
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Paths

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "runner.mjs");
const FAKE_IMPL_PATH = join(__dirname, "test", "fake-impl.ts");
const FAKE_NATIVE_IMPL_PATH = join(__dirname, "test", "fake-native-impl.ts");

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
		asOf: Date.now() - 5_000,
	};
	function usageArgs(modulePath = FAKE_IMPL_PATH): string[] {
		return [
			"usage", "--module", modulePath, "--impl", "fake", "--config", configPath,
			"--cache", cachePath, "--ledger", ledgerPath, "--max-poll-seconds", "300",
		];
	}
	function runUsage(modulePath = FAKE_IMPL_PATH): RunResult {
		return runRunner(usageArgs(modulePath));
	}

	it("writes snapshot to cache and prunes ledger entries <= asOf, keeping later ones", () => {
		writeConfig(configPath, { usage: snapshot });
		const oldEntry = JSON.stringify({ timestamp: snapshot.asOf - 1_000, cost: 0.05 });
		const newEntry = JSON.stringify({ timestamp: snapshot.asOf + 1_000, cost: 0.07 });
		writeFileSync(ledgerPath, `${oldEntry}\n${newEntry}\n`, "utf-8");

		expect(runUsage().status).toBe(0);
		const written = JSON.parse(readFileSync(cachePath, "utf-8"));
		expect(typeof written.writtenAt).toBe("number");
		expect(written.snapshot).toEqual(snapshot);
		const ledger = readFileSync(ledgerPath, "utf-8");
		expect(ledger).not.toContain(oldEntry);
		expect(ledger).toContain(newEntry);
	});

	it("second immediate usage run exits 0 without rewriting", () => {
		writeConfig(configPath, { usage: snapshot });
		expect(runUsage().status).toBe(0);
		const first = readFileSync(cachePath, "utf-8");
		expect(runUsage().status).toBe(0);
		expect(readFileSync(cachePath, "utf-8")).toBe(first);
	});

	it("uses native usage without token/discovery seams and caches only projected billing fields", () => {
		writeConfig(configPath, { usage: [{ ...snapshot, token: "never-cache-me" }] });
		const result = runUsage(FAKE_NATIVE_IMPL_PATH);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout + result.stderr).toBe("");
		const output = readFileSync(cachePath, "utf-8");
		expect(JSON.parse(output).snapshots).toEqual([snapshot]);
		expect(output).not.toContain("never-cache-me");
		expect(existsSync(join(tmpDir, "token.json"))).toBe(false);
		expect(existsSync(`${cachePath}.lock`)).toBe(false);
	});

	it.each([
		["native", undefined, false],
		["native", "ledger", true],
		["managed", "provider", false],
	] as const)("uses %s accounting=%s when pruning the ledger", (kind, accounting, prunesLedger) => {
		let modulePath = kind === "native" ? FAKE_NATIVE_IMPL_PATH : FAKE_IMPL_PATH;
		if (accounting) {
			const overridePath = join(tmpDir, "accounting.ts");
			writeFileSync(overridePath, `import impl from ${JSON.stringify(pathToFileURL(modulePath).href)}; export default { ...impl, accounting: ${JSON.stringify(accounting)} };`);
			modulePath = overridePath;
		}
		writeConfig(configPath, { usage: snapshot });
		const ledger = JSON.stringify({ timestamp: snapshot.asOf - 1, cost: 999 }) + "\n";
		writeFileSync(ledgerPath, ledger);
		expect(runUsage(modulePath).status).toBe(0);
		expect(readFileSync(ledgerPath, "utf-8")).toBe(prunesLedger ? "" : ledger);
	});

	it("preserves successful snapshots, sanitizes failure, and backs off before retrying", () => {
		const counterFile = join(tmpDir, "usage-counter.txt");
		writeConfig(configPath, { usage: snapshot, usageCounterFile: counterFile });
		expect(runUsage(FAKE_NATIVE_IMPL_PATH).status).toBe(0);
		const prior = JSON.parse(readFileSync(cachePath, "utf-8"));
		prior.writtenAt = Date.now() - 301_000;
		prior.attemptedAt = prior.writtenAt;
		writeFileSync(cachePath, JSON.stringify(prior));
		writeConfig(configPath, { failSeams: ["usage"], usageErrorCode: "rate-limited", usageCounterFile: counterFile });
		const result = runUsage(FAKE_NATIVE_IMPL_PATH);
		expect(result.status).not.toBe(0);
		const output = readFileSync(cachePath, "utf-8");
		expect(result.stdout + result.stderr + output).not.toContain("do-not-log");
		expect(JSON.parse(output)).toMatchObject({ error: "rate-limited", snapshots: [snapshot] });
		expect(runUsage(FAKE_NATIVE_IMPL_PATH).status).toBe(0);
		expect(readFileSync(counterFile, "utf-8").trim().split("\n")).toHaveLength(2);
		expect(existsSync(`${cachePath}.lock`)).toBe(false);
	});

	it("rejects malformed snapshots instead of marking them fresh", () => {
		writeConfig(configPath, { usage: [{ ...snapshot, quota: null }] });
		expect(runUsage(FAKE_NATIVE_IMPL_PATH).status).not.toBe(0);
		expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toMatchObject({ error: "invalid-response", snapshots: [] });
	});

	it("skips a live usage lock and steals a stale one", () => {
		writeConfig(configPath, { usage: snapshot });
		writeFileSync(`${cachePath}.lock`, "live");
		expect(runUsage().status).toBe(0);
		expect(existsSync(cachePath)).toBe(false);
		const stale = new Date(Date.now() - 61_000);
		utimesSync(`${cachePath}.lock`, stale, stale);
		expect(runUsage().status).toBe(0);
		expect(existsSync(cachePath)).toBe(true);
		expect(existsSync(`${cachePath}.lock`)).toBe(false);
	});

	it("deduplicates concurrent workers under the usage lock", async () => {
		const counterFile = join(tmpDir, "usage-counter.txt");
		writeConfig(configPath, { usage: snapshot, usageDelayMs: 150, usageCounterFile: counterFile });
		const invoke = () => new Promise<number | null>((resolve, reject) => {
			const child = spawn(process.execPath, [RUNNER_PATH, ...usageArgs()], { stdio: "ignore", timeout: 20_000 });
			child.on("error", reject);
			child.on("close", resolve);
		});
		expect(await Promise.all([invoke(), invoke()])).toEqual([0, 0]);
		expect(readFileSync(counterFile, "utf-8").trim().split("\n")).toHaveLength(1);
	});
});
