/**
 * ask_user_question (Claude Code's AskUserQuestion, original OASIS): a
 * multiple-choice question for decisions that really change the work. The
 * user picks an option or types their own answer. At most
 * OASIS_MAX_QUESTIONS_PER_TURN questions per prompt (default 2, "off" for no
 * cap), because agents that stop to ask obvious questions are worse than
 * ones that state an assumption. Without a UI (print mode, scheduled runs,
 * subagents) the tool tells the model to decide and say what it assumed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const OTHER_LABEL = "Other (type an answer)";

export function questionBudget(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env.OASIS_MAX_QUESTIONS_PER_TURN;
	if (raw === undefined || raw === "") return 2;
	if (/^(?:off|unlimited|none|false)$/i.test(raw)) return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : 2;
}

const result = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });
const DECIDE = "Decide yourself: pick the most reasonable option, proceed, and state the assumption in your reply.";

export function createAskUserExtension(options: { env?: NodeJS.ProcessEnv } = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_ASK_USER === "0") return;
		const budget = questionBudget(env);
		let asked = 0;
		pi.on("before_agent_start", (event) => {
			if (event.messageType === "user") asked = 0;
			return undefined;
		});

		pi.registerTool({
			name: "ask_user_question",
			label: "Ask the user",
			description:
				"Ask the user a multiple-choice question when a decision really changes the work and you cannot find the answer yourself. Not for permission (tools ask for that) or for things you can look up. The user can also type a different answer.",
			promptSnippet: "Ask the user a multiple-choice question about a decision only they can make",
			parameters: Type.Object({
				question: Type.String({ description: "One clear question ending with a question mark" }),
				options: Type.Array(
					Type.Object({
						label: Type.String({ description: "1-5 word choice" }),
						description: Type.Optional(Type.String({ description: "What this choice means or its trade-off" })),
					}),
					{ minItems: 2, maxItems: 4 },
				),
				multi_select: Type.Optional(Type.Boolean({ description: "Allow choosing several options" })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!ctx.hasUI) return result(`No user is available to answer. ${DECIDE}`, { answered: false });
				if (budget !== undefined && asked >= budget)
					return result(`You already asked ${asked} question(s) this turn. ${DECIDE}`, { answered: false });
				asked++;
				const question = params.question.trim().slice(0, 600);
				const opts = params.options
					.slice(0, 4)
					.map((o) => ({ label: o.label.trim().slice(0, 80), description: o.description?.trim() ?? "" }));
				const render = (o: { label: string; description: string }) => (o.description ? `${o.label}: ${o.description}` : o.label);
				const choices = [...opts.map(render), OTHER_LABEL];
				const picked: string[] = [];
				const remaining = [...choices];
				while (true) {
					const title = params.multi_select && picked.length ? `${question} (chosen: ${picked.join(", ")})` : question;
					const list = params.multi_select && picked.length ? [...remaining, "Done"] : remaining;
					const choice = await ctx.ui.select(title, list, { signal });
					if (choice === undefined) {
						if (picked.length) break;
						return result(`The user dismissed the question. ${DECIDE}`, { answered: false });
					}
					if (choice === "Done") break;
					if (choice === OTHER_LABEL) {
						const typed = (await ctx.ui.input(question, "Your answer", { signal }))?.trim();
						if (typed) picked.push(typed);
						break;
					}
					picked.push(opts[choices.indexOf(choice)]?.label ?? choice);
					if (!params.multi_select) break;
					remaining.splice(remaining.indexOf(choice), 1);
					if (remaining.length === 1) break;
				}
				if (!picked.length) return result(`The user gave no answer. ${DECIDE}`, { answered: false });
				return result(`The user answered: ${picked.join("; ")}`, { answered: true, answers: picked });
			},
		});
	};
}
