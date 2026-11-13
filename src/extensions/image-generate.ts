/** `image_generate` tool (Hermes), registered when OASIS_IMAGE is set. See src/media/images.ts. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateImage, type ImageConfig, imageConfig } from "../media/images.ts";

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "image";

export function createImageGenerateExtension(options: { config?: ImageConfig; fetch?: typeof fetch } = {}) {
	return (pi: ExtensionAPI) => {
		const config = options.config ?? imageConfig();
		if (!config) return;
		pi.registerTool({
			name: "image_generate",
			label: "Image",
			description:
				"Generate an image from a text prompt and save it in the workspace (PNG by default). Use it for icons, illustrations, mockups, placeholder art and diagrams the user asks for. Returns the saved path and shows the image.",
			promptSnippet: "Generate an image from a prompt",
			parameters: Type.Object({
				prompt: Type.String({ description: "A detailed description of the image." }),
				path: Type.Optional(
					Type.String({ description: "Where to save it, relative to the workspace. Default .oasis/images/<prompt>.png" }),
				),
				size: Type.Optional(Type.String({ description: "For example 1024x1024, 1536x1024, 1024x1536 or auto." })),
				quality: Type.Optional(Type.String({ description: "low, medium, high or auto." })),
				format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")])),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const format = params.format ?? "png";
				const wanted =
					params.path?.trim() || `.oasis/images/${slug(params.prompt)}-${Date.now().toString(36)}.${format === "jpeg" ? "jpg" : format}`;
				const target = isAbsolute(wanted) ? wanted : resolve(ctx.cwd, wanted);
				const rel = relative(ctx.cwd, target);
				if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`image_generate: ${wanted} is outside the workspace`);
				const image = await generateImage(
					config,
					{ prompt: params.prompt, size: params.size, quality: params.quality, format },
					options.fetch ?? fetch,
					signal,
				);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, image.data);
				const note = `Saved ${rel} (${image.data.length} bytes, ${image.mime}).${image.revisedPrompt ? `\nRevised prompt: ${image.revisedPrompt}` : ""}`;
				return {
					content: [
						{ type: "text" as const, text: note },
						{ type: "image" as const, data: Buffer.from(image.data).toString("base64"), mimeType: image.mime },
					],
					details: { path: rel, bytes: image.data.length, model: config.model },
				};
			},
		});
	};
}
