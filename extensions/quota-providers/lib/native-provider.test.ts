import {
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuardedNativeProvider } from "./native-provider.js";

const PROVIDER = "github-copilot";
const APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("createGuardedNativeProvider", () => {
	it("uses an isolated native layer and preserves its authentication and catalog hooks", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const guarded = await createGuardedNativeProvider(PROVIDER, () => undefined);
		const donor = await create.mock.results[0].value;
		const base = donor.getProvider(PROVIDER)!;

		expect(create).toHaveBeenCalledWith({
			credentials: expect.any(InMemoryCredentialStore),
			modelsPath: null,
			refreshOnCreate: false,
		});
		expect(guarded.id).toBe(PROVIDER);
		expect(guarded.auth).toBe(base.auth);
		expect(guarded.getModels).toBe(base.getModels);
		expect(guarded.refreshModels).toBe(base.refreshModels);
		expect(guarded.refreshModels).toBeTypeOf("function");
		expect(guarded.filterModels).toBe(base.filterModels);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects unknown native provider IDs", async () => {
		await expect(createGuardedNativeProvider("missing-native-provider", () => undefined))
			.rejects.toThrow("Unknown native quota provider: missing-native-provider");
	});

	for (const method of ["stream", "streamSimple"] as const) {
		for (const api of APIS) {
			it(`guards ${method} for ${api} without replacing native transport dispatch`, async () => {
				let blocked = true;
				const evaluate = vi.fn(() => blocked
					? { blocked: true as const, kind: "soft" as const, message: "FAKE_QUOTA_BLOCK" }
					: undefined);
				const provider = await createGuardedNativeProvider(PROVIDER, evaluate);
				const runtime = await ModelRuntime.create({
					credentials: new InMemoryCredentialStore(),
					modelsStore: new InMemoryModelsStore(),
					modelsPath: null,
					refreshOnCreate: false,
				});
				runtime.registerNativeProvider(provider);
				await runtime.refresh({ allowNetwork: false, providers: [PROVIDER] });
				const model = runtime.getModels(PROVIDER).find((model) => model.api === api)!;
				const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: "FAKE_TRANSPORT" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}));
				const options = { apiKey: "FAKE", sessionId: "tree-child", fetch: transport, maxRetries: 0 };

				const denied = await runtime[method](model, { messages: [] }, options).result();
				expect(denied.errorMessage).toContain("FAKE_QUOTA_BLOCK");
				expect(transport).not.toHaveBeenCalled();
				blocked = false;
				const allowed = await runtime[method](model, { messages: [] }, options).result();
				expect(allowed.errorMessage).toContain("FAKE_TRANSPORT");
				expect(transport).toHaveBeenCalled();
				expect(evaluate).toHaveBeenCalledTimes(2);
				expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ api }), expect.objectContaining({ sessionId: "tree-child" }));
				expect(runtime.getProviders().filter((provider) => provider.id === PROVIDER)).toHaveLength(1);
				expect(fetch).not.toHaveBeenCalled();
			});
		}
	}
});
