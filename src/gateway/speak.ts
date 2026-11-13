/**
 * Spoken replies for the gateway (Hermes-style voice mode): the reply text is
 * sent to an OpenAI-compatible `/audio/speech` endpoint and the audio goes back
 * to the chat as a voice note. Works with OpenAI, or free and local with
 * Kokoro-FastAPI, openedai-speech or speaches. Opt-in with OASIS_TTS.
 *
 *   OASIS_TTS=openai     OPENAI_API_KEY, gpt-4o-mini-tts, voice "alloy"
 *   OASIS_TTS=<url>      any base URL ending in /v1 (key: OASIS_TTS_API_KEY),
 *                        model "kokoro", voice "af_heart"
 *   OASIS_TTS_MODEL, OASIS_TTS_VOICE   override model and voice
 *   OASIS_TTS_REPLY=voice   speak only when the user sent a voice note (default)
 *   OASIS_TTS_REPLY=always  speak every reply
 */
export type Speaker = (text: string) => Promise<{ audio: Uint8Array; mime: string; name: string }>;

export interface SpeakerConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
	voice: string;
	/** Speak only replies to voice notes, or every reply. */
	reply: "voice" | "always";
}

/** OpenAI's input limit is 4096 characters; leave room. */
export const SPEECH_MAX_CHARS = 4000;

export function speakerConfig(env: NodeJS.ProcessEnv = process.env): SpeakerConfig | undefined {
	const choice = env.OASIS_TTS?.trim();
	if (!choice || choice === "0" || choice === "off") return undefined;
	const reply = env.OASIS_TTS_REPLY?.trim() === "always" ? "always" : "voice";
	const model = env.OASIS_TTS_MODEL?.trim();
	const voice = env.OASIS_TTS_VOICE?.trim();
	if (choice === "openai" || choice === "1")
		return {
			baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
			apiKey: env.OPENAI_API_KEY,
			model: model || "gpt-4o-mini-tts",
			voice: voice || "alloy",
			reply,
		};
	if (/^https?:\/\//.test(choice))
		return {
			baseUrl: choice.replace(/\/+$/, ""),
			apiKey: env.OASIS_TTS_API_KEY,
			model: model || "kokoro",
			voice: voice || "af_heart",
			reply,
		};
	return undefined;
}

/** Text worth reading aloud: code blocks, links and Markdown markup removed. */
export function speakableText(text: string): string {
	const plain = text
		.replace(/```[\s\S]*?```/g, " (code omitted) ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, "$2")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (plain.length <= SPEECH_MAX_CHARS) return plain;
	const cut = plain.lastIndexOf(". ", SPEECH_MAX_CHARS);
	return `${plain.slice(0, cut > SPEECH_MAX_CHARS / 2 ? cut + 1 : SPEECH_MAX_CHARS)} The rest is in the text reply.`;
}

export function createSpeaker(config: SpeakerConfig, fetchImpl: typeof fetch = fetch): Speaker {
	return async (text) => {
		const response = await fetchImpl(`${config.baseUrl}/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
			body: JSON.stringify({ model: config.model, voice: config.voice, input: speakableText(text), response_format: "opus" }),
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) throw new Error(`speech failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
		return { audio: new Uint8Array(await response.arrayBuffer()), mime: "audio/ogg", name: "reply.ogg" };
	};
}

export function speakerFromEnv(env: NodeJS.ProcessEnv = process.env): { speak: Speaker; reply: SpeakerConfig["reply"] } | undefined {
	const config = speakerConfig(env);
	return config ? { speak: createSpeaker(config), reply: config.reply } : undefined;
}
