import { readFileSync, statSync } from "node:fs";
import type { UsageSnapshot } from "./types.js";

const ERROR_TEXT = {
  "not-authenticated": "sign in with /login",
  "unauthorized": "login expired or access denied",
  "rate-limited": "rate limited",
  "unavailable": "usage refresh failed",
  "invalid-response": "invalid usage response",
  "unsupported-account": "account or billing window unsupported",
  "unsupported-billing": "billing mode unsupported",
} as const;

export type UsageErrorCode = keyof typeof ERROR_TEXT;

export function usageErrorCode(error: unknown): UsageErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(ERROR_TEXT, code) ? code as UsageErrorCode : "unavailable";
}

export function usageErrorText(code: UsageErrorCode): string {
  return ERROR_TEXT[code];
}

export interface UsageSnapshotFile {
  writtenAt: number;
  attemptedAt?: number;
  error?: UsageErrorCode;
  snapshots: UsageSnapshot[];
  /** Backward-compatible alias populated when there is exactly one window. */
  snapshot?: UsageSnapshot;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return nonnegative(value) && value <= 8.64e15;
}

function label(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Validate and project only billing fields; arbitrary implementation output is not cached. */
export function projectUsageSnapshots(value: unknown): UsageSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return;
  const snapshots: UsageSnapshot[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    if (!nonnegative(raw.spend) || !nonnegative(raw.quota) || !timestamp(raw.windowStart) ||
      !timestamp(raw.windowEnd) || raw.windowEnd <= raw.windowStart || !timestamp(raw.asOf) ||
      (raw.limitId !== undefined && !label(raw.limitId)) || (raw.label !== undefined && !label(raw.label))) return;
    snapshots.push({
      spend: raw.spend, quota: raw.quota, windowStart: raw.windowStart, windowEnd: raw.windowEnd, asOf: raw.asOf,
      ...(raw.limitId !== undefined ? { limitId: raw.limitId } : {}),
      ...(raw.label !== undefined ? { label: raw.label } : {}),
    });
  }
  return snapshots;
}

export function readUsageSnapshot(path: string): UsageSnapshotFile | null {
  try {
    if (statSync(path).size > 128 * 1024) return null;
    const file = JSON.parse(readFileSync(path, "utf8"));
    if (!file || !timestamp(file.writtenAt) || file.writtenAt > Date.now() + 60_000) return null;
    if (file.attemptedAt !== undefined && (!timestamp(file.attemptedAt) || file.attemptedAt > Date.now() + 60_000)) return null;
    const snapshots = projectUsageSnapshots(file.snapshots ?? (file.snapshot ? [file.snapshot] : undefined));
    if (!snapshots) return null;
    return {
      writtenAt: file.writtenAt, snapshots,
      ...(file.attemptedAt !== undefined ? { attemptedAt: file.attemptedAt } : {}),
      ...(file.error !== undefined ? { error: usageErrorCode({ code: file.error }) } : {}),
      ...(snapshots.length === 1 ? { snapshot: snapshots[0] } : {}),
    };
  } catch {
    return null;
  }
}

/** Error attempts obey the same poll floor; a reset forces one immediate refresh. */
export function usageRefreshDue(cache: UsageSnapshotFile | null, maxPollSeconds: number, now = Date.now()): boolean {
  const seconds = Number.isFinite(maxPollSeconds) && maxPollSeconds >= 1 ? maxPollSeconds : 300;
  if (!cache) return true;
  const attemptedAt = cache.attemptedAt ?? cache.writtenAt;
  if (now < attemptedAt || now - attemptedAt >= seconds * 1000) return true;
  return cache.snapshots.some((snapshot) => snapshot.windowEnd <= now && attemptedAt < snapshot.windowEnd);
}
