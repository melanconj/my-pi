import { InMemoryCredentialStore, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { guardStream, guardStreamSimple } from "./stream-guard.js";

type QuotaEvaluator = Parameters<typeof guardStreamSimple>[1];

/** Obtain the host's native/catalog layers without capturing a session's models.json overrides. */
export async function createGuardedNativeProvider(
	providerId: string,
	evaluate: QuotaEvaluator,
): Promise<Provider> {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const base = runtime.getProvider(providerId);
	if (!base) throw new Error(`Unknown native quota provider: ${providerId}`);
	return {
		...base,
		stream: guardStream<StreamOptions>(base.stream.bind(base), evaluate),
		streamSimple: guardStreamSimple(base.streamSimple.bind(base), evaluate),
	};
}
