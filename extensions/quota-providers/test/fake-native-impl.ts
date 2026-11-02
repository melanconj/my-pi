import managed from "./fake-impl.js";
import type { NativeProviderImplementation } from "../lib/types.js";

const native: NativeProviderImplementation = {
	id: "native-fake",
	nativeProviderId: "github-copilot",
	getUsage: managed.getUsage!,
};

export default native;
