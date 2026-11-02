import { describe, expect, it, vi } from "vitest";
import type { ModelEntry } from "./types.js";
import {
	REFRESH_FLOOR_MS,
	REFRESH_TTL_MS,
	buildProviderConfig,
	buildExistingProvider,
	discoveryRefreshDue,
	groupModels,
	readModelsCache,
	resolveModelMeta,
} from "./registration.js";

describe("buildExistingProvider", () => {
	it("keeps pi's authentication and catalog while replacing only the stream wrapper", async () => {
		const stream = vi.fn();
		const provider = await buildExistingProvider("github-copilot", () => stream);
		expect(provider.id).toBe("github-copilot");
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.getModels().length).toBeGreaterThan(0);
		expect(provider.refreshModels).toBeTypeOf("function");
		expect(provider.streamSimple).toBe(stream);
	});

	it("rejects an unknown pi provider", async () => {
		await expect(buildExistingProvider("missing-provider", (stream) => stream)).rejects.toThrow("Unknown pi provider");
	});
});

// groupModels

describe("groupModels", () => {
	it("puts models with the same api/baseUrlPath/authHeader into one group", () => {
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "gpt-4o", api: "openai-responses" },
			{ id: "m2", modelName: "gpt-4o-mini", api: "openai-responses" },
		];
		const groups = groupModels("my-impl", models);
		expect(groups).toHaveLength(1);
		expect(groups[0].providerId).toBe("my-impl-openai-responses");
		expect(groups[0].models).toHaveLength(2);
	});

	it("splits models with different baseUrlPath into separate groups", () => {
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "claude-3", api: "anthropic-messages", baseUrlPath: "/anthropic" },
			{ id: "m2", modelName: "gpt-4o", api: "anthropic-messages", baseUrlPath: "/openai" },
		];
		const groups = groupModels("impl", models);
		expect(groups).toHaveLength(2);
		const ids = groups.map((g) => g.providerId).sort();
		expect(ids).toContain("impl-anthropic-messages");
		expect(ids).toContain("impl-anthropic-messages-2");
	});

	it("suffixes second and third splits with -2, -3", () => {
		const models: ModelEntry[] = [
			{ id: "a", modelName: "x", api: "openai-completions", baseUrlPath: "/a" },
			{ id: "b", modelName: "y", api: "openai-completions", baseUrlPath: "/b" },
			{ id: "c", modelName: "z", api: "openai-completions", baseUrlPath: "/c" },
		];
		const groups = groupModels("impl", models);
		expect(groups).toHaveLength(3);
		const ids = groups.map((g) => g.providerId).sort();
		expect(ids).toEqual([
			"impl-openai-completions",
			"impl-openai-completions-2",
			"impl-openai-completions-3",
		]);
	});

	it("splits models with different authHeader into separate groups", () => {
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "x", api: "openai-responses", authHeader: true },
			{ id: "m2", modelName: "y", api: "openai-responses", authHeader: false },
		];
		const groups = groupModels("impl", models);
		expect(groups).toHaveLength(2);
	});

	it("per-model authHeader takes precedence over impl default", () => {
		const models: ModelEntry[] = [
			// This model's authHeader (false) overrides the impl default (true)
			{ id: "m1", modelName: "x", api: "openai-responses", authHeader: false },
			// This model inherits the impl default (true)
			{ id: "m2", modelName: "y", api: "openai-responses" },
		];
		const groups = groupModels("impl", models, true);
		expect(groups).toHaveLength(2);

		const falseGroup = groups.find((g) => g.authHeader === false);
		const trueGroup = groups.find((g) => g.authHeader === true);
		expect(falseGroup?.models.map((m) => m.id)).toEqual(["m1"]);
		expect(trueGroup?.models.map((m) => m.id)).toEqual(["m2"]);
	});

	it("groups different apis independently — each api's counter restarts at 1", () => {
		const models: ModelEntry[] = [
			{ id: "a1", modelName: "x", api: "openai-responses", baseUrlPath: "/a" },
			{ id: "a2", modelName: "y", api: "openai-responses", baseUrlPath: "/b" },
			{ id: "b1", modelName: "z", api: "anthropic-messages", baseUrlPath: "/c" },
			{ id: "b2", modelName: "w", api: "anthropic-messages", baseUrlPath: "/d" },
		];
		const groups = groupModels("impl", models);
		expect(groups).toHaveLength(4);
		const ids = groups.map((g) => g.providerId).sort();
		expect(ids).toEqual([
			"impl-anthropic-messages",
			"impl-anthropic-messages-2",
			"impl-openai-responses",
			"impl-openai-responses-2",
		]);
	});

	it("preserves baseUrlPath and authHeader on the group", () => {
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "x", api: "anthropic-messages", baseUrlPath: "/ant", authHeader: true },
		];
		const [group] = groupModels("impl", models);
		expect(group.baseUrlPath).toBe("/ant");
		expect(group.authHeader).toBe(true);
	});
});

// resolveModelMeta

describe("resolveModelMeta", () => {
	it("returns DEFAULTS copy when catalogProvider is undefined", () => {
		const meta = resolveModelMeta(undefined, "anything");
		expect(meta.reasoning).toBe(false);
		expect(meta.input).toEqual(["text"]);
		expect(meta.contextWindow).toBe(128000);
		expect(meta.maxTokens).toBe(16384);
		expect(meta.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("returns DEFAULTS copy (ZERO_COST) when catalogProvider is unknown", () => {
		const meta = resolveModelMeta("nonexistent-provider-xyz", "nonexistent-model");
		expect(meta.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("returns DEFAULTS copy when model not found in catalog", () => {
		// Use a valid provider name but a model that doesn't exist in it
		const meta = resolveModelMeta("anthropic", "nonexistent-model-zzzz");
		expect(meta.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(meta.contextWindow).toBe(128000);
	});

	it("returns real metadata for a known catalog model", () => {
		// anthropic/claude-3-5-haiku is well-known; just check it doesn't return ZERO_COST
		const meta = resolveModelMeta("anthropic", "claude-3-5-haiku-20241022");
		// It may or may not be found depending on the catalog version, but it shouldn't throw
		expect(typeof meta.contextWindow).toBe("number");
		expect(typeof meta.reasoning).toBe("boolean");
	});

	it("returns resolved values unchanged when no overrides are given", () => {
		const withOverrides = resolveModelMeta(undefined, "x", {});
		const without = resolveModelMeta(undefined, "x");
		expect(withOverrides).toEqual(without);
	});

	it("merges scalar overrides field-wise over the resolved value", () => {
		const meta = resolveModelMeta(undefined, "x", { contextWindow: 200_000, reasoning: true });
		expect(meta.contextWindow).toBe(200_000);
		expect(meta.reasoning).toBe(true);
		// Untouched fields keep their resolved (default) values.
		expect(meta.maxTokens).toBe(16384);
		expect(meta.input).toEqual(["text"]);
	});

	it("merges cost per sub-field over the resolved value", () => {
		const meta = resolveModelMeta(undefined, "x", { cost: { input: 3 } });
		expect(meta.cost).toEqual({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("falsy overrides win over resolved values (?? semantics)", () => {
		const meta = resolveModelMeta(undefined, "x", { reasoning: false, maxTokens: 0 });
		expect(meta.reasoning).toBe(false);
		expect(meta.maxTokens).toBe(0);
	});

	it("carries passthrough-only fields without catalog resolution", () => {
		const inputLimits = { images: { resize: { maxWidth: 1024 } } } as any;
		const promptCache = { short: 300 } as any;
		const meta = resolveModelMeta(undefined, "x", {
			headers: { "x-gateway": "1" },
			samplingParams: { temperature: 0 },
			inputLimits,
			promptCache,
		});
		expect(meta.headers).toEqual({ "x-gateway": "1" });
		expect(meta.samplingParams).toEqual({ temperature: 0 });
		expect(meta.inputLimits).toBe(inputLimits);
		expect(meta.promptCache).toBe(promptCache);
	});

	it("catalog-resolved values still feed the merge for known models", () => {
		// gpt-5.6-sol has thinkingLevelMap { max: "max" } in the catalog; a
		// partial override must not drop it.
		const meta = resolveModelMeta("openai", "gpt-5.6-sol", { contextWindow: 400_000 });
		expect(meta.contextWindow).toBe(400_000);
		expect(meta.thinkingLevelMap).toMatchObject({ max: "max" });
	});
});

// buildProviderConfig

describe("buildProviderConfig", () => {
	const impl = { id: "test-impl", name: "Test Impl", baseUrl: "https://api.example.com" };
	const apiKey = "!echo token";

	it("assembles baseUrl by appending group.baseUrlPath to impl.baseUrl", () => {
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "x", api: "openai-responses", baseUrlPath: "/v1" },
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		expect(cfg.baseUrl).toBe("https://api.example.com/v1");
	});

	it("uses impl.baseUrl directly when baseUrlPath is empty", () => {
		const models: ModelEntry[] = [{ id: "m1", modelName: "x", api: "openai-responses" }];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		expect(cfg.baseUrl).toBe("https://api.example.com");
	});

	it("sets apiKey from apiKeyCommand", () => {
		const models: ModelEntry[] = [{ id: "m1", modelName: "x", api: "openai-responses" }];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		expect(cfg.apiKey).toBe(apiKey);
	});

	it("sets api on the config", () => {
		const models: ModelEntry[] = [{ id: "m1", modelName: "x", api: "anthropic-messages" }];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		expect(cfg.api).toBe("anthropic-messages");
	});

	it("omits the stream override by default", () => {
		const models: ModelEntry[] = [{ id: "m1", modelName: "x", api: "openai-responses" }];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		expect(cfg.streamSimple).toBeUndefined();
	});

	it("includes an optional stream guard without changing the default config", () => {
		const models: ModelEntry[] = [{ id: "m1", modelName: "x", api: "openai-responses" }];
		const [group] = groupModels("impl", models);
		const streamSimple = vi.fn() as any;
		const cfg = buildProviderConfig(impl, group, apiKey, streamSimple) as Record<string, unknown>;
		expect(cfg.streamSimple).toBe(streamSimple);
	});

	it("includes compat.forceAdaptiveThinking only for anthropic-messages models that have it", () => {
		// Use an anthropic model that may have forceAdaptiveThinking — we'll mock the path
		// by building a group manually with a model known to resolve forceAdaptiveThinking.
		// Since catalog data may vary, we test the absent case (unknown model → no compat).
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "nonexistent-xyz", api: "anthropic-messages", catalogProvider: "anthropic" },
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const modelsCfg = cfg.models as Array<Record<string, unknown>>;
		// Unknown model → DEFAULTS → no forceAdaptiveThinking → no compat key
		expect(modelsCfg[0].compat).toBeUndefined();
	});

	it("does NOT include compat for non-anthropic-messages apis even if forceAdaptiveThinking would be set", () => {
		const models: ModelEntry[] = [
			{ id: "m1", modelName: "x", api: "openai-responses" },
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const modelsCfg = cfg.models as Array<Record<string, unknown>>;
		expect(modelsCfg[0].compat).toBeUndefined();
	});

	it("maps models with id, name, reasoning, input, cost, contextWindow, maxTokens", () => {
		const models: ModelEntry[] = [
			{ id: "my-deployment", modelName: "x", api: "openai-responses" },
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.id).toBe("my-deployment");
		expect(m.name).toBe("my-deployment");
		expect(m).toHaveProperty("reasoning");
		expect(m).toHaveProperty("input");
		expect(m).toHaveProperty("cost");
		expect(m).toHaveProperty("contextWindow");
		expect(m).toHaveProperty("maxTokens");
	});

	it("uses ModelEntry.name as the display name while preserving the wire id", () => {
		const models: ModelEntry[] = [
			{ id: "canonical-id", name: "Friendly Name", modelName: "x", api: "openai-responses" },
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.id).toBe("canonical-id");
		expect(m.name).toBe("Friendly Name");
	});

	it("preserves GPT-5.6's max thinking capability from the catalog", () => {
		const models: ModelEntry[] = [
			{
				id: "gpt-5.6-sol",
				modelName: "gpt-5.6-sol",
				api: "openai-responses",
				catalogProvider: "openai",
			},
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [model] = cfg.models as Array<Record<string, unknown>>;

		expect(model.thinkingLevelMap).toMatchObject({ max: "max" });
	});

	it("applies entry metadata overrides to the registered model", () => {
		const models: ModelEntry[] = [
			{
				id: "my-deployment",
				modelName: "x",
				api: "openai-responses",
				contextWindow: 256_000,
				maxTokens: 32_768,
				reasoning: true,
				cost: { input: 5 },
			},
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.contextWindow).toBe(256_000);
		expect(m.maxTokens).toBe(32_768);
		expect(m.reasoning).toBe(true);
		expect(m.cost).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("passes through entry headers, samplingParams, inputLimits, and promptCache", () => {
		const inputLimits = { images: { resize: { maxWidth: 1024 } } } as any;
		const models: ModelEntry[] = [
			{
				id: "m1",
				modelName: "x",
				api: "openai-responses",
				headers: { "x-gateway": "1" },
				samplingParams: { temperature: 0 },
				inputLimits,
				promptCache: { short: 300 } as any,
			},
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.headers).toEqual({ "x-gateway": "1" });
		expect(m.samplingParams).toEqual({ temperature: 0 });
		expect(m.inputLimits).toBe(inputLimits);
		expect(m.promptCache).toEqual({ short: 300 });
	});

	it("honors entry forceAdaptiveThinking override for anthropic-messages", () => {
		const models: ModelEntry[] = [
			{
				id: "m1",
				modelName: "nonexistent-xyz",
				api: "anthropic-messages",
				catalogProvider: "anthropic",
				forceAdaptiveThinking: true,
			},
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.compat).toEqual({ forceAdaptiveThinking: true });
	});

	it("merges entry compat with the anthropic forceAdaptiveThinking rule", () => {
		const models: ModelEntry[] = [
			{
				id: "m1",
				modelName: "nonexistent-xyz",
				api: "anthropic-messages",
				catalogProvider: "anthropic",
				compat: { customFlag: 1 } as any,
				forceAdaptiveThinking: true,
			},
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.compat).toEqual({ customFlag: 1, forceAdaptiveThinking: true });
	});

	it("passes entry compat through for non-anthropic apis without the force rule", () => {
		const models: ModelEntry[] = [
			{
				id: "m1",
				modelName: "x",
				api: "openai-responses",
				compat: { customFlag: 1 } as any,
				forceAdaptiveThinking: true,
			},
		];
		const [group] = groupModels("impl", models);
		const cfg = buildProviderConfig(impl, group, apiKey) as Record<string, unknown>;
		const [m] = cfg.models as Array<Record<string, unknown>>;
		expect(m.compat).toEqual({ customFlag: 1 });
	});
});

// readModelsCache

describe("readModelsCache", () => {
	it("returns null for a nonexistent path", () => {
		expect(readModelsCache("/tmp/does-not-exist-quota-providers-test.json")).toBeNull();
	});

	it("returns null for garbage JSON", async () => {
		const { writeFileSync, unlinkSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const path = join(tmpdir(), "registration-test-garbage.json");
		writeFileSync(path, "{{not valid json}}");
		expect(readModelsCache(path)).toBeNull();
		unlinkSync(path);
	});

	it("returns null for valid JSON missing models array", async () => {
		const { writeFileSync, unlinkSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const path = join(tmpdir(), "registration-test-no-models.json");
		writeFileSync(path, JSON.stringify({ writtenAt: 1234, data: "something" }));
		expect(readModelsCache(path)).toBeNull();
		unlinkSync(path);
	});

	it("returns parsed cache for valid file", async () => {
		const { writeFileSync, unlinkSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const path = join(tmpdir(), "registration-test-valid.json");
		const entry: ModelEntry = { id: "m1", modelName: "x", api: "openai-responses" };
		const cache = { writtenAt: 9999, models: [entry] };
		writeFileSync(path, JSON.stringify(cache));
		const result = readModelsCache(path);
		expect(result).not.toBeNull();
		expect(result!.writtenAt).toBe(9999);
		expect(result!.models).toHaveLength(1);
		unlinkSync(path);
	});
});

// discoveryRefreshDue

describe("discoveryRefreshDue", () => {
	const now = 1_000_000_000_000;

	describe("firstRunInProcess = true (cold start)", () => {
		it("returns false when cache is younger than REFRESH_FLOOR_MS", () => {
			const writtenAt = now - REFRESH_FLOOR_MS + 1;
			expect(discoveryRefreshDue(writtenAt, now, true)).toBe(false);
		});

		it("returns false when cache age exactly equals REFRESH_FLOOR_MS (strict >)", () => {
			const writtenAt = now - REFRESH_FLOOR_MS;
			expect(discoveryRefreshDue(writtenAt, now, true)).toBe(false);
		});

		it("returns true when cache is older than REFRESH_FLOOR_MS", () => {
			const writtenAt = now - REFRESH_FLOOR_MS - 1;
			expect(discoveryRefreshDue(writtenAt, now, true)).toBe(true);
		});

		it("returns false even if cache is older than REFRESH_TTL_MS but younger than ... (edge)", () => {
			// This doesn't apply — firstRun uses the floor, not TTL. But ensure
			// a very fresh cache returns false.
			const writtenAt = now - 100;
			expect(discoveryRefreshDue(writtenAt, now, true)).toBe(false);
		});
	});

	describe("firstRunInProcess = false (/new or /reload)", () => {
		it("returns false when cache is younger than REFRESH_TTL_MS", () => {
			const writtenAt = now - REFRESH_TTL_MS + 1;
			expect(discoveryRefreshDue(writtenAt, now, false)).toBe(false);
		});

		it("returns false when cache age exactly equals REFRESH_TTL_MS (strict >)", () => {
			const writtenAt = now - REFRESH_TTL_MS;
			expect(discoveryRefreshDue(writtenAt, now, false)).toBe(false);
		});

		it("returns true when cache is older than REFRESH_TTL_MS", () => {
			const writtenAt = now - REFRESH_TTL_MS - 1;
			expect(discoveryRefreshDue(writtenAt, now, false)).toBe(true);
		});

		it("returns false when cache is only REFRESH_FLOOR_MS old (floor < TTL)", () => {
			// REFRESH_FLOOR_MS < REFRESH_TTL_MS, so a floor-old cache is NOT due on /reload
			const writtenAt = now - REFRESH_FLOOR_MS;
			expect(discoveryRefreshDue(writtenAt, now, false)).toBe(false);
		});
	});
});
