/**
 * Conservative cheap-model routing (the original OASIS's model routing and
 * Hermes' smart_model_routing). Only clearly simple, read-only, short
 * questions go to the configured cheaper model; anything that may change the
 * workspace, needs repository lookups, mentions security, carries code or
 * images, or is a continuation ("yes", "go ahead") stays on the main model.
 * Unsure means strong.
 */
export type RouteTier = "easy" | "strong";

export interface RouteDecision {
	tier: RouteTier;
	reason: string;
}

const SAFETY =
	/\b(?:security|auth(?:entication|orization)?|permissions?|secrets?|credentials?|sandbox|threat model|prompt injection|vulnerab\w*|exploit)\b/i;
const MUTATION =
	/\b(?:edit|write|change|modify|create|add|remove|delete|fix|repair|implement|build|refactor|rename|move|update|upgrade|migrate|install|commit|push|deploy|run|execute|test|debug|generate|make|convert|setup|set up|configure)\b/i;
const HARD =
	/\b(?:architect(?:ure)?|redesign|production|performance|concurrency|race condition|database|schema|bug|defect|exception|stack trace|crash|failure|error|multiple files|whole (?:repo|repository|codebase)|entire (?:repo|codebase)|end.to.end|step by step|and then|as well as|several|compare|trade-?offs?|why)\b/i;
const REPO =
	/\b(?:this|the|my|our)\s+(?:repo|repository|codebase|workspace|project|code|file|function|class|module|tests?)\b|\b(?:call sites?|references?|usages?|definition|declaration|implementation)\b/i;
const FILE_OR_SYMBOL =
	/(?:^|[\s`"'(])(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:m?[jt]sx?|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|json|ya?ml|toml|md|html|css|sh)\b|\b[a-z]+[A-Z]\w*\s*\(|\b\w+_\w+\b/;
const CODE = /```|`[^`]+`|[{};]\s*$|=>|\b(?:function|const|let|var|def|class|import|return)\b/m;
const URL = /https?:\/\/|www\./i;
const CONTINUATION =
	/^(?:y(?:es|ep|eah)?|ok(?:ay)?|sure|go(?: ahead| on)?|do it|continue|proceed|keep going|next|please do|sounds good|lgtm|ship it|approved?|retry|again)[.! ]*$/i;
const EASY =
	/^(?:please\s+)?(?:what(?:'s| is| are| does)?|who|when|where|which|define|explain|summari[sz]e|describe|list|how (?:do|does|many|much)|is|are|can|tell me)\b/i;

export const EASY_MAX_CHARS = 280;
export const EASY_MAX_WORDS = 45;

export function classifyTask(prompt: string, options: { images?: boolean } = {}): RouteDecision {
	const text = prompt.trim();
	if (!text) return { tier: "strong", reason: "empty prompt" };
	if (options.images) return { tier: "strong", reason: "has images" };
	if (CONTINUATION.test(text)) return { tier: "strong", reason: "continues the previous task" };
	if (SAFETY.test(text)) return { tier: "strong", reason: "security-sensitive" };
	if (text.length > EASY_MAX_CHARS || text.split(/\s+/).length > EASY_MAX_WORDS) return { tier: "strong", reason: "long request" };
	if (CODE.test(text)) return { tier: "strong", reason: "contains code" };
	if (URL.test(text)) return { tier: "strong", reason: "contains a URL" };
	if (MUTATION.test(text)) return { tier: "strong", reason: "may change the workspace" };
	if (HARD.test(text)) return { tier: "strong", reason: "complex or multi-step" };
	if (REPO.test(text) || FILE_OR_SYMBOL.test(text)) return { tier: "strong", reason: "needs the repository" };
	if (!EASY.test(text) && !/\?\s*$/.test(text)) return { tier: "strong", reason: "not a plain question" };
	return { tier: "easy", reason: "short read-only question" };
}
