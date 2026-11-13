/**
 * Cheap-model routing: a clearly simple, read-only question is answered by
 * the configured easy model, then the session returns to the main model.
 * Off unless configured: OASIS_EASY_MODEL=provider/id, or
 * "modelRouting": { "easyModel": "provider/id" } in ~/.oasis/agent/settings.json.
 * `/route <prompt>` shows how a prompt would be routed. OASIS_MODEL_ROUTING=0
 * turns it off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { classifyTask } from "../core/model-routing.ts";

export interface ModelRoutingOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: () => string;
	/** provider/id of the easy model (tests). */
	easyModel?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: models of any API
type AnyModel = Model<any>;
const keyOf = (m: AnyModel) => `${m.provider}/${m.id}`;

function configured(options: ModelRoutingOptions, env: NodeJS.ProcessEnv): string {
	if (options.easyModel) return options.easyModel;
	if (env.OASIS_EASY_MODEL) return env.OASIS_EASY_MODEL.trim();
	try {
		const json = JSON.parse(readFileSync(join(options.agentDir?.() ?? getAgentDir(), "settings.json"), "utf8")) as {
			modelRouting?: { enabled?: boolean; easyModel?: unknown };
		};
		const r = json.modelRouting;
		return r && r.enabled !== false && typeof r.easyModel === "string" ? r.easyModel.trim() : "";
	} catch {
		return "";
	}
}

function find(ctx: ExtensionContext, spec: string): AnyModel | undefined {
	const slash = spec.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
	return ctx.modelRegistry.getAvailable().find((m) => m.id === spec);
}

export function createModelRoutingExtension(options: ModelRoutingOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_MODEL_ROUTING === "0") return;
		let routedFrom: AnyModel | undefined;

		pi.on("before_agent_start", async (event, ctx) => {
			if (event.messageType !== "user" || routedFrom) return undefined;
			const spec = configured(options, env);
			const current = ctx.model;
			if (!spec || !current) return undefined;
			const decision = classifyTask(event.prompt, { images: !!event.images?.length });
			if (decision.tier !== "easy") return undefined;
			const easy = find(ctx, spec);
			if (!easy || keyOf(easy) === keyOf(current)) return undefined;
			if (!(await pi.setModel(easy))) return undefined;
			routedFrom = current;
			if (ctx.hasUI) ctx.ui.notify(`Simple question: answering with ${keyOf(easy)}.`, "info");
			return undefined;
		});

		pi.on("agent_settled", async () => {
			const back = routedFrom;
			routedFrom = undefined;
			if (back) await pi.setModel(back);
		});

		pi.registerCommand("route", {
			description: "Show how a prompt would be routed: /route <prompt>",
			handler: async (args, ctx) => {
				const spec = configured(options, env);
				const d = classifyTask(args);
				ctx.ui.notify(`${d.tier} (${d.reason})${spec ? `; easy model ${spec}` : "; no easy model configured (OASIS_EASY_MODEL)"}`, "info");
			},
		});
	};
}
