import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(), execFileSync: vi.fn(), importImpl: vi.fn(), nativeFactory: vi.fn(), transport: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFileSync: mocks.execFileSync }));
vi.mock("jiti", () => ({ createJiti: () => ({ import: mocks.importImpl }) }));
vi.mock("./lib/native-provider.js", () => ({ createGuardedNativeProvider: mocks.nativeFactory }));

import quotaExtension, { refreshStatusline } from "./index.js";
import { guardStreamSimple } from "./lib/stream-guard.js";
import { readLedger } from "./lib/ledger.js";
import { createSessionTreeStore, getOrCreateSessionTreeStore, registerSessionIdTreeStore, unregisterSessionIdTreeStore } from "../subagents/scoped-store.js";
import type { UsageSnapshot } from "./lib/types.js";

type Handler = (event: any, ctx: any) => any;
let dir: string;
let handlers: Record<string, Handler>;
let commands: Record<string, { handler: (args: string, ctx: any) => any }>;
let pi: any;
let ctx: any;
let nativeRegistrations: Map<string, any>;
const now = Date.UTC(2026, 9, 10);
const model = { id: "copilot-model", provider: "github-copilot" };
const snapshot: UsageSnapshot = { spend: 90, quota: 100, windowStart: Date.UTC(2026, 9, 1), windowEnd: Date.UTC(2026, 10, 1), asOf: now };
const nativeImpl = { id: "github-copilot", nativeProviderId: "github-copilot", getUsage: vi.fn() };

function paths(id = "copilot") { return join(dir, "cache", "quota-providers", id); }
function configure(settings = {}, id = "copilot") {
	writeFileSync(join(dir, "quota-providers.json"), JSON.stringify({ providers: { [id]: { module: "builtin:copilot", ...settings } } }));
}
function saveSnapshots(snapshots: UsageSnapshot[] = [snapshot], id = "copilot") {
	mkdirSync(paths(id), { recursive: true });
	writeFileSync(join(paths(id), "usage.json"), JSON.stringify({ writtenAt: Date.now(), snapshots }));
}
function registered() { return pi.registerProvider.mock.calls[0][0]; }
function request(sessionId = "root-session") { return registered().streamSimple(model, { messages: [] }, { sessionId }); }

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "quota-index-test-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	configure();
	handlers = {};
	commands = {};
	nativeRegistrations = new Map();
	pi = {
		on: (name: string, handler: Handler) => { handlers[name] = handler; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		registerProvider: vi.fn((provider) => { if (typeof provider === "object") nativeRegistrations.set(provider.id, provider); }),
		unregisterProvider: vi.fn((id) => nativeRegistrations.delete(id)),
	};
	ctx = {
		hasUI: true, model, sessionManager: { getSessionId: () => "root-session" },
		modelRegistry: { getRegisteredNativeProvider: (id: string) => nativeRegistrations.get(id) },
		ui: { setStatus: vi.fn(), notify: vi.fn() },
	};
	mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }));
	mocks.transport.mockReturnValue({ fakeStream: true });
	mocks.nativeFactory.mockImplementation(async (id, gate) => ({ id, streamSimple: guardStreamSimple(mocks.transport, gate) }));
	mocks.importImpl.mockResolvedValue({ default: nativeImpl, parseQuota: vi.fn() });
});
afterEach(() => {
	handlers.session_shutdown?.({}, ctx);
	unregisterSessionIdTreeStore("child-session");
	unregisterSessionIdTreeStore("other-root");
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("refreshStatusline", () => {
	it("does not throw when an embedding host supplies a partial UI context", () => {
		expect(() => refreshStatusline(undefined, { hasUI: true, ui: {} } as any)).not.toThrow();
	});
});

describe("native quota provider wiring", () => {
	it("loads a default export with named helpers and registers only the guarded native ID", async () => {
		await quotaExtension(pi);
		expect(pi.registerProvider).toHaveBeenCalledOnce();
		expect(registered().id).toBe("github-copilot");
		expect(mocks.execFileSync).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("starts detached activity-driven usage refreshes only when the common cache is due", async () => {
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("quota-providers", "quota: fetching usage…");
		expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["usage", "--cache", join(paths(), "usage.json")]), {
			detached: true, stdio: "ignore", timeout: 35_000,
		});
		mocks.spawn.mockClear();
		saveSnapshots([{ ...snapshot, spend: 1 }]);
		handlers.input({}, ctx);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("quota-providers", expect.stringContaining("$1/$100"));
		vi.setSystemTime(now + 300_000);
		handlers.input({}, ctx);
		expect(mocks.spawn).toHaveBeenCalledOnce();
	});

	it("applies bypass immediately to the requesting tree, including compaction fallback IDs", async () => {
		saveSnapshots();
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		registerSessionIdTreeStore("child-session", getOrCreateSessionTreeStore(ctx.sessionManager));
		registerSessionIdTreeStore("other-root", createSessionTreeStore());
		expect(() => request()).toThrow(/quota soft cap exceeded.*\/quota bypass on/);
		expect(mocks.transport).not.toHaveBeenCalled();
		await commands.quota.handler("bypass on", ctx);
		expect(request("child-session")).toEqual({ fakeStream: true });
		expect(() => request("other-root")).toThrow(/quota soft cap exceeded/);
		expect(() => request("compaction-routing-id")).not.toThrow();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("quota-providers", expect.stringContaining("bypassed"));
		await commands.quota.handler("bypass off", ctx);
		expect(() => request("child-session")).toThrow(/quota soft cap exceeded/);
	});

	it("does not let bypass disable an enforced hard cap", async () => {
		configure({ enforceHardCap: true });
		saveSnapshots([{ ...snapshot, spend: 100 }]);
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		await commands.quota.handler("bypass on", ctx);
		expect(() => request()).toThrow(/quota hard cap exceeded/);
		expect(mocks.transport).not.toHaveBeenCalled();
	});

	it("refuses bypass when disabled by configuration", async () => {
		configure({ bypassAllowed: false });
		saveSnapshots();
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		await commands.quota.handler("bypass on", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Bypass is disabled"), "warning");
		expect(() => request()).toThrow(/quota soft cap exceeded/);
	});

	it.each([
		["missing", undefined],
		["unlimited", []],
		["expired", [{ ...snapshot, windowEnd: now - 1, asOf: now - 1000 }]],
	] as const)("does not block when the usage window is %s", async (_name, snapshots) => {
		if (snapshots) saveSnapshots([...snapshots]);
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		expect(request()).toEqual({ fakeStream: true });
	});

	it.each([
		["native", undefined, false],
		["native", "ledger", true],
		["managed", undefined, true],
		["managed", "provider", false],
	] as const)("uses %s accounting=%s for both cached costs and new messages", async (kind, accounting, usesLedger) => {
		const id = kind === "native" ? "copilot" : "gateway";
		configure({ enforceHardCap: true }, id);
		mocks.importImpl.mockResolvedValue(kind === "native"
			? { ...nativeImpl, accounting }
			: { id: "gateway", baseUrl: "https://example.test", getUsage: vi.fn(), accounting });
		saveSnapshots([{ ...snapshot, spend: 1 }], id);
		const ledgerPath = join(paths(id), "ledger.jsonl");
		writeFileSync(ledgerPath, JSON.stringify({ timestamp: now + 1, cost: 999 }) + "\n");
		if (kind === "managed") {
			writeFileSync(join(paths(id), "models.json"), JSON.stringify({ writtenAt: now, models: [{ id: "m", modelName: "m", api: "openai-completions" }] }));
			ctx.model = { id: "m", provider: "gateway-openai-completions" };
		}
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("quota-providers", expect.stringContaining(usesLedger ? "$1000/$100" : "$1/$100"));
		if (kind === "native") {
			if (usesLedger) expect(() => request()).toThrow(/quota/);
			else expect(() => request()).not.toThrow();
		}
		handlers.message_end({ message: { role: "assistant", provider: ctx.model.provider, model: ctx.model.id, timestamp: now + 2, usage: { cost: { total: 2 } } } }, ctx);
		expect(readLedger(ledgerPath)).toHaveLength(usesLedger ? 2 : 1);
	});

	it("unregisters only its own native override on shutdown", async () => {
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		handlers.session_shutdown({}, ctx);
		expect(pi.unregisterProvider).toHaveBeenCalledExactlyOnceWith("github-copilot");
	});

	it("leaves a later override owned by another extension alone", async () => {
		await quotaExtension(pi);
		const laterOverride = { ...registered(), name: "Other extension" };
		nativeRegistrations.set("github-copilot", laterOverride);
		handlers.session_shutdown({}, ctx);
		expect(pi.unregisterProvider).not.toHaveBeenCalled();
		expect(nativeRegistrations.get("github-copilot")).toBe(laterOverride);
	});

	it("respects enabled:false", async () => {
		configure({ enabled: false });
		await quotaExtension(pi);
		handlers.session_start({}, ctx);
		expect(mocks.importImpl).not.toHaveBeenCalled();
		expect(mocks.nativeFactory).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
