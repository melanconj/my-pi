import type { Api, Model } from "@earendil-works/pi-ai";

// Seam types — the interface between the core and out-of-repo implementations.
// Out-of-repo implementations import only via `import type` so there is no
// runtime path coupling to this repo.

/** Shared quota seams for managed gateways and existing native providers. */
export interface QuotaImplementation {
  id: string;
  name?: string;
  /** Catalog costs may differ from billing. Default: ledger for gateways, provider for native. */
  accounting?: "ledger" | "provider";
  /** Report authoritative dollar windows. Absent means no quota enforcement. */
  getUsage?(ctx: ImplContext): Promise<UsageSnapshot | UsageSnapshot[]>;
}

/** Preserve a built-in native provider's auth, discovery, and transport. */
export interface NativeProviderImplementation extends QuotaImplementation {
  nativeProviderId: string;
  getUsage(ctx: ImplContext): Promise<UsageSnapshot | UsageSnapshot[]>;
}

/** Default export for an implementation that owns model discovery and auth. */
export interface ProviderImplementation extends QuotaImplementation {
  /** Base endpoint, e.g. "https://x.services.ai.azure.com". */
  baseUrl: string;
  /** Whether pi should add `Authorization: Bearer <token>`. May vary per model via ModelEntry. */
  authHeader?: boolean;
  /** Extra request headers merged into every request for this provider's models.
   *  Overrides SDK defaults (e.g. `user-agent`) — useful for gateways that filter
   *  on the vendor SDK's default User-Agent. Applies to all models of the impl. */
  headers?: Record<string, string>;

  /** Seam 1: fetch the raw model list. Runs out-of-band in the runner. */
  discoverModels(ctx: ImplContext): Promise<ModelEntry[]>;
  /** Seam 2: fetch a fresh token. Runs out-of-band in the runner; core owns caching/margins. */
  getToken(ctx: ImplContext): Promise<TokenResult>;

  /**
   * Classify a terminal provider error as transient and worth retrying.
   * Runs on the request hot path: keep it cheap and never throw.
   * Matching errors are rewritten into pi's retryable vocabulary and use
   * settings.retry backoff. Absent leaves pi's classification unchanged.
   */
  isRetryableError?: (message: string) => boolean;
}

/**
 * Optional per-model metadata. Every field is optional and merges field-wise
 * (`??`) over the catalog-resolved value (or the conservative default), so a
 * partial entry — only the fields the deployment gets wrong or the catalog
 * can't know — is the norm. `cost` merges per sub-field; object fields
 * (`thinkingLevelMap`, `compat`) replace the resolved value wholesale.
 */
export interface ModelMetadataOverrides {
	/** Whether the model supports extended thinking. */
	reasoning?: boolean;
	/** Supported input modalities. */
	input?: ("text" | "image")[];
	/** Maximum context window in tokens. */
	contextWindow?: number;
	/** Maximum output tokens. */
	maxTokens?: number;
	/** Per-million-token cost rates — partial objects merge per sub-field. */
	cost?: Partial<Model<Api>["cost"]>;
	/** Maps pi thinking levels to model-specific values. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Compatibility flags. */
	compat?: Model<Api>["compat"];
	/** Overrides the catalog-derived forceAdaptiveThinking flag (anthropic-messages only). */
	forceAdaptiveThinking?: boolean;
	/** Provider input limits and cache-safe image preprocessing metadata. */
	inputLimits?: Model<Api>["inputLimits"];
	/** Best-effort prompt cache lifetime in seconds per retention tier. */
	promptCache?: Model<Api>["promptCache"];
	/** Per-model request headers. */
	headers?: Record<string, string>;
	/** Sampling parameters merged into requests for this model. */
	samplingParams?: Record<string, unknown>;
}

export interface ModelEntry extends ModelMetadataOverrides {
  /** Model/deployment id sent to the API. */
  id: string;
  /** Optional display name; defaults to id. */
  name?: string;
  /** Catalog key for pi-ai metadata lookup (context window, cost, compat).
   *  The resolved values are overridden field-wise by any metadata fields on
   *  this entry. */
  modelName: string;
  /** Full pi-ai Api union — core passes it through to pi.registerProvider. */
  api: Api;
  /** Which pi-ai catalog provider to resolve modelName against (e.g. "anthropic",
   *  "azure"). Absent or miss → conservative defaults. */
  catalogProvider?: string;
  /** Appended to baseUrl for this model's backend, e.g. "/anthropic". */
  baseUrlPath?: string;
  /** Per-model authHeader override. */
  authHeader?: boolean;
  /** Opaque quota limit IDs assigned to this model by its provider implementation. */
  quotaLimitIds?: string[];
}

export interface TokenResult {
  token: string;
  /** Epoch ms. Core applies soft/hard refresh margins and caching. */
  expiresAt: number;
}

export interface UsageSnapshot {
  /** Optional limit ID. Omitted applies to every model on the provider. */
  limitId?: string;
  /** Short label for the quota window shown in status output. */
  label?: string;
  /** Window-to-date spend, dollars. */
  spend: number;
  /** Window hard limit, dollars. */
  quota: number;
  /** Epoch ms. */
  windowStart: number;
  /** Epoch ms — reset time. */
  windowEnd: number;
  /** Epoch ms. Semantics: `spend` is authoritative up to this time. Real-time
   *  providers return `now`; providers with laggy reporting return
   *  `now − lagEstimate`. Drives ledger pruning. */
  asOf: number;
}

export interface ImplContext {
  /** The implementation's config block (impl-specific settings pass through untouched). */
  settings: Record<string, unknown>;

  /**
   * Optional cancellation signal for the current operation. Seams that perform
   * blocking I/O (`discoverModels`, `getToken`, `getUsage`) should observe it
   * — bail on `signal?.aborted` and pass it to async underpinnings when
   * possible — so long-running work can be cancelled by the caller.
   * In-process callers may forward their operation signal; the usage worker
   * supplies a timeout signal. Other runner commands may omit it.
   */
  signal?: AbortSignal;
}

// Internal core types — used by quota-providers core, not exposed to impls.

export interface LedgerEntry {
  timestamp: number;
  cost: number;
  /** Opaque limit IDs assigned to the model that produced this cost. */
  quotaLimitIds?: string[];
}

export interface QuotaVerdict {
  state: "ok" | "soft-exceeded" | "hard-exceeded";
  /** How far ahead of budget, in days (can be negative = under budget). */
  daysAhead: number;
  /** Epoch ms — when the quota window resets. */
  resetAt: number;
}

export interface QuotaPolicy {
  bypassAllowed: boolean;
  lookaheadHours: number;
  maxPollSeconds: number;
  enforceHardCap: boolean;
}
