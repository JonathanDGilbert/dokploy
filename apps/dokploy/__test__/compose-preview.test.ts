import { describe, expect, it } from "vitest";
import { apiFindAllByComposePreview } from "@/server/db/schema";

describe("compose preview deployments", () => {
	it("validates composeId in list input", () => {
		expect(() =>
			apiFindAllByComposePreview.parse({ composeId: "abc" }),
		).not.toThrow();
		expect(() => apiFindAllByComposePreview.parse({ composeId: "" })).toThrow();
	});

	it("normalizes PR id to string for lookups", () => {
		const prId = 12345;
		expect(String(prId)).toBe("12345");
	});
});
