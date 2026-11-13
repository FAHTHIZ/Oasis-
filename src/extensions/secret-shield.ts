/**
 * Secret shield: masks credentials in tool results as «secret:ID» before
 * they reach the model or the saved session, and swaps placeholders back to
 * real values in tool arguments right before execution. pi validates a copy
 * of the arguments, so the unmasked values never enter the transcript.
 *
 * Runs last, so hooks, safety and the sandbox see the placeholders, and it
 * masks whatever earlier tool_result handlers produced. Disable with
 * OASIS_SECRET_SHIELD=0.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultVault, NO_UNMASK_TOOLS, SECRET_SHIELD_NOTE, type SecretVault, secretShieldEnabled } from "../security/secrets.ts";

export interface SecretShieldOptions {
	vault?: SecretVault;
	env?: NodeJS.ProcessEnv;
}

function maskDeep(vault: SecretVault, value: unknown, count: { n: number }): unknown {
	if (typeof value === "string") {
		const masked = vault.mask(value);
		count.n += masked.count;
		return masked.text;
	}
	if (Array.isArray(value)) return value.map((item) => maskDeep(vault, item, count));
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(vault, item, count)]));
	return value;
}

export function createSecretShieldExtension(options: SecretShieldOptions = {}) {
	const vault = options.vault ?? defaultVault;
	return function secretShieldExtension(pi: ExtensionAPI): void {
		if (!secretShieldEnabled(options.env)) return;
		let masked = 0;

		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, "secret-shield": SECRET_SHIELD_NOTE };
			return undefined;
		});

		pi.on("tool_call", (event) => {
			if (NO_UNMASK_TOOLS.has(event.toolName)) return undefined;
			vault.unmaskInPlace(event.input);
			return undefined;
		});

		pi.on("tool_result", (event, ctx) => {
			const count = { n: 0 };
			const content = event.content.map((part) => {
				if (part.type !== "text") return part;
				const result = vault.mask(part.text);
				count.n += result.count;
				return result.count ? { ...part, text: result.text } : part;
			});
			const before = count.n;
			const details = event.details === undefined ? undefined : maskDeep(vault, event.details, count);
			if (!count.n) return undefined;
			masked += count.n;
			ctx.ui.setStatus("oasis-secrets", `${masked} secret${masked === 1 ? "" : "s"} hidden`);
			return { content, ...(count.n > before ? { details } : {}) };
		});
	};
}
