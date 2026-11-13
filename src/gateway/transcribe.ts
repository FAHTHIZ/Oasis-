/**
 * Voice notes and audio for the gateway (Hermes-style): audio attachments are
 * sent to an OpenAI-compatible `/audio/transcriptions` endpoint (Groq, OpenAI,
 * or a local whisper server such as speaches or whisper.cpp) and the transcript
 * goes into the prompt. Opt-in with OASIS_TRANSCRIBE.
 *
 *   OASIS_TRANSCRIBE=groq     GROQ_API_KEY, whisper-large-v3-turbo
 *   OASIS_TRANSCRIBE=openai   OPENAI_API_KEY, gpt-4o-mini-transcribe
 *   OASIS_TRANSCRIBE=<url>    any base URL ending in /v1 (key: OASIS_TRANSCRIBE_API_KEY)
 *   OASIS_TRANSCRIBE_MODEL    overrides the model
 */
import { extname } from "node:path";

export type Transcriber = (audio: Uint8Array, name: string, mime?: string) => Promise<string>;

const AUDIO_EXTENSIONS = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".mp4", ".wav", ".webm", ".flac", ".mpga", ".mpeg"]);

export function isAudio(name: string, mime?: string): boolean {
	const type = (mime ?? "").toLowerCase();
	if (type.startsWith("audio/")) return true;
	if (type && !type.startsWith("application/octet-stream") && !type.startsWith("video/")) return false;
	return AUDIO_EXTENSIONS.has(extname(name).toLowerCase()) && !type.startsWith("video/");
}

export interface TranscriberConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export function transcriberConfig(env: NodeJS.ProcessEnv = process.env): TranscriberConfig | undefined {
	const choice = env.OASIS_TRANSCRIBE?.trim();
	if (!choice || choice === "0" || choice === "off") return undefined;
	const model = env.OASIS_TRANSCRIBE_MODEL?.trim();
	if (choice === "groq")
		return { baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, model: model || "whisper-large-v3-turbo" };
	if (choice === "openai" || choice === "1")
		return {
			baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
			apiKey: env.OPENAI_API_KEY,
			model: model || "gpt-4o-mini-transcribe",
		};
	if (/^https?:\/\//.test(choice))
		return { baseUrl: choice.replace(/\/+$/, ""), apiKey: env.OASIS_TRANSCRIBE_API_KEY, model: model || "whisper-1" };
	return undefined;
}

export function createTranscriber(config: TranscriberConfig, fetchImpl: typeof fetch = fetch): Transcriber {
	return async (audio, name, mime) => {
		const form = new FormData();
		form.append("file", new Blob([audio], { type: mime || "application/octet-stream" }), name);
		form.append("model", config.model);
		form.append("response_format", "json");
		const response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
			method: "POST",
			headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
			body: form,
			signal: AbortSignal.timeout(120_000),
		});
		const body = await response.text();
		if (!response.ok) throw new Error(`transcription failed (${response.status}): ${body.slice(0, 200)}`);
		try {
			const parsed = JSON.parse(body) as { text?: unknown };
			return typeof parsed.text === "string" ? parsed.text.trim() : "";
		} catch {
			return body.trim();
		}
	};
}

export function transcriberFromEnv(env: NodeJS.ProcessEnv = process.env): Transcriber | undefined {
	const config = transcriberConfig(env);
	return config ? createTranscriber(config) : undefined;
}
