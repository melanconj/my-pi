import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import copilot from "./copilot.js";

const now = Date.parse("2026-10-28T20:00:00Z");
const reported = "2026-10-28T19:37:23Z";
const payload = (source = {}) => ({
	token_based_billing: true,
	quota_reset_date_utc: "2026-11-01T00:00:00Z",
	quota_reset_date: "2026-11-02",
	quota_snapshots: { premium_interactions: {
		unlimited: false, entitlement: "60000", quota_remaining: 51733.7,
		percent_remaining: 86.2, remaining: 51733, credits_used: 8247,
		timestamp_utc: reported, ...source,
	} },
});
let agentDir: string;
const setCredential = (credential: unknown) => writeFileSync(join(agentDir, "auth.json"),
	JSON.stringify({ "github-copilot": credential }));
const request = vi.fn<typeof fetch>();
const usage = () => copilot.getUsage!({ settings: {} });

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "copilot-quota-test-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	setCredential({ type: "oauth", refresh: "github-login", access: "inference-token", expires: 0 });
	vi.stubGlobal("fetch", request);
	request.mockImplementation(async () => Response.json(payload()));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.resetAllMocks();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("Copilot quota", () => {
	it("converts AI credits to dollars and rereads the current GitHub login, not its inference token", async () => {
		const { snapshots: [snapshot] } = await usage();
		expect(snapshot).toMatchObject({ quota: 600, asOf: Date.parse(reported),
			windowStart: Date.parse("2026-10-01"), windowEnd: Date.parse("2026-11-01") });
		expect(snapshot.spend).toBeCloseTo(82.663);
		expect(request).toHaveBeenCalledWith("https://api.github.com/copilot_internal/user", expect.objectContaining({
			method: "GET", redirect: "manual", signal: expect.any(AbortSignal),
			headers: expect.objectContaining({ Authorization: "token github-login" }),
		}));
		setCredential({ type: "oauth", refresh: "new-login", access: "inference-token", expires: 0 });
		await usage();
		expect(request.mock.calls[1][1]!.headers).toMatchObject({ Authorization: "token new-login" });
	});

	it("prefers premium_models and uses percentage when compatible remaining is absent", async () => {
		const data = payload();
		Object.assign(data.quota_snapshots, { premium_models: { unlimited: false, entitlement: 10000, percent_remaining: 75 } });
		request.mockResolvedValueOnce(Response.json(data));
		expect(await usage()).toMatchObject({ snapshots: [{ quota: 100, spend: 25 }] });
	});

	it("prefers a category reset over account resets and keeps the reported asOf", async () => {
		const data = payload({ quota_reset_at: Date.parse("2026-11-01") / 1000 });
		data.quota_reset_date_utc = "2026-12-01T00:00:00Z";
		request.mockResolvedValueOnce(Response.json(data));
		expect(await usage()).toMatchObject({ snapshots: [{ windowEnd: Date.parse("2026-11-01"), asOf: Date.parse(reported) }] });
	});

	it("keeps lagging usage in its original UTC month across a year rollover", async () => {
		vi.setSystemTime(Date.parse("2027-01-01T00:01:00Z"));
		const data = payload({ timestamp_utc: "2026-12-31T23:59:00Z" });
		request.mockResolvedValueOnce(Response.json({ ...data, quota_reset_date_utc: undefined, quota_reset_date: undefined }));
		expect(await usage()).toMatchObject({ snapshots: [{ windowStart: Date.parse("2026-12-01"), windowEnd: Date.parse("2027-01-01"),
			asOf: Date.parse("2026-12-31T23:59:00Z") }] });
	});

	it("returns no finite cap for an explicit unlimited allowance", async () => {
		request.mockResolvedValueOnce(Response.json(payload({ unlimited: true, entitlement: 0 })));
		expect(await usage()).toMatchObject({ snapshots: [], modelLimitIds: {} });
	});

	it("requires a valid stored GitHub OAuth login", async () => {
		for (const credential of [undefined, { type: "oauth", refresh: 123 }, { type: "api_key", refresh: "secret" }]) {
			setCredential(credential);
			await expect(usage()).rejects.toThrow("sign in with GitHub Copilot");
		}
		expect(request).not.toHaveBeenCalled();
	});

	it("reads BOM-prefixed auth files and fails safely on malformed files", async () => {
		writeFileSync(join(agentDir, "auth.json"), `\uFEFF${JSON.stringify({
			"github-copilot": { type: "oauth", refresh: "github-login" },
		})}`);
		await expect(usage()).resolves.toMatchObject({ snapshots: [expect.any(Object)] });
		writeFileSync(join(agentDir, "auth.json"), "not json");
		await expect(usage()).rejects.toThrow("could not read the current login");
	});

	it("rejects Enterprise logins before transmitting credentials", async () => {
		setCredential({ type: "oauth", refresh: "secret", access: "access", expires: 0, enterpriseUrl: "company.ghe.com" });
		await expect(usage()).rejects.toThrow("Enterprise logins are unsupported");
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects request-based billing rather than inventing dollar prices", async () => {
		request.mockResolvedValueOnce(Response.json({ ...payload(), token_based_billing: false }));
		await expect(usage()).rejects.toThrow("legacy premium-request billing is unsupported");
	});

	it("sanitizes failed HTTP responses and token-bearing network errors", async () => {
		for (const status of [302, 401, 500]) {
			request.mockResolvedValueOnce(new Response("private account details", { status }));
			await expect(usage()).rejects.toThrow("Copilot quota: usage request failed.");
		}
		request.mockRejectedValueOnce(new Error("secret token in transport error"));
		await expect(usage()).rejects.toThrow("Copilot quota: usage request failed.");
	});
});
