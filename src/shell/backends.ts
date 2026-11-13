/**
 * Terminal backends, as in Hermes: the agent's shell commands can run inside a
 * persistent Docker container (the workspace bind-mounted at the same path) or
 * on another machine over SSH, instead of on the host. File tools keep working
 * on the local files; with Docker those are the same files the container sees.
 *
 *   OASIS_SHELL_BACKEND=docker[:image]   default image node:22-bookworm
 *   OASIS_SHELL_BACKEND=ssh:user@host    remote directory: OASIS_SSH_DIR (default: same path)
 *   OASIS_DOCKER_KEEP=1                  leave the container running on exit
 *   OASIS_DOCKER_ARGS="--network none"   extra `docker run` arguments
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export interface ShellBackend {
	kind: "docker" | "ssh";
	describe: string;
	/** The host command line that runs `command` in `cwd` on the backend. */
	wrap(command: string, cwd: string): Promise<string>;
	dispose(): Promise<void>;
}

export type Runner = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runFile: Runner = (file, args) =>
	new Promise((done) => {
		execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
			done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
		);
	});

export function parseBackend(value: string | undefined): { kind: "docker"; image: string } | { kind: "ssh"; host: string } | undefined {
	const v = value?.trim();
	if (!v || v === "local" || v === "off") return undefined;
	if (v === "docker" || v.startsWith("docker:")) return { kind: "docker", image: v.slice("docker:".length) || "node:22-bookworm" };
	if (v.startsWith("ssh:") && v.length > 4) return { kind: "ssh", host: v.slice(4) };
	throw new Error(`unknown shell backend "${v}" (use docker[:image] or ssh:user@host)`);
}

export function dockerBackend(root: string, image: string, env: NodeJS.ProcessEnv = process.env, run: Runner = runFile): ShellBackend {
	const workspace = resolve(root);
	const name = `oasis-${createHash("sha1").update(`${workspace}\n${image}`).digest("hex").slice(0, 12)}`;
	let ready: Promise<void> | undefined;
	const start = async () => {
		const running = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
		if (running.code === 0 && running.stdout.trim() === "true") return;
		if (running.code === 0) {
			const started = await run("docker", ["start", name]);
			if (started.code === 0) return;
			await run("docker", ["rm", "-f", name]);
		}
		const extra = (env.OASIS_DOCKER_ARGS ?? "").split(/\s+/).filter(Boolean);
		const created = await run("docker", [
			"run",
			"-d",
			"--name",
			name,
			"--label",
			"oasis.workspace",
			"-v",
			`${workspace}:${workspace}`,
			"-w",
			workspace,
			...extra,
			image,
			"sleep",
			"infinity",
		]);
		if (created.code !== 0) throw new Error(`docker run failed: ${created.stderr.trim() || created.stdout.trim()}`);
	};
	return {
		kind: "docker",
		describe: `Docker container ${name} (${image}), workspace mounted at ${workspace}`,
		async wrap(command, cwd) {
			ready ??= start().catch((error) => {
				ready = undefined;
				throw error;
			});
			await ready;
			return `docker exec -i -w ${quote(resolve(cwd))} ${name} bash -lc ${quote(command)}`;
		},
		async dispose() {
			if (ready && env.OASIS_DOCKER_KEEP !== "1") await run("docker", ["rm", "-f", name]);
			ready = undefined;
		},
	};
}

export function sshBackend(host: string, root: string, env: NodeJS.ProcessEnv = process.env): ShellBackend {
	const local = resolve(root);
	const remote = env.OASIS_SSH_DIR?.trim() || local;
	const map = (cwd: string) => {
		const abs = resolve(cwd);
		return abs === local ? remote : abs.startsWith(`${local}/`) ? `${remote}${abs.slice(local.length)}` : abs;
	};
	return {
		kind: "ssh",
		describe: `ssh ${host}, in ${remote}`,
		async wrap(command, cwd) {
			return `ssh -o BatchMode=yes -T ${quote(host)} ${quote(`cd ${quote(map(cwd))} && ${command}`)}`;
		},
		async dispose() {},
	};
}

export function backendFromEnv(root: string, env: NodeJS.ProcessEnv = process.env): ShellBackend | undefined {
	const parsed = parseBackend(env.OASIS_SHELL_BACKEND);
	if (!parsed) return undefined;
	return parsed.kind === "docker" ? dockerBackend(root, parsed.image, env) : sshBackend(parsed.host, root, env);
}
