import { describe, expect, it, vi } from "vitest";
import { guardStreamSimple } from "./stream-guard.js";

const model = {
	api: "openai-responses",
	provider: "quota-provider",
	id: "model",
} as any;

const context = { messages: [], tools: [] } as any;

describe("guardStreamSimple", () => {
	it("blocks an extension-triggered turn before the fallback provider is called", () => {
		const fallback = vi.fn(() => undefined as any);
		const guarded = guardStreamSimple(
			fallback,
			() => ({ blocked: true, kind: "soft", message: "quota soft cap exceeded" }),
		);

		expect(() => guarded(model, context)).toThrow("quota soft cap exceeded");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("passes the request options to the gate so it can resolve the requesting tree", () => {
		const fallback = vi.fn(() => "stream" as any);
		const evaluate = vi.fn(() => undefined);
		const guarded = guardStreamSimple(fallback, evaluate);

		guarded(model, context, { sessionId: "session-1" } as any);

		expect(evaluate).toHaveBeenCalledWith(model, { sessionId: "session-1" });
	});

	it("evaluates the gate on every request so bypass takes effect immediately", () => {
		const fallback = vi.fn(() => "stream" as any);
		let blocked = true;
		const guarded = guardStreamSimple(
			fallback,
			() => blocked
				? { blocked: true, kind: "soft", message: "quota soft cap exceeded" }
				: undefined,
		);

		expect(() => guarded(model, context)).toThrow();
		blocked = false;
		expect(guarded(model, context)).toBe("stream");
		expect(fallback).toHaveBeenCalledTimes(1);
	});
});
