import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachePaths, loadProvidersConfig, parseProvidersConfig, POLICY_KEYS } from "./config.js";

// Helpers

function noExpand(p: string): string {
	return p;
}

function makeRaw(providers: Record<string, unknown>): string {
	return JSON.stringify({ providers });
}

// parseProvidersConfig

describe("parseProvidersConfig", () => {
	it("applies policy defaults when optional fields are absent", () => {
		const raw = makeRaw({ myProvider: { module: "/path/to/impl.ts" } });
		const { providers, warnings } = parseProvidersConfig(raw, noExpand);

		expect(warnings).toHaveLength(0);
		expect(providers).toHaveLength(1);
		const [p] = providers;
		expect(p.id).toBe("myProvider");
		expect(p.modulePath).toBe("/path/to/impl.ts");
		expect(p.enabled).toBe(true);
		expect(p.policy).toEqual({
			bypassAllowed: true,
			lookaheadHours: 6,
			maxPollSeconds: 300,
			enforceHardCap: false,
		});
	});

	it("passes through explicit policy settings", () => {
		const raw = makeRaw({
			myProvider: {
				module: "/impl.ts",
				bypassAllowed: false,
				lookaheadHours: 12,
				maxPollSeconds: 60,
				enforceHardCap: true,
			},
		});
		const { providers } = parseProvidersConfig(raw, noExpand);
		expect(providers[0].policy).toEqual({
			bypassAllowed: false,
			lookaheadHours: 12,
			maxPollSeconds: 60,
			enforceHardCap: true,
		});
	});

	it("excludes POLICY_KEYS from settings passthrough", () => {
		const raw = makeRaw({
			myProvider: {
				module: "/impl.ts",
				bypassAllowed: false,
				lookaheadHours: 12,
				maxPollSeconds: 60,
				enforceHardCap: true,
				enabled: true,
				endpoint: "https://example.com",
				resourceGroup: "my-rg",
			},
		});
		const { providers } = parseProvidersConfig(raw, noExpand);
		const { settings } = providers[0];

		// None of the POLICY_KEYS should appear in settings
		for (const key of POLICY_KEYS) {
			expect(settings).not.toHaveProperty(key);
		}

		// Non-policy keys should pass through
		expect(settings.endpoint).toBe("https://example.com");
		expect(settings.resourceGroup).toBe("my-rg");
	});

	it("expands ~ in module path via the expandHome callback", () => {
		const expandHome = (p: string) =>
			p.startsWith("~/") ? path.join("/home/user", p.slice(2)) : p;

		const raw = makeRaw({ myProvider: { module: "~/providers/impl.ts" } });
		const { providers } = parseProvidersConfig(raw, expandHome);
		expect(providers[0].modulePath).toBe("/home/user/providers/impl.ts");
	});

	it("drops a malformed entry (non-string module) with a warning", () => {
		const raw = makeRaw({
			badProvider: { module: 42 },
			goodProvider: { module: "/impl.ts" },
		});
		const { providers, warnings } = parseProvidersConfig(raw, noExpand);
		expect(providers).toHaveLength(1);
		expect(providers[0].id).toBe("goodProvider");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/badProvider/);
	});

	it("drops a malformed entry (missing module) with a warning", () => {
		const raw = makeRaw({ noModule: { endpoint: "https://x.com" } });
		const { providers, warnings } = parseProvidersConfig(raw, noExpand);
		expect(providers).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/noModule/);
	});

	it("drops an entry whose block is not an object with a warning", () => {
		const raw = makeRaw({ badBlock: "not-an-object" });
		const { providers, warnings } = parseProvidersConfig(raw, noExpand);
		expect(providers).toHaveLength(0);
		expect(warnings).toHaveLength(1);
	});

	it("returns warning and empty providers on unparseable JSON", () => {
		const { providers, warnings } = parseProvidersConfig("{bad json{{", noExpand);
		expect(providers).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/parse/i);
	});

	it("returns warning when providers field is missing or not an object", () => {
		const { providers, warnings } = parseProvidersConfig(JSON.stringify({ foo: 1 }), noExpand);
		expect(providers).toHaveLength(0);
		expect(warnings).toHaveLength(1);
	});

	it("respects enabled:false", () => {
		const raw = makeRaw({ myProvider: { module: "/impl.ts", enabled: false } });
		const { providers } = parseProvidersConfig(raw, noExpand);
		expect(providers).toHaveLength(1);
		expect(providers[0].enabled).toBe(false);
	});
});

// loadProvidersConfig

describe("loadProvidersConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-providers-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty providers and no warnings when the file is missing", () => {
		const { providers, warnings } = loadProvidersConfig(
			path.join(tmpDir, "does-not-exist.json"),
		);
		expect(providers).toHaveLength(0);
		expect(warnings).toHaveLength(0);
	});

	it("loads and parses an existing config file", () => {
		const configPath = path.join(tmpDir, "quota-providers.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				providers: {
					testImpl: { module: "/tmp/impl.ts", endpoint: "https://x.com" },
				},
			}),
		);

		const { providers, warnings } = loadProvidersConfig(configPath);
		expect(warnings).toHaveLength(0);
		expect(providers).toHaveLength(1);
		expect(providers[0].id).toBe("testImpl");
		expect(providers[0].settings.endpoint).toBe("https://x.com");
	});
});

// cachePaths

describe("cachePaths", () => {
	it("returns paths nested under <agentDir>/cache/quota-providers/<implId>/", () => {
		const paths = cachePaths("/home/user/.pi/agent", "my-impl");
		const base = "/home/user/.pi/agent/cache/quota-providers/my-impl";
		expect(paths.dir).toBe(base);
		expect(paths.models).toBe(path.join(base, "models.json"));
		expect(paths.token).toBe(path.join(base, "token.json"));
		expect(paths.usage).toBe(path.join(base, "usage.json"));
		expect(paths.ledger).toBe(path.join(base, "ledger.jsonl"));
	});
});
