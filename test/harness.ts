/**
 * Model-free test harness: a real pi agent session, real tools, a temp
 * workspace, and pi-ai's faux provider replaying scripted model turns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface Harness {
	session: AgentSession;
	cwd: string;
	/** Every context the model was called with, in order. */
	calls: { messages: unknown[] }[];
	dispose(): void;
}

export async function createHarness(extensions: InlineExtension[], script: FauxResponseStep[]): Promise<Harness> {
	const cwd = mkdtempSync(join(tmpdir(), "oasis-test-"));
	const agentDir = join(cwd, ".oasis-agent");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const calls: { messages: unknown[] }[] = [];
	faux.setResponses(
		script.map((step) =>
			typeof step === "function"
				? step
				: (context) => {
						calls.push({ messages: [...context.messages] });
						return step;
					},
		),
	);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test-key");
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: extensions,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	// pi's own modes bind extensions before the first prompt; this emits session_start.
	await session.bindExtensions({ mode: "print" });
	return {
		session,
		cwd,
		calls,
		dispose() {
			session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

export function messagesText(messages: unknown[]): string {
	return JSON.stringify(messages);
}
