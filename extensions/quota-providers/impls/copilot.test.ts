import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

vi.mock("@earendil-works/pi-coding-agent", () => ({ readStoredCredential: vi.fn() }));
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import copilot, { parseCopilotUsage } from "./copilot.js";

const now = Date.parse("2026-10-28T20:00:00Z");
const backendTime = "2026-10-28T19:37:23.536Z";
const payload = () => ({
	token_based_billing: true,
	quota_reset_date: "2026-11-02",
	quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
	quota_snapshots: {
		premium_interactions: {
			unlimited: false, percent_remaining: 86.2, entitlement: 60000,
			quota_remaining: 51733.7, remaining: 51733, credits_used: 8247,
			overage_permitted: true, overage_count: 0, timestamp_utc: backendTime, quota_reset_at: 0,
		},
		chat: { unlimited: true, percent_remaining: 100 },
		completions: { unlimited: true, percent_remaining: 100 },
	},
});

function premium(source: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return { token_based_billing: true, ...extra, quota_snapshots: { premium_interactions: source } };
}

function invalid(data: unknown, code = "invalid-response") {
	try {
		parseCopilotUsage(data, now);
		throw new Error("Expected invalid quota response");
	} catch (error) {
		expect(error).toMatchObject({ code });
	}
}

describe("Copilot AI-credit dollar snapshots", () => {
	it("converts authoritative fractional remaining credits without using percentages or credits_used", () => {
		const data = { ...payload(), login: "private-user", token: "fake-secret" };
		const result = parseCopilotUsage(data, now);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			label: "Copilot AI credits", quota: 600,
			windowStart: Date.parse("2026-10-01T00:00:00Z"),
			windowEnd: Date.parse("2026-11-01T00:00:00Z"),
			asOf: Date.parse(backendTime),
		});
		expect(result[0].spend).toBeCloseTo(82.663, 10);
		expect(result[0]).not.toHaveProperty("limitId");
		expect(JSON.stringify(result)).not.toMatch(/private-user|fake-secret|credits_used|overage/);
	});

	it.each([10000, "10000"])("accepts positive numeric entitlement %s", (entitlement) => {
		expect(parseCopilotUsage(premium({ unlimited: false, entitlement, quota_remaining: 7500 }), now)[0]).toMatchObject({ quota: 100, spend: 25 });
	});

	it("preserves fractional credit entitlement and spend", () => {
		const snapshot = parseCopilotUsage(premium({ unlimited: false, entitlement: "100.5", quota_remaining: 75.25 }), now)[0];
		expect(snapshot.quota).toBeCloseTo(1.005, 12);
		expect(snapshot.spend).toBeCloseTo(0.2525, 12);
	});

	it("falls back to a finite percentage only when quota_remaining is absent", () => {
		const snapshot = parseCopilotUsage(premium({ unlimited: false, entitlement: 60000, percent_remaining: 86.2, credits_used: 8247 }), now)[0];
		expect(snapshot.quota).toBe(600);
		expect(snapshot.spend).toBeCloseTo(82.8, 10);
	});

	it("ignores malformed percentage when authoritative remaining is valid", () => {
		expect(parseCopilotUsage(premium({ unlimited: false, entitlement: 10000, quota_remaining: 2500, percent_remaining: NaN }), now)[0].spend).toBe(75);
	});

	it.each([0, -1, "nonsense", Infinity, undefined])("rejects unusable limited entitlement %s instead of returning unlimited", (entitlement) => {
		invalid(premium({ unlimited: false, entitlement, quota_remaining: 0 }));
	});

	it.each([NaN, "50"])("rejects malformed remaining %s instead of percentage fallback", (quotaRemaining) => {
		invalid(premium({ unlimited: false, entitlement: 100, quota_remaining: quotaRemaining, percent_remaining: 50 }));
	});

	it.each([[0, 100], [-25, 100.25], [10001, 0]])("accepts finite remaining %s as compatible spend $%s", (quotaRemaining, spend) => {
		expect(parseCopilotUsage(premium({ unlimited: false, entitlement: 10000, quota_remaining: quotaRemaining }), now)[0]).toMatchObject({ quota: 100, spend });
	});

	it.each([-1, 101, NaN])("rejects unusable fallback percentage %s", (percentRemaining) => {
		invalid(premium({ unlimited: false, entitlement: 100, percent_remaining: percentRemaining }));
	});

	it("never derives missing spend from credits_used, remaining, or overage_count", () => {
		invalid(premium({ unlimited: false, entitlement: 100, credits_used: 25, remaining: 75, overage_count: 500 }));
	});

	it("does not add unverified overage counts to compatible finite-budget spend", () => {
		const result = parseCopilotUsage(premium({ unlimited: false, entitlement: 100, quota_remaining: 0, overage_count: 1000, overage_permitted: true, credits_used: 9999 }), now);
		expect(result[0]).toMatchObject({ quota: 1, spend: 1 });
	});

	it("prefers premium_models when supplied", () => {
		const data = payload();
		Object.assign(data.quota_snapshots, { premium_models: { unlimited: false, entitlement: 10000, quota_remaining: 5000 } });
		expect(parseCopilotUsage(data, now)[0]).toMatchObject({ quota: 100, spend: 50 });
	});

	it("does not fall back from malformed premium_models to another budget", () => {
		const data = payload();
		Object.assign(data.quota_snapshots, { premium_models: null });
		invalid(data);
	});

	it("returns no finite cap only when the chosen bucket explicitly declares unlimited", () => {
		expect(parseCopilotUsage(premium({ unlimited: true }), now)).toEqual([]);
	});

	it("does not mistake unlimited chat for unlimited premium quota", () => {
		invalid({ token_based_billing: true, quota_snapshots: { chat: { unlimited: true }, completions: { unlimited: true } } });
		invalid({ token_based_billing: true, quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 0 }, chat: { unlimited: true } } });
	});

	it.each([false, undefined])("rejects request-based or unknown billing %s without inventing dollar prices", (flag) => {
		invalid({ ...payload(), token_based_billing: flag }, "unsupported-billing");
		expect(() => parseCopilotUsage({ ...payload(), token_based_billing: flag }, now)).toThrow("legacy premium-request billing is unsupported");
	});

	it.each([null, { token_based_billing: true, quota_snapshots: [] }, premium({ unlimited: "true", entitlement: 100 })])("rejects malformed snapshots", (data) => {
		expect(() => parseCopilotUsage(data, now)).toThrow();
	});
});

describe("Copilot calendar windows and reporting lag", () => {
	it("prefers per-category calendar reset over account timestamps", () => {
		const data = payload();
		data.quota_reset_date_utc = "2026-12-01T00:00:00Z";
		data.quota_snapshots.premium_interactions.quota_reset_at = Date.parse("2026-11-01T00:00:00Z") / 1000;
		expect(parseCopilotUsage(data, now)[0].windowEnd).toBe(Date.parse("2026-11-01T00:00:00Z"));
	});

	it("falls back from invalid category and account UTC resets to date-only UTC", () => {
		const result = parseCopilotUsage(premium({ unlimited: false, entitlement: 100, percent_remaining: 50, quota_reset_at: Infinity }, {
			quota_reset_date_utc: "invalid", quota_reset_date: "2026-11-01",
		}), now);
		expect(result[0].windowEnd).toBe(Date.parse("2026-11-01T00:00:00Z"));
	});

	it.each([
		["2024-02-15T12:00:00Z", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z", 29],
		["2026-12-15T12:00:00Z", "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z", 31],
	])("derives calendar window for %s without fixed thirty-day assumptions", (at, start, end, days) => {
		const snapshot = parseCopilotUsage(premium({ unlimited: false, entitlement: 100, percent_remaining: 50 }), Date.parse(String(at)))[0];
		expect(snapshot.windowStart).toBe(Date.parse(String(start)));
		expect(snapshot.windowEnd).toBe(Date.parse(String(end)));
		expect(snapshot.windowEnd - snapshot.windowStart).toBe(Number(days) * 86400000);
	});

	it.each(["2026-02-31", "2026-11-01T00:00:00"])("does not use invalid or timezone-ambiguous reset %s", (reset) => {
		expect(parseCopilotUsage(premium({ unlimited: false, entitlement: 100, percent_remaining: 50 }, { quota_reset_date: reset }), now)[0].windowEnd).toBe(Date.parse("2026-11-01T00:00:00Z"));
	});

	it("rejects a noncalendar reset rather than guessing a window", () => {
		invalid(premium({ unlimited: false, entitlement: 100, percent_remaining: 50 }, { quota_reset_date_utc: "2026-11-02T00:00:00Z" }), "unsupported-account");
	});

	it("rejects account reset inconsistent with the snapshot month", () => {
		invalid(premium({ unlimited: false, entitlement: 100, percent_remaining: 50 }, { quota_reset_date_utc: "2026-12-01T00:00:00Z" }));
	});

	it("does not let unrelated unlimited chat timestamps age the premium budget", () => {
		const data = payload();
		Object.assign(data.quota_snapshots.chat, { timestamp_utc: "2026-10-01T00:00:00Z" });
		expect(parseCopilotUsage(data, now)[0].asOf).toBe(Date.parse(backendTime));
	});

	it("uses backend time conservatively and clamps future reports to fetch time", () => {
		expect(parseCopilotUsage(payload(), now)[0].asOf).toBe(Date.parse(backendTime));
		expect(parseCopilotUsage(premium({ unlimited: false, entitlement: 100, percent_remaining: 50, timestamp_utc: "2026-12-01T00:00:00Z" }), now)[0].asOf).toBe(now);
	});

	it("rejects pre-epoch backend timestamps instead of returning invalid core snapshots", () => {
		invalid(premium({ unlimited: false, entitlement: 100, percent_remaining: 50, timestamp_utc: "1969-12-01T00:00:00Z" }));
	});

	it("keeps lagging prior-month usage in its original window at rollover", () => {
		const fetchedAt = Date.parse("2026-11-01T00:01:00Z");
		const snapshot = parseCopilotUsage(premium({ unlimited: false, entitlement: 100, percent_remaining: 10, timestamp_utc: "2026-10-31T23:59:00Z" }), fetchedAt)[0];
		expect(snapshot.windowStart).toBe(Date.parse("2026-10-01T00:00:00Z"));
		expect(snapshot.windowEnd).toBe(Date.parse("2026-11-01T00:00:00Z"));
		expect(snapshot.asOf).toBe(Date.parse("2026-10-31T23:59:00Z"));
	});
});

describe("Copilot read-only quota HTTP", () => {
	const auth = vi.mocked(readStoredCredential);
	const request = vi.fn<typeof fetch>();
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		auth.mockReturnValue({ type: "oauth", refresh: "fake-github-oauth", access: "fake-inference-token", expires: 0 });
		vi.stubGlobal("fetch", request);
		request.mockResolvedValue(Response.json(payload()));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("keeps native provider metadata and only uses the GitHub OAuth token in a nonredirecting GET", async () => {
		const result = await copilot.getUsage({ settings: {} });
		expect(copilot).toMatchObject({ id: "github-copilot", nativeProviderId: "github-copilot", name: "Copilot", accounting: "provider" });
		expect(auth).toHaveBeenCalledExactlyOnceWith("github-copilot", undefined);
		expect(request).toHaveBeenCalledExactlyOnceWith("https://api.github.com/copilot_internal/user", expect.objectContaining({
			method: "GET", redirect: "manual", signal: expect.any(AbortSignal),
			headers: expect.objectContaining({ Authorization: "token fake-github-oauth", "X-GitHub-Api-Version": "2025-04-01", "User-Agent": "my-pi-quota" }),
		}));
		expect(JSON.stringify(result)).not.toMatch(/fake-github|fake-inference/);
	});

	it("reads current stored OAuth on each poll without caching the token", async () => {
		await copilot.getUsage({ settings: {} });
		auth.mockReturnValue({ type: "oauth", refresh: "fake-updated-oauth", access: "fake-inference-token", expires: 0 });
		request.mockResolvedValueOnce(Response.json(payload()));
		await copilot.getUsage({ settings: {} });
		expect(auth).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1][1]!.headers).toMatchObject({ Authorization: "token fake-updated-oauth" });
	});

	it("passes a custom auth path to the stored-credential reader", async () => {
		await copilot.getUsage({ settings: { authPath: "/fake/private/auth.json" } });
		expect(auth).toHaveBeenCalledWith("github-copilot", "/fake/private/auth.json");
	});

	it.each([undefined, { type: "api_key", key: "fake-key" }, { type: "oauth", refresh: "" }])("handles absent or unusable OAuth without a request", async (credential) => {
		auth.mockReturnValue(credential as ReturnType<typeof readStoredCredential>);
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "not-authenticated", message: "Copilot quota: not-authenticated" });
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects enterprise accounts before transmitting any credential", async () => {
		auth.mockReturnValue({ type: "oauth", refresh: "fake-secret", access: "fake-access", expires: 0, enterpriseUrl: "company.ghe.com" });
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "unsupported-account" });
		expect(request).not.toHaveBeenCalled();
	});

	it.each(["", 123])("rejects invalid configured authPath %s", async (authPath) => {
		await expect(copilot.getUsage({ settings: { authPath } })).rejects.toMatchObject({ code: "not-authenticated" });
		expect(auth).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it.each([[401, "unauthorized"], [403, "unauthorized"], [429, "rate-limited"], [500, "unavailable"], [302, "unavailable"]])("sanitizes HTTP %s as %s without reading body", async (status, code) => {
		request.mockResolvedValue(new Response("fake-secret error body", { status: Number(status), headers: { location: "https://untrusted.example" } }));
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code, message: `Copilot quota: ${code}` });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each([{ "retry-after": "60" }, { "x-ratelimit-remaining": "0" }])("recognizes GitHub 403 rate-limit headers", async (headers) => {
		request.mockResolvedValue(new Response("fake-secret", { status: 403, headers }));
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "rate-limited" });
	});

	it("sanitizes network failures rather than preserving token-bearing error messages", async () => {
		request.mockRejectedValue(new Error("fake-secret request details"));
		const error = await copilot.getUsage({ settings: {} }).catch((failure) => failure);
		expect(error).toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
		expect(error).not.toHaveProperty("cause");
		expect(String(error)).not.toContain("fake-secret");
	});

	it("sanitizes credential reader failures", async () => {
		auth.mockImplementationOnce(() => { throw new Error("private path fake-secret"); });
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects malformed JSON without retaining its contents", async () => {
		request.mockResolvedValue(new Response("fake-secret invalid JSON"));
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "invalid-response", message: "Copilot quota: invalid-response" });
	});

	it.each([true, false])("bounds response bytes with content length present=%s", async (withLength) => {
		request.mockResolvedValue(new Response("x".repeat(256 * 1024 + 1), { headers: withLength ? { "content-length": String(256 * 1024 + 1) } : {} }));
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "invalid-response" });
	});

	it("sanitizes response stream failures", async () => {
		const body = new ReadableStream({ start(controller) { controller.error(new Error("fake-secret body details")); } });
		request.mockResolvedValueOnce(new Response(body));
		await expect(copilot.getUsage({ settings: {} })).rejects.toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
	});

	it("rejects success if cancellation arrived before body parsing finished", async () => {
		const controller = new AbortController();
		request.mockImplementationOnce(async () => {
			controller.abort(new Error("fake-secret cancellation"));
			return Response.json(payload());
		});
		await expect(copilot.getUsage({ settings: {}, signal: controller.signal })).rejects.toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
	});

	it("expands a home-relative auth path", async () => {
		await copilot.getUsage({ settings: { authPath: "~/private/auth.json" } });
		expect(auth.mock.calls[0][1]).toBe(join(homedir(), "private", "auth.json"));
	});

	it("sets a ten-second request deadline", async () => {
		vi.useFakeTimers();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		request.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(new Error("fake-secret timeout")), { once: true });
		}));
		const usage = copilot.getUsage({ settings: {} });
		const rejection = expect(usage).rejects.toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
		await vi.advanceTimersByTimeAsync(10_000);
		await rejection;
		expect(timeout).toHaveBeenCalledWith(10_000);
	});

	it("does not read credentials or call fetch after cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("fake-secret"));
		await expect(copilot.getUsage({ settings: {}, signal: controller.signal })).rejects.toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
		expect(auth).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("propagates in-flight cancellation to the request signal", async () => {
		const controller = new AbortController();
		request.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(new Error("fake-secret")), { once: true });
		}));
		const usage = copilot.getUsage({ settings: {}, signal: controller.signal });
		controller.abort();
		await expect(usage).rejects.toMatchObject({ code: "unavailable", message: "Copilot quota: unavailable" });
		expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
	});
});
