import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { safetyExtension } from "./safety.ts";
import { createVerificationExtension } from "./verification.ts";

/** The OASIS extension set, loaded into every session. */
export function oasisExtensions(): InlineExtension[] {
	return [
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-verification", factory: createVerificationExtension() },
	];
}
