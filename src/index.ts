export { CheckpointError, type FileChange, isCheckpointableDir, type RestoreResult, ShadowRepo } from "./checkpoints/shadow-git.ts";
export { admitsUnverified, claimedFailedEdits, claimsPassing } from "./core/claims.ts";
export {
	DEFAULT_GATES,
	emptyReplyGate,
	failedEditClaimGate,
	falsePassClaimGate,
	type Gate,
	type GateFinding,
	type GateInput,
	openTodosGate,
	runGates,
	testTamperGate,
	unverifiedEditsGate,
} from "./core/gates.ts";
export { type CheckRun, TurnLedger } from "./core/ledger.ts";
export { analyzeTestChange, isTestConfigPath, isTestPath, type TamperFinding, userAllowsTestChanges } from "./core/test-tamper.ts";
export {
	CHECKPOINT_TYPE,
	type CheckpointData,
	type CheckpointOptions,
	createCheckpointsExtension,
	RESTORE_TYPE,
} from "./extensions/checkpoints.ts";
export { identityExtension, OASIS_GUIDELINES, OASIS_PREAMBLE, rewriteIdentity } from "./extensions/identity.ts";
export { oasisExtensions } from "./extensions/index.ts";
export { createMemoryExtension, type MemoryOptions } from "./extensions/memory.ts";
export { safetyExtension } from "./extensions/safety.ts";
export { createSandboxExtension, type SandboxExtensionOptions, type SandboxState } from "./extensions/sandbox.ts";
export { todoExtension } from "./extensions/todo.ts";
export { TOOL_REPAIR_TYPE, toolRepairExtension } from "./extensions/tool-repair.ts";
export { createTurnGatesExtension, GATE_NOTICE_TYPE, GATE_REMINDER_TYPE, type TurnGatesOptions } from "./extensions/turn-gates.ts";
export { entryText, ftsQuery, type IndexedMessage, type SearchHit, SessionIndex } from "./memory/session-index.ts";
export { MEMORY_LIMITS, MemoryError, MemoryStore, type MemoryTarget, scanMemoryText } from "./memory/store.ts";
export {
	buildRuntimePolicy,
	DEFAULT_ALLOWED_DOMAINS,
	isInside,
	loadUserSandboxConfig,
	type RuntimePolicy,
	SANDBOX_MODES,
	type SandboxMode,
	type UserSandboxConfig,
} from "./sandbox/policy.ts";
export { analyzeCheck, type CheckAnalysis, isCheckCommand } from "./shell/checks.ts";
export { evaluateShellCommand, type ShellVerdict } from "./shell/policy.ts";
export {
	isOpen,
	latestTodos,
	MAX_TODOS,
	normalizeTodos,
	renderTodos,
	TODO_STATUSES,
	TodoError,
	type TodoItem,
	type TodoStatus,
} from "./todo/list.ts";
export { type RepairedCall, repairToolCall, unknownToolMessage } from "./tools/repair.ts";
