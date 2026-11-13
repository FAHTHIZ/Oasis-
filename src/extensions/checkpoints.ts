/**
 * Checkpoints: the project's files are snapshotted before every user prompt,
 * so any prompt's changes can be undone, including changes made by shell
 * commands, which per-edit undo in other agents misses.
 *
 *   /undo         restore files to before the latest prompt that changed them
 *   /redo         undo the last /undo
 *   /checkpoints  list checkpoints for this session
 *
 * /fork and /tree offer to restore files to the matching checkpoint.
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CheckpointError, type FileChange, isCheckpointableDir, type RestoreResult, ShadowRepo } from "../checkpoints/shadow-git.ts";

export const CHECKPOINT_TYPE = "oasis.checkpoint";
export const RESTORE_TYPE = "oasis.checkpoint-restore";

export interface CheckpointData {
	sha: string;
	tree: string;
	prompt: string;
	at: number;
}

export interface RestoreData {
	to: string;
	backup: string;
	changed: number;
	removed: number;
}

export interface CheckpointOptions {
	/** Where shadow repositories live. Default: <agent dir>/checkpoints. */
	root?: string;
	/** Paths inside the project that must never be snapshotted. */
	exclude?: string[];
}

type Custom = Extract<SessionEntry, { type: "custom" }>;

const isCustom = (e: SessionEntry, type: string): e is Custom => e.type === "custom" && (e as Custom).customType === type;

function checkpointsOn(entries: SessionEntry[]): (CheckpointData & { entryId: string })[] {
	return entries.filter((e) => isCustom(e, CHECKPOINT_TYPE)).map((e) => ({ ...((e as Custom).data as CheckpointData), entryId: e.id }));
}

function summary(changes: FileChange[], limit = 8): string {
	const shown = changes.slice(0, limit).map((c) => `${c.status === "added" ? "+" : c.status === "deleted" ? "-" : "~"} ${c.path}`);
	if (changes.length > limit) shown.push(`… and ${changes.length - limit} more`);
	return shown.join("\n");
}

export function createCheckpointsExtension(options: CheckpointOptions = {}) {
	return (pi: ExtensionAPI) => {
		let repo: ShadowRepo | undefined;
		let disabledReason: string | undefined;

		const getRepo = (ctx: ExtensionContext): ShadowRepo | undefined => {
			if (repo || disabledReason) return repo;
			if (!isCheckpointableDir(ctx.cwd)) {
				disabledReason = `checkpoints are off in ${ctx.cwd} (too broad to snapshot)`;
				return undefined;
			}
			const agentDir = getAgentDir();
			const root = options.root ?? join(agentDir, "checkpoints");
			repo = new ShadowRepo(ctx.cwd, root, ShadowRepo.excludeFor(ctx.cwd, root, agentDir, ...(options.exclude ?? [])));
			return repo;
		};

		const fail = (ctx: ExtensionContext, error: unknown) => {
			const message = error instanceof CheckpointError ? error.message : String(error);
			if (/ENOENT|not found|spawn git/i.test(message)) disabledReason = "checkpoints need git on PATH";
			if (ctx.hasUI) ctx.ui.notify(`OASIS checkpoint: ${disabledReason ?? message}`, "warning");
		};

		const restoreTo = async (ctx: ExtensionContext, sha: string): Promise<RestoreResult | undefined> => {
			const r = getRepo(ctx);
			if (!r) return undefined;
			const result = await r.restore(sha);
			pi.appendEntry<RestoreData>(RESTORE_TYPE, {
				to: sha,
				backup: result.backup,
				changed: result.changed.length,
				removed: result.removed.length,
			});
			return result;
		};

		const report = (ctx: ExtensionContext, label: string, result: RestoreResult | undefined) => {
			if (!result) return;
			const n = result.changed.length + result.removed.length;
			ctx.ui.notify(`${label}: ${n} file${n === 1 ? "" : "s"} restored. /redo puts them back.`, "info");
		};

		pi.on("before_agent_start", async (event, ctx) => {
			if (event.messageType !== "user") return undefined;
			const r = getRepo(ctx);
			if (!r) return undefined;
			try {
				const sha = await r.snapshot(`before: ${event.prompt.slice(0, 200)}`);
				pi.appendEntry<CheckpointData>(CHECKPOINT_TYPE, {
					sha,
					tree: await r.treeOf(sha),
					prompt: event.prompt.slice(0, 200),
					at: Date.now(),
				});
			} catch (error) {
				fail(ctx, error);
			}
			return undefined;
		});

		pi.registerCommand("undo", {
			description: "Restore files to before the latest prompt that changed them",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();
				const r = getRepo(ctx);
				if (!r) return ctx.ui.notify(`OASIS checkpoint: ${disabledReason}`, "warning");
				try {
					const now = await r.snapshot("before /undo");
					const nowTree = await r.treeOf(now);
					const target = checkpointsOn(ctx.sessionManager.getBranch())
						.reverse()
						.find((c) => c.tree !== nowTree);
					if (!target) return ctx.ui.notify("Nothing to undo: files match every checkpoint in this session.", "info");
					const changes = await r.diff(now, target.sha);
					if (ctx.hasUI) {
						const ok = await ctx.ui.confirm(`Undo changes since "${target.prompt.slice(0, 60)}"?`, summary(changes));
						if (!ok) return;
					}
					report(ctx, "Undone", await restoreTo(ctx, target.sha));
				} catch (error) {
					fail(ctx, error);
				}
			},
		});

		pi.registerCommand("redo", {
			description: "Put back the files changed by the last /undo",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();
				const last = ctx.sessionManager
					.getBranch()
					.filter((e) => isCustom(e, RESTORE_TYPE))
					.pop() as Custom | undefined;
				if (!last) return ctx.ui.notify("Nothing to redo.", "info");
				try {
					report(ctx, "Redone", await restoreTo(ctx, (last.data as RestoreData).backup));
				} catch (error) {
					fail(ctx, error);
				}
			},
		});

		pi.registerCommand("checkpoints", {
			description: "List file checkpoints in this session",
			handler: async (_args, ctx) => {
				const list = checkpointsOn(ctx.sessionManager.getBranch());
				if (list.length === 0) return ctx.ui.notify(disabledReason ?? "No checkpoints yet. One is taken before each prompt.", "info");
				const lines = list
					.slice(-15)
					.map((c) => `${new Date(c.at).toLocaleTimeString()}  ${c.sha.slice(0, 8)}  ${c.prompt.replace(/\s+/g, " ").slice(0, 70)}`);
				ctx.ui.notify(`Checkpoints (files before each prompt):\n${lines.join("\n")}\n/undo restores the latest one that differs.`, "info");
			},
		});

		/** The checkpoint taken just before the user message `entryId`. */
		const checkpointBefore = (ctx: ExtensionContext, entryId: string) => {
			const branch = ctx.sessionManager.getBranch(entryId);
			return checkpointsOn(branch.slice(0, -1)).pop();
		};

		const offerRestore = async (ctx: ExtensionContext, entryId: string) => {
			if (!ctx.hasUI) return;
			const entry = ctx.sessionManager.getEntry(entryId);
			if (!entry || entry.type !== "message" || entry.message.role !== "user") return;
			const cp = checkpointBefore(ctx, entryId);
			const r = getRepo(ctx);
			if (!cp || !r) return;
			try {
				const now = await r.snapshot("before branch switch");
				if ((await r.treeOf(now)) === cp.tree) return;
				const changes = await r.diff(now, cp.sha);
				const choice = await ctx.ui.select(`Also restore files to before this message? (${changes.length} changed)`, [
					"Yes, restore files",
					"No, keep current files",
				]);
				if (choice?.startsWith("Yes")) report(ctx, "Files restored", await restoreTo(ctx, cp.sha));
			} catch (error) {
				fail(ctx, error);
			}
		};

		pi.on("session_before_fork", async (event, ctx) => {
			if (event.position === "before") await offerRestore(ctx, event.entryId);
			return undefined;
		});

		pi.on("session_before_tree", async (event, ctx) => {
			await offerRestore(ctx, event.preparation.targetId);
			return undefined;
		});
	};
}
