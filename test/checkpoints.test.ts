import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isCheckpointableDir, ShadowRepo } from "../src/checkpoints/shadow-git.ts";
import { CHECKPOINT_TYPE, createCheckpointsExtension, RESTORE_TYPE } from "../src/extensions/checkpoints.ts";
import { createHarness, type Harness } from "./harness.ts";

const temps: string[] = [];
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
};
let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");

describe("ShadowRepo", () => {
	it("restores modified, deleted and added files, and can undo the restore", async () => {
		const project = temp("oasis-proj-");
		const repo = new ShadowRepo(project, temp("oasis-cp-"));
		writeFileSync(join(project, "a.txt"), "one\n");
		mkdirSync(join(project, "src"));
		writeFileSync(join(project, "src/b.js"), "b\n");
		const before = await repo.snapshot("before");

		writeFileSync(join(project, "a.txt"), "two\n");
		rmSync(join(project, "src/b.js"));
		writeFileSync(join(project, "new.txt"), "new\n");

		const result = await repo.restore(before);
		expect(read(project, "a.txt")).toBe("one\n");
		expect(read(project, "src/b.js")).toBe("b\n");
		expect(existsSync(join(project, "new.txt"))).toBe(false);
		expect(result.removed).toEqual(["new.txt"]);
		expect(result.changed.sort()).toEqual(["a.txt", "src/b.js"]);

		await repo.restore(result.backup);
		expect(read(project, "a.txt")).toBe("two\n");
		expect(read(project, "new.txt")).toBe("new\n");
		expect(existsSync(join(project, "src/b.js"))).toBe(false);
	});

	it("never touches the project's own git repository and honours .gitignore", async () => {
		const project = temp("oasis-proj-");
		mkdirSync(join(project, ".git"));
		writeFileSync(join(project, ".git/HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(project, ".gitignore"), "secret.env\n");
		writeFileSync(join(project, "secret.env"), "KEY=1\n");
		mkdirSync(join(project, "node_modules/x"), { recursive: true });
		writeFileSync(join(project, "node_modules/x/i.js"), "x\n");
		writeFileSync(join(project, "a.txt"), "a\n");
		const repo = new ShadowRepo(project, temp("oasis-cp-"));
		const sha = await repo.snapshot("s");
		writeFileSync(join(project, "a.txt"), "b\n");
		const changes = await repo.diff(sha, await repo.snapshot("t"));
		expect(changes).toEqual([{ status: "modified", path: "a.txt" }]);
		const files = (await repo.diff("4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha)).map((c) => c.path).sort();
		expect(files).toEqual([".gitignore", "a.txt"]);
		expect(read(project, ".git/HEAD")).toBe("ref: refs/heads/main\n");
	});

	it("refuses the home directory and the filesystem root", () => {
		expect(isCheckpointableDir(homedir())).toBe(false);
		expect(isCheckpointableDir("/")).toBe(false);
		expect(isCheckpointableDir(tmpdir())).toBe(true);
	});
});

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const customs = (h: Harness, type: string) =>
	h.session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === type);

describe("checkpoints extension", () => {
	it("undoes edits and shell changes from the last prompt, and /redo puts them back", async () => {
		const root = temp("oasis-cp-");
		harness = await createHarness(
			[{ name: "oasis-checkpoints", factory: createCheckpointsExtension({ root, exclude: [".oasis-agent"] }) }],
			[tool("write", { path: "a.txt", content: "changed\n" }), tool("bash", { command: "echo made > b.txt && rm keep.txt" }), say("Done.")],
		);
		const cwd = harness.cwd;
		writeFileSync(join(cwd, "a.txt"), "original\n");
		writeFileSync(join(cwd, "keep.txt"), "keep\n");
		await harness.session.prompt("change things");
		expect(read(cwd, "a.txt")).toBe("changed\n");
		expect(customs(harness, CHECKPOINT_TYPE)).toHaveLength(1);

		await harness.session.prompt("/undo");
		expect(read(cwd, "a.txt")).toBe("original\n");
		expect(read(cwd, "keep.txt")).toBe("keep\n");
		expect(existsSync(join(cwd, "b.txt"))).toBe(false);
		expect(customs(harness, RESTORE_TYPE)).toHaveLength(1);

		await harness.session.prompt("/redo");
		expect(read(cwd, "a.txt")).toBe("changed\n");
		expect(read(cwd, "b.txt")).toBe("made\n");
		expect(existsSync(join(cwd, "keep.txt"))).toBe(false);
	});

	it("does not snapshot its own data or treat an unchanged prompt as undoable", async () => {
		const root = temp("oasis-cp-");
		harness = await createHarness(
			[{ name: "oasis-checkpoints", factory: createCheckpointsExtension({ root, exclude: [".oasis-agent"] }) }],
			[say("Hi.")],
		);
		writeFileSync(join(harness.cwd, "a.txt"), "x\n");
		await harness.session.prompt("hello");
		await harness.session.prompt("/undo");
		expect(customs(harness, RESTORE_TYPE)).toHaveLength(0);
		expect(read(harness.cwd, "a.txt")).toBe("x\n");
	});
});
