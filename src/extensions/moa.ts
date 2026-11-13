/**
 * Mixture of Agents, from Hermes Agent: set reference models with
 * OASIS_MOA_MODELS or /moa models a/b,c/d (OASIS_MOA_AGGREGATOR picks the
 * synthesizer; the current model by default). The agent gets a
 * mixture_of_agents tool for hard problems, and /moa PROMPT runs the mixture
 * first and hands its guidance to the agent with the prompt.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type MoaAsk, parseModelList, runMixture } from "../core/moa.ts";
import { askSide, branchMessages } from "../core/side-model.ts";

type AnyModel = NonNullable<ExtensionContext["model"]>;

function findModel(ctx: ExtensionContext, spec: string): AnyModel | undefined {
	const slash = spec.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
	return ctx.modelRegistry.getAvailable().find((m) => m.id === spec);
}

const label = (m: AnyModel) => `${m.provider}/${m.id}`;

export function createMoaExtension(options: { env?: NodeJS.ProcessEnv; ask?: MoaAsk } = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		let references = parseModelList(env.OASIS_MOA_MODELS);
		const aggregatorSpec = env.OASIS_MOA_AGGREGATOR?.trim();

		const syncTool = () => {
			const active = pi.getActiveTools();
			const on = references.length > 0;
			if (on && !active.includes("mixture_of_agents")) pi.setActiveTools([...active, "mixture_of_agents"]);
			if (!on && active.includes("mixture_of_agents")) pi.setActiveTools(active.filter((t) => t !== "mixture_of_agents"));
		};

		const mixture = async (ctx: ExtensionContext, question: string, signal?: AbortSignal) => {
			const aggregatorModel = aggregatorSpec ? findModel(ctx, aggregatorSpec) : ctx.model;
			const aggregator = aggregatorModel ? label(aggregatorModel) : undefined;
			const messages = branchMessages(ctx.sessionManager.getBranch());
			const ask: MoaAsk =
				options.ask ??
				(async (spec, system, q, s) => {
					const model = spec === aggregator && aggregatorModel ? aggregatorModel : findModel(ctx, spec);
					if (!model) throw new Error("model not available");
					return askSide(model, () => ctx.modelRegistry.getApiKeyAndHeaders(model), system, messages, q, {
						signal: s,
						maxTokens: 2500,
					});
				});
			return runMixture({ question, references, aggregator, ask, signal });
		};

		pi.registerTool({
			name: "mixture_of_agents",
			label: "Mixture of agents",
			description:
				"Ask several different frontier models at once for advice on this conversation, then get one synthesized answer. Use it for genuinely hard problems: tricky bugs after failed attempts, architecture choices, risky changes. It returns guidance only and costs several model calls, so do not use it for routine work.",
			promptSnippet: "Consult several models at once (mixture of agents) on hard problems",
			parameters: Type.Object({ question: Type.String({ description: "The specific problem to get advice on" }) }),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!references.length) return { content: [{ type: "text", text: "No mixture-of-agents models are configured." }], details: {} };
				const result = await mixture(ctx, params.question, signal);
				return {
					content: [{ type: "text", text: result.guidance }],
					details: { references: result.references.map((r) => ({ model: r.model, ok: r.ok })), aggregator: result.aggregator },
				};
			},
		});

		pi.on("session_start", (_event, ctx) => {
			const missing = references.filter((r) => !findModel(ctx, r));
			if (missing.length && !options.ask) {
				ctx.ui.notify(`Mixture-of-agents models not available: ${missing.join(", ")}`, "warning");
				references = references.filter((r) => !missing.includes(r));
			}
			syncTool();
		});

		pi.registerCommand("moa", {
			description: "Mixture of agents: /moa PROMPT (consult the reference models first), /moa models a/b,c/d | off",
			handler: async (args, ctx) => {
				const text = args.trim();
				const [first, ...rest] = text.split(/\s+/);
				if (!text)
					return ctx.ui.notify(
						references.length
							? `Mixture of agents: ${references.join(", ")}; aggregator ${aggregatorSpec || "current model"}.\n/moa PROMPT runs it.`
							: "No reference models. /moa models provider/a,provider/b sets them (or OASIS_MOA_MODELS).",
						"info",
					);
				if (first === "models") {
					const list = rest.join(" ");
					if (list === "off") references = [];
					else {
						const wanted = parseModelList(list);
						const missing = wanted.filter((m) => !findModel(ctx, m));
						if (missing.length) return ctx.ui.notify(`Not available: ${missing.join(", ")}`, "warning");
						references = wanted;
					}
					syncTool();
					return ctx.ui.notify(references.length ? `Mixture of agents: ${references.join(", ")}` : "Mixture of agents off.", "info");
				}
				if (!references.length) return ctx.ui.notify("No reference models. /moa models provider/a,provider/b sets them.", "warning");
				ctx.ui.notify(`Consulting ${references.length} models...`, "info");
				const result = await mixture(ctx, text, ctx.signal);
				const prompt = `${text}\n\n<mixture-of-agents-guidance>\nPrivate guidance from ${references.length} reference models${result.aggregator ? `, synthesized by ${result.aggregator}` : ""}. Use it in your normal loop; verify before relying on it.\n\n${result.guidance}\n</mixture-of-agents-guidance>`;
				pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			},
		});
	};
}
