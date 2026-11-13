import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { identityExtension } from "./identity.ts";
import { safetyExtension } from "./safety.ts";
import { createTurnGatesExtension } from "./turn-gates.ts";

/** The OASIS extension set, loaded into every session. */
export function oasisExtensions(): InlineExtension[] {
	return [
		{ name: "oasis-identity", factory: identityExtension },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
	];
}
