import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { safetyExtension } from "./safety.ts";
import { createTurnGatesExtension } from "./turn-gates.ts";

/** The OASIS extension set, loaded into every session. */
export function oasisExtensions(): InlineExtension[] {
	return [
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
	];
}
