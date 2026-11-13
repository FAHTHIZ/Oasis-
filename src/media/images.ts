/**
 * Image generation (Hermes' image_generate): an OpenAI-compatible
 * `/images/generations` endpoint — OpenAI's gpt-image-1, or any server that
 * speaks the same API (LocalAI, Together, a ComfyUI bridge). Opt-in:
 *
 *   OASIS_IMAGE=openai    OPENAI_API_KEY, model gpt-image-1
 *   OASIS_IMAGE=<url>     base URL ending in /v1 (key: OASIS_IMAGE_API_KEY)
 *   OASIS_IMAGE_MODEL     overrides the model
 */
export interface ImageConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export function imageConfig(env: NodeJS.ProcessEnv = process.env): ImageConfig | undefined {
	const choice = env.OASIS_IMAGE?.trim();
	if (!choice || choice === "0" || choice === "off") return undefined;
	const model = env.OASIS_IMAGE_MODEL?.trim();
	if (choice === "openai" || choice === "1")
		return {
			baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
			apiKey: env.OPENAI_API_KEY,
			model: model || "gpt-image-1",
		};
	if (/^https?:\/\//.test(choice))
		return { baseUrl: choice.replace(/\/+$/, ""), apiKey: env.OASIS_IMAGE_API_KEY, model: model || "gpt-image-1" };
	return undefined;
}

export interface GeneratedImage {
	data: Uint8Array;
	mime: string;
	revisedPrompt?: string;
}

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export async function generateImage(
	config: ImageConfig,
	request: { prompt: string; size?: string; quality?: string; format?: "png" | "jpeg" | "webp" },
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<GeneratedImage> {
	const format = request.format ?? "png";
	const body: Record<string, unknown> = { model: config.model, prompt: request.prompt, n: 1 };
	if (request.size) body.size = request.size;
	if (request.quality) body.quality = request.quality;
	if (config.model.startsWith("gpt-image")) body.output_format = format;
	else body.response_format = "b64_json";
	const response = await fetchImpl(`${config.baseUrl}/images/generations`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(300_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`image generation failed (${response.status}): ${text.slice(0, 300)}`);
	const first = (JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }).data?.[0];
	if (!first) throw new Error("image generation returned no image");
	const revised = first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {};
	if (first.b64_json)
		return { data: Uint8Array.from(Buffer.from(first.b64_json, "base64")), mime: MIME[format] ?? "image/png", ...revised };
	if (first.url) {
		const download = await fetchImpl(first.url, { signal: AbortSignal.timeout(120_000) });
		if (!download.ok) throw new Error(`downloading the image failed (${download.status})`);
		return { data: new Uint8Array(await download.arrayBuffer()), mime: download.headers.get("content-type") ?? "image/png", ...revised };
	}
	throw new Error("image generation returned neither b64_json nor url");
}
