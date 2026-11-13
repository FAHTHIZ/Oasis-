import { describe, expect, it } from "vitest";
import { admitsUnverified, claimedFailedEdits, claimsPassing } from "../src/core/claims.ts";

describe("claims", () => {
	it.each([
		"All tests pass.",
		"The build succeeded.",
		"12 passed, 0 failed",
		"Tests are green now.",
		"I ran npm test and they all passed.",
	])("%s claims passing", (t) => expect(claimsPassing(t)).toBe(true));
	it.each(["Two tests fail.", "I could not run the tests.", "Updated the README.", "", "The tests did not pass."])(
		"%s does not claim passing",
		(t) => expect(claimsPassing(t)).toBe(false),
	);
	it("spots honest admissions", () => {
		expect(admitsUnverified("I did not run the tests; please run npm test.")).toBe(true);
		expect(admitsUnverified("There are no tests in this project.")).toBe(true);
		expect(admitsUnverified("Done.")).toBe(false);
	});
	it("finds claimed changes to files whose edit failed", () => {
		const failed = new Map([["src/notes.txt", "File has not been read yet"]]);
		expect(claimedFailedEdits("Updated notes.txt with the new section.", failed)).toEqual(["src/notes.txt"]);
		expect(claimedFailedEdits("I could not update notes.txt because the edit failed.", failed)).toEqual([]);
		expect(claimedFailedEdits("Updated README.md.", failed)).toEqual([]);
	});
});
