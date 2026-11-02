import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectUsageSnapshots, readUsageSnapshot, usageErrorCode, usageRefreshDue } from "./snapshot.js";

const now = Date.UTC(2026, 9, 15);
const windowEnd = Date.UTC(2026, 10, 1);
const snapshot = { spend: 25.25, quota: 100, windowStart: Date.UTC(2026, 9, 1), windowEnd, asOf: now };
let dir: string;
let path: string;
beforeEach(() => {
	vi.useFakeTimers(); vi.setSystemTime(now);
	dir = mkdtempSync(join(tmpdir(), "usage-snapshot-")); path = join(dir, "usage.json");
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("shared usage snapshot cache", () => {
	it("reads old single-snapshot files and projects only allowed fields", () => {
		writeFileSync(path, JSON.stringify({ writtenAt: now, snapshot: { ...snapshot, token: "secret" } }));
		expect(readUsageSnapshot(path)).toEqual({ writtenAt: now, snapshots: [snapshot], snapshot });
		expect(projectUsageSnapshots([{ ...snapshot, token: "secret" }])).toEqual([snapshot]);
	});

	it.each([NaN, Infinity, -1])("rejects invalid billing values %s", (bad) => {
		expect(projectUsageSnapshots([{ ...snapshot, spend: bad }])).toBeUndefined();
		expect(projectUsageSnapshots([{ ...snapshot, quota: bad }])).toBeUndefined();
	});

	it("rejects invalid windows, timestamps, labels and oversized/corrupt caches", () => {
		expect(projectUsageSnapshots([{ ...snapshot, windowEnd: snapshot.windowStart }])).toBeUndefined();
		expect(projectUsageSnapshots([{ ...snapshot, windowEnd: 9e15 }])).toBeUndefined();
		expect(projectUsageSnapshots([{ ...snapshot, label: "bad\u001b[0m" }])).toBeUndefined();
		writeFileSync(path, JSON.stringify({ writtenAt: now + 61_000, snapshots: [snapshot] }));
		expect(readUsageSnapshot(path)).toBeNull();
		writeFileSync(path, " ".repeat(129 * 1024));
		expect(readUsageSnapshot(path)).toBeNull();
		writeFileSync(path, "invalid JSON");
		expect(readUsageSnapshot(path)).toBeNull();
	});

	it("recognizes known error codes without persisting exception messages", () => {
		expect(usageErrorCode(new Error("token=secret"))).toBe("unavailable");
		expect(usageErrorCode({ code: "unsupported-billing", message: "secret" })).toBe("unsupported-billing");
		writeFileSync(path, JSON.stringify({ writtenAt: now, attemptedAt: now, snapshots: [snapshot], error: "raw-secret" }));
		expect(readUsageSnapshot(path)?.error).toBe("unavailable");
	});

	it("keeps empty quota sets valid for explicitly unlimited providers", () => {
		writeFileSync(path, JSON.stringify({ writtenAt: now, snapshots: [] }));
		expect(readUsageSnapshot(path)?.snapshots).toEqual([]);
	});

	it("refreshes at poll floor or once after reset and backs off failure attempts", () => {
		const cache = { writtenAt: now, snapshots: [snapshot] };
		expect(usageRefreshDue(cache, 300, now + 299_000)).toBe(false);
		expect(usageRefreshDue(cache, 300, now + 300_000)).toBe(true);
		expect(usageRefreshDue({ ...cache, writtenAt: windowEnd - 1000 }, 300, windowEnd)).toBe(true);
		expect(usageRefreshDue({ ...cache, attemptedAt: windowEnd + 1, error: "unavailable" }, 300, windowEnd + 1000)).toBe(false);
		expect(usageRefreshDue(cache, NaN, now + 1000)).toBe(false);
		expect(usageRefreshDue({ ...cache, writtenAt: now + 10 }, 300, now)).toBe(true);
	});
});
