import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/** The result of evaluating quota immediately before a provider request. */
export type QuotaGateResult =
	| { blocked: false }
	| { blocked: true; kind: "soft" | "hard"; message: string }
	| undefined;

export type ProviderStreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

type StreamArgs = Parameters<ProviderStreamSimple>;

/**
 * Wrap a provider stream so quota enforcement happens before the underlying
 * provider is invoked. This is deliberately below session/input handling:
 * custom extension messages, tool-loop continuations, retries, and compaction
 * can all start a provider request without emitting an `input` event.
 *
 * The gate receives the request options because `options.sessionId` is the only
 * identity available at this boundary — the closure may belong to any session.
 */
export function guardStreamSimple(
	fallback: ProviderStreamSimple,
	evaluate: (model: StreamArgs[0], options: StreamArgs[2]) => QuotaGateResult,
): ProviderStreamSimple {
	return (model, context, options) => {
		const decision = evaluate(model, options);
		if (decision?.blocked) throw new Error(decision.message);
		return fallback(model, context, options);
	};
}
