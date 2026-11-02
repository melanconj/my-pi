import { describe, expect, it } from "vitest";
import { refreshStatusline } from "./index.js";

describe("refreshStatusline", () => {
	it("does not throw when an embedding host supplies a partial UI context", () => {
		expect(() => refreshStatusline(undefined, { hasUI: true, ui: {} } as any)).not.toThrow();
	});
});
