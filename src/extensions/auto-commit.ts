/**
 * Aider-style auto-commit: with OASIS_AUTO_COMMIT=1 (or `/autocommit on`),
 * every prompt that changes files ends with a Git commit of just those files
 * (see src/git/auto-commit.ts). `/autocommit` shows or toggles it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoCommitEnabled,
	autoCommitTurn,
	changedPaths,
	type DirtySnapshot,
	describeAutoCommit,
	dirtySnapshot,
	repoRoot,
} from "../git/auto-commit.ts";

export function createAutoCommitExtension(options: { env?: NodeJS.ProcessEnv } = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		let enabled = autoCommitEnabled(env);
		let pending: { repo: string; before: DirtySnapshot; prompt: string } | undefined;

		pi.registerCommand("autocommit", {
			description: "Commit each prompt's file changes to Git: /autocommit [on|off]",
			getArgumentCompletions: (prefix) =>
				["on", "off"].filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item })),
			handler: async (args, ctx) => {
				const choice = args.trim().toLowerCase();
				if (choice === "on" || choice === "off") enabled = choice === "on";
				else if (choice) return ctx.ui.notify("Usage: /autocommit [on|off]", "warning");
				ctx.ui.notify(
					enabled
						? "Auto-commit is on: each prompt that changes files ends with a Git commit of those files."
						: "Auto-commit is off. Turn it on with /autocommit on or OASIS_AUTO_COMMIT=1.",
					"info",
				);
			},
		});

		pi.on("before_agent_start", async (event, ctx) => {
			if (!enabled || pending) return;
			const repo = await repoRoot(ctx.cwd);
			if (!repo) return;
			const prompt = event.messageType === "user" ? event.prompt : "";
			pending = { repo, before: await dirtySnapshot(repo), prompt };
		});

		pi.on("agent_settled", async (_event, ctx) => {
			const run = pending;
			pending = undefined;
			if (!run || !enabled) return;
			const paths = changedPaths(run.before, await dirtySnapshot(run.repo));
			if (!paths.length) return;
			const result = await autoCommitTurn({ root: run.repo, paths, prompt: run.prompt });
			const message = describeAutoCommit(result);
			if (message) ctx.ui.notify(message, "error" in result ? "warning" : "info");
		});
	};
}
