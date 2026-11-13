import { describe, expect, it } from "vitest";
import { acpEnv } from "../src/acp.ts";

describe("oasis acp", () => {
	it("points the adapter at the OASIS binary and agent dir without overriding the user's choice", () => {
		const env = acpEnv({}, "/home/u/.oasis/agent", "file:///opt/oasis/dist/acp-x.mjs");
		expect(env).toEqual({ PI_ACP_PI_COMMAND: "/opt/oasis/bin/oasis.mjs", PI_CODING_AGENT_DIR: "/home/u/.oasis/agent" });
		expect(acpEnv({ PI_ACP_PI_COMMAND: "/x/oasis", PI_CODING_AGENT_DIR: "/d" }, "/a")).toEqual({});
	});
});
