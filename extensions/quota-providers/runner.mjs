#!/usr/bin/env node
/**
 * Quota-providers out-of-band runner — invoked by the quota-providers extension.
 *
 * Provider I/O is isolated in four subcommands:
 *
 *   token --module <implPath> --impl <implId> --config <configPath> --cache <cacheFilePath>
 *     Print a valid access token to stdout. Self-caching with soft/hard margins.
 *
 *   refresh-token --module <implPath> --impl <implId> --config <configPath> --cache <cacheFilePath>
 *     Background refresh subcommand — no stdout. Used by detached self-spawns.
 *
 *   discover --module <implPath> --impl <implId> --config <configPath> --cache <cacheFilePath>
 *     Discover models via the impl and write { writtenAt, models } to --cache.
 *
 *   usage --module <implPath> --impl <implId> --config <configPath> --cache <cacheFilePath>
 *          --max-poll-seconds <n> --ledger <ledgerPath>
 *     Fetch usage snapshot, write to --cache, prune the ledger. Lock-protected.
 *
 * Plain Node ESM; shared snapshot validation is loaded through jiti like impl modules.
 */

import { closeSync, openSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Token cache margins
// ---------------------------------------------------------------------------

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const TOKEN_HARD_MARGIN_MS = 30 * 1000;         // never use a token within 30 s of expiry

// ---------------------------------------------------------------------------
// Core policy keys are excluded from implementation settings.
// Keep in sync with POLICY_KEYS in extensions/quota-providers/lib/config.ts.
// ---------------------------------------------------------------------------

const POLICY_KEYS = [
	"module",
	"enabled",
	"bypassAllowed",
	"lookaheadHours",
	"maxPollSeconds",
	"enforceHardCap",
];

// ---------------------------------------------------------------------------
// Lock helper — O_EXCL acquire with stale-steal and spin-retry.
// Used for the short-lived ledger lock; usage polls use a nonblocking lock.
// Returns an object with a release() method.
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 60_000;

function acquireLockSync(lockPath) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		let fd;
		try {
			fd = openSync(lockPath, "wx");
		} catch (err) {
			if (err?.code !== "EEXIST") {
				// Unexpected error — proceed without lock.
				return { release: () => {} };
			}
			// Lock exists — check staleness.
			let mtime;
			try {
				mtime = statSync(lockPath).mtimeMs;
			} catch {
				continue; // lock vanished between EEXIST and stat — retry
			}
			if (Date.now() - mtime >= LOCK_STALE_MS) {
				try { unlinkSync(lockPath); } catch { /* already gone */ }
				continue;
			}
			// Fresh lock — spin up to 5 ms, then retry.
			const spinEnd = Date.now() + 5;
			while (Date.now() < spinEnd) { /* busy spin */ }
			continue;
		}
		// Acquired — write pid and close the fd.
		try { writeFileSync(fd, String(process.pid), "utf-8"); } catch { /* non-fatal */ }
		try { closeSync(fd); } catch { /* non-fatal */ }
		return { release: () => { try { unlinkSync(lockPath); } catch { /* already gone */ } } };
	}
	// Timed out — proceed without lock (better than blocking indefinitely).
	return { release: () => {} };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fail(msg) {
	process.stderr.write(`quota-providers-runner: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--module")           out.module           = argv[++i];
		else if (arg === "--impl")        out.impl             = argv[++i];
		else if (arg === "--config")      out.config           = argv[++i];
		else if (arg === "--cache")       out.cache            = argv[++i];
		else if (arg === "--max-poll-seconds") out.maxPollSeconds = Number(argv[++i]);
		else if (arg === "--ledger")      out.ledger           = argv[++i];
	}
	return out;
}

/** Atomic replace: write to a unique temp in the same dir, then rename. */
function writeAtomic(path, data) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Impl loading
// ---------------------------------------------------------------------------

async function loadImpl(modulePath) {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const loaded = await jiti.import(modulePath);
	return loaded?.default ?? loaded;
}

function buildSettings(configPath, implId) {
	if (!configPath || !existsSync(configPath)) return {};
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return {};
	}
	const block = parsed?.providers?.[implId];
	if (typeof block !== "object" || block === null || Array.isArray(block)) return {};
	const policyKeySet = new Set(POLICY_KEYS);
	const settings = {};
	for (const [k, v] of Object.entries(block)) {
		if (!policyKeySet.has(k)) settings[k] = v;
	}
	return settings;
}

// ---------------------------------------------------------------------------
// Token caching — ported from foundry-helper.mjs
// Cache shape: { accessToken, softExpiresAt, hardExpiresAt }
// ---------------------------------------------------------------------------

function readCachedToken(cachePath) {
	if (!cachePath || !existsSync(cachePath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
		if (
			typeof parsed?.accessToken === "string" &&
			typeof parsed?.softExpiresAt === "number" &&
			typeof parsed?.hardExpiresAt === "number"
		) {
			return parsed;
		}
	} catch {
		// torn/garbage cache — treat as miss
	}
	return null;
}

async function refreshTokenSync(cachePath, prior, impl, ctx) {
	let result;
	try {
		result = await impl.getToken(ctx);
	} catch (err) {
		if (prior) return prior.accessToken;
		fail(`token: impl.getToken failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (result == null) {
		if (prior) return prior.accessToken;
		fail("token: impl.getToken returned null/undefined");
	}

	const { token, expiresAt } = result;
	if (!token) fail("token: impl.getToken returned no token");
	if (typeof expiresAt !== "number" || Number.isNaN(expiresAt)) {
		fail(`token: impl.getToken returned invalid expiresAt: ${expiresAt}`);
	}

	const softExpiresAt = expiresAt - TOKEN_REFRESH_MARGIN_MS;
	const hardExpiresAt = expiresAt - TOKEN_HARD_MARGIN_MS;

	try {
		writeAtomic(cachePath, JSON.stringify({ accessToken: token, softExpiresAt, hardExpiresAt }));
	} catch {
		// Non-fatal: still return the token even if the cache write failed.
	}
	return token;
}

/** Fire-and-forget self-spawn that re-runs this helper as `refresh-token` and detaches. */
function spawnRefreshDetached(args) {
	try {
		const child = spawn(
			process.execPath,
			[process.argv[1], "refresh-token", ...args],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
	} catch {
		// best-effort
	}
}

async function cmdToken(flags, impl, ctx) {
	const { cache } = flags;
	if (!cache) fail("token: --cache <path> is required");

	const now = Date.now();
	const cached = readCachedToken(cache);

	if (cached && now < cached.hardExpiresAt) {
		// Cached token still safe — return immediately.
		process.stdout.write(cached.accessToken);
		// Past soft margin? Kick a background refresh for next request.
		if (now >= cached.softExpiresAt) {
			spawnRefreshDetached(buildPassthroughArgs(flags));
		}
		return;
	}

	// Hard-expired or missing — must block.
	const token = await refreshTokenSync(cache, cached, impl, ctx);
	process.stdout.write(token);
}

async function cmdRefreshToken(flags, impl, ctx) {
	const { cache } = flags;
	if (!cache) fail("refresh-token: --cache <path> is required");
	const cached = readCachedToken(cache);
	await refreshTokenSync(cache, cached, impl, ctx);
}

/** Reconstruct passthrough args for the detached refresh-token self-spawn. */
function buildPassthroughArgs(flags) {
	const args = [];
	if (flags.module)  args.push("--module",  flags.module);
	if (flags.impl)    args.push("--impl",    flags.impl);
	if (flags.config)  args.push("--config",  flags.config);
	if (flags.cache)   args.push("--cache",   flags.cache);
	return args;
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

async function cmdDiscover(flags, impl, ctx) {
	const { cache } = flags;
	if (!cache) fail("discover: --cache <path> is required");
	if (typeof impl.discoverModels !== "function") {
		fail("discover: impl does not export discoverModels");
	}

	let models;
	try {
		models = await impl.discoverModels(ctx);
	} catch (err) {
		fail(`discover: impl.discoverModels failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!Array.isArray(models)) {
		fail("discover: impl.discoverModels did not return an array");
	}

	writeAtomic(cache, JSON.stringify({ writtenAt: Date.now(), models }));
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

async function cmdUsage(flags, impl, ctx) {
	const { cache, ledger } = flags;
	const providerAccounting = impl.accounting === "provider" || (impl.accounting === undefined && typeof impl.nativeProviderId === "string");
	const maxPollSeconds = Number.isFinite(flags.maxPollSeconds) && flags.maxPollSeconds >= 1 ? flags.maxPollSeconds : 300;
	if (!cache) fail("usage: --cache <path> is required");
	if (!ledger && !providerAccounting) fail("usage: --ledger <path> is required");
	if (typeof impl.getUsage !== "function") fail("usage: impl does not export getUsage");

	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const { readUsageSnapshot, usageRefreshDue, projectUsageSnapshots, usageErrorCode } =
		await jiti.import(new URL("./lib/snapshot.ts", import.meta.url).href);
	mkdirSync(dirname(cache), { recursive: true });
	const lockPath = `${cache}.lock`;
	let lockFd;
	try {
		lockFd = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		try {
			if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return;
			unlinkSync(lockPath);
			lockFd = openSync(lockPath, "wx", 0o600);
		} catch { return; }
	}
	closeSync(lockFd);
	try {
		const prior = readUsageSnapshot(cache);
		if (!usageRefreshDue(prior, maxPollSeconds)) return;
		let snapshots;
		try {
			const signal = ctx.signal
				? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
				: AbortSignal.timeout(30_000);
			signal.throwIfAborted();
			const result = await impl.getUsage({ ...ctx, signal });
			signal.throwIfAborted();
			snapshots = projectUsageSnapshots(Array.isArray(result) ? result : [result]);
			if (!snapshots) throw { code: "invalid-response" };
		} catch (error) {
			writeAtomic(cache, JSON.stringify({
				writtenAt: prior?.writtenAt ?? 0,
				attemptedAt: Date.now(),
				snapshots: prior?.snapshots ?? [],
				error: usageErrorCode(error),
			}));
			throw new Error("usage refresh failed");
		}
		writeAtomic(cache, JSON.stringify({
			writtenAt: Date.now(), attemptedAt: Date.now(), snapshots,
			...(snapshots.length === 1 ? { snapshot: snapshots[0] } : {}),
		}));

		// Provider-authoritative accounting never adds or prunes catalog-price estimates.
		if (providerAccounting || snapshots.length === 0) return;
		const asOf = Math.min(...snapshots.map((snapshot) => snapshot.asOf));
		const ledgerLock = acquireLockSync(`${ledger}.lock`);
		try {
			if (!existsSync(ledger)) return;
			const kept = readFileSync(ledger, "utf8").split("\n").filter((line) => {
				if (!line.trim()) return false;
				try {
					const entry = JSON.parse(line);
					return typeof entry.timestamp !== "number" || entry.timestamp > asOf;
				} catch { return true; }
			}).join("\n");
			writeAtomic(ledger, kept ? kept + "\n" : "");
		} finally {
			ledgerLock.release();
		}
	} finally {
		try { unlinkSync(lockPath); } catch { /* already released */ }
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

const modulePath = flags.module;
const implId    = flags.impl;

if (!modulePath) fail(`${cmd ?? "?"}: --module <implPath> is required`);
if (!implId)     fail(`${cmd ?? "?"}: --impl <implId> is required`);

const impl = await loadImpl(modulePath);
if (!impl || typeof impl !== "object") {
	fail(`could not load impl from "${modulePath}" — default export must be an object`);
}

const settings = buildSettings(flags.config, implId);
const ctx = { settings };

switch (cmd) {
	case "token":
		await cmdToken(flags, impl, ctx);
		break;
	case "refresh-token":
		await cmdRefreshToken(flags, impl, ctx);
		break;
	case "discover":
		await cmdDiscover(flags, impl, ctx);
		break;
	case "usage":
		try { await cmdUsage(flags, impl, ctx); }
		catch { fail("usage: getUsage refresh failed"); }
		break;
	default:
		fail(`unknown command "${cmd ?? ""}" (expected: token | refresh-token | discover | usage)`);
}
