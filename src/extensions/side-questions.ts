/**
 * /btw QUESTION asks the current model a quick side question about the
 * session; the answer is shown but never enters the conversation. /recap
 * gives a one-line summary of the session. The advisor tool (Claude Code's
 * advisorModel) lets the working model consult a second, usually stronger
 * model that sees the transcript and returns guidance only; set it with
 * /advisor provider/model, --advisor, or OASIS_ADVISOR_MODEL ("off" removes it).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ADVISOR_SYSTEM, askSide, branchMessages, RECAP_QUESTION, SIDE_SYSTEM } from "../core/side-model.ts";

type AnyModel = NonNullable<ExtensionContext["model"]>;

function findModel(ctx: ExtensionContext, spec: string): AnyModel | undefined {
	const slash = spec.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
	return ctx.modelRegistry.getAvailable().find((m) => m.id === spec);
}

const result = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

export type SideAsk = (
	model: AnyModel,
	system: string,
	messages: readonly unknown[],
	question: string,
	signal?: AbortSignal,
) => Promise<string>;

export function createSideQuestionsExtension(options: { env?: NodeJS.ProcessEnv; ask?: SideAsk } = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		let lastSide: { question: string; answer: string } | undefined;
		let advisor = env.OASIS_ADVISOR_MODEL?.trim() ?? "";
		pi.registerFlag("advisor", {
			type: "string",
			description: "Advisor model (provider/model) the agent can consult with the advisor tool",
		});

		const ask = async (ctx: ExtensionContext, model: AnyModel, system: string, question: string, signal?: AbortSignal) => {
			const messages = branchMessages(ctx.sessionManager.getBranch());
			if (options.ask) return options.ask(model, system, messages, question, signal);
			return askSide(model, () => ctx.modelRegistry.getApiKeyAndHeaders(model), system, messages, question, { signal });
		};

		const syncTool = () => {
			const active = pi.getActiveTools();
			const on = Boolean(advisor && advisor !== "off");
			if (on && !active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
			if (!on && active.includes("advisor")) pi.setActiveTools(active.filter((t) => t !== "advisor"));
		};

		pi.registerTool({
			name: "advisor",
			label: "Advisor",
			description:
				"Consult a stronger advisor model that sees this entire conversation. Use it before committing to an approach on hard problems, when stuck after several attempts, or to sanity-check a plan or diagnosis. It returns advice only; it cannot run tools. Optionally pass a focused question.",
			promptSnippet: "Consult a stronger advisor model on hard decisions or when stuck",
			parameters: Type.Object({ question: Type.Optional(Type.String({ description: "Optional specific question for the advisor" })) }),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!advisor || advisor === "off") return result("No advisor model is configured.", { ok: false });
				const model = findModel(ctx, advisor);
				if (!model) return result(`Advisor model "${advisor}" is not available.`, { ok: false });
				try {
					const advice = await ask(
						ctx,
						model,
						ADVISOR_SYSTEM,
						params.question?.trim() ? `The agent asks: ${params.question}` : "What should the agent do next?",
						signal,
					);
					return result(advice, { ok: true, model: `${model.provider}/${model.id}` });
				} catch (error) {
					return result(`Advisor failed: ${(error as Error).message}`, { ok: false });
				}
			},
		});

		pi.on("session_start", (_event, ctx) => {
			const flag = pi.getFlag("advisor");
			if (typeof flag === "string" && flag.trim()) advisor = flag.trim();
			if (advisor && advisor !== "off" && !findModel(ctx, advisor)) {
				ctx.ui.notify(`Advisor model "${advisor}" is not available; the advisor tool is off.`, "warning");
				advisor = "";
			}
			syncTool();
		});

		pi.registerCommand("advisor", {
			description: "Set the advisor model the agent can consult: /advisor provider/model | off",
			handler: async (args, ctx) => {
				const spec = args.trim();
				if (!spec)
					return ctx.ui.notify(
						advisor && advisor !== "off" ? `Advisor: ${advisor}` : "No advisor. /advisor provider/model sets one.",
						"info",
					);
				if (spec === "off") {
					advisor = "";
					syncTool();
					return ctx.ui.notify("Advisor off.", "info");
				}
				if (!findModel(ctx, spec)) return ctx.ui.notify(`No available model "${spec}".`, "warning");
				advisor = spec;
				syncTool();
				ctx.ui.notify(`Advisor: ${spec}. The agent can now call the advisor tool.`, "info");
			},
		});

		pi.registerCommand("btw", {
			description: "Ask a side question about this session without adding it to the conversation: /btw QUESTION",
			handler: async (args, ctx) => {
				const question = args.trim();
				if (!question)
					return ctx.ui.notify(
						lastSide
							? `Last side question: ${lastSide.question}\n\n${lastSide.answer}`
							: "Usage: /btw QUESTION. The answer does not enter the conversation.",
						"info",
					);
				if (!ctx.model) return ctx.ui.notify("No model selected.", "warning");
				try {
					const answer = await ask(ctx, ctx.model, SIDE_SYSTEM, question, ctx.signal);
					lastSide = { question, answer };
					ctx.ui.notify(`btw: ${answer}`, "info");
				} catch (error) {
					ctx.ui.notify(`Side question failed: ${(error as Error).message}`, "warning");
				}
			},
		});

		pi.registerCommand("recap", {
			description: "One-line summary of this session",
			handler: async (_args, ctx) => {
				if (branchMessages(ctx.sessionManager.getBranch()).length < 2) return ctx.ui.notify("Nothing to recap yet.", "info");
				if (!ctx.model) return ctx.ui.notify("No model selected.", "warning");
				try {
					ctx.ui.notify(await ask(ctx, ctx.model, SIDE_SYSTEM, RECAP_QUESTION, ctx.signal), "info");
				} catch (error) {
					ctx.ui.notify(`Recap failed: ${(error as Error).message}`, "warning");
				}
			},
		});
	};
}
