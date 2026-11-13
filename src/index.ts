export {
	createWorktree,
	finishWorktree,
	gitTopLevel,
	listWorktrees,
	removeWorktree,
	runWorktreeSetup,
	type Worktree,
	worktreeSetupPlan,
} from "./agents/worktrees.ts";
export { CheckpointError, type FileChange, isCheckpointableDir, type RestoreResult, ShadowRepo } from "./checkpoints/shadow-git.ts";
export { type AiComment, AiCommentScanner, buildAiCommentPrompt, findAiComments } from "./code/ai-comments.ts";
export { PatchError, type PatchOperation, patchFromToolCall, planPatch } from "./code/apply-patch.ts";
export { analyzeCode, type Definition, grammarForFile, loadGrammar } from "./code/ast.ts";
export {
	AST_GREP_STRICTNESS,
	type AstGrepArgs,
	type AstGrepResult,
	applyReplacements,
	astGrepLanguages,
	editsForChange,
	formatAstGrep,
	loadAstGrep,
	runAstGrep,
} from "./code/ast-grep.ts";
export {
	BUILTIN_SERVERS,
	type CustomServer,
	type Diagnostic,
	formatDiagnostic,
	LSP_OPERATIONS,
	LspClient,
	LspManager,
	type LspManagerOptions,
	type LspOperation,
	locateSymbol,
	newDiagnostics,
	serverForFile,
	severityName,
} from "./code/lsp.ts";
export { buildRepoMap, extractDefinitions, listSourceFiles, type RepoMap, type RepoMapOptions } from "./code/repo-map.ts";
export { canCheckSyntax, checkFile, newProblems } from "./code/syntax-check.ts";
export { condenseEnabled, condenseOutput } from "./context/condense.ts";
export { readRange, supersedeResults } from "./context/supersede.ts";
export { type BreakerState, CircuitBreakers, PROVIDER_FAILURE } from "./core/circuit-breaker.ts";
export { admitsUnverified, claimedFailedEdits, claimsPassing } from "./core/claims.ts";
export { type CheckStatus, type DoctorCheck, type DoctorReport, formatDoctor, onPath, runDoctor } from "./core/doctor.ts";
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
export { type GoalJudge, type GoalState, modelJudge, parseVerdict, transcriptOf } from "./core/goal.ts";
export {
	announcesNextStep,
	asksForAction,
	claimsUnmadeChange,
	givesUpEarly,
	readsLikeInstructions,
	refusesSpuriously,
} from "./core/intent.ts";
export { type CheckRun, TurnLedger } from "./core/ledger.ts";
export { classifyTask, type RouteDecision } from "./core/model-routing.ts";
export { BUILTIN_STYLES, loadOutputStyles, type OutputStyle } from "./core/output-styles.ts";
export {
	CommandProgress,
	failureSignature,
	harmlessToRepeat,
	RERUN_NOTE,
	THRASH_ESCALATE_AT,
	THRASH_WARN_AT,
	thrashNote,
} from "./core/progress.ts";
export { applySafeMode, isSafeMode, SAFE_MODE_NOTICE, SAFE_MODE_PI_FLAGS } from "./core/safe-mode.ts";
export { formatSessionMessages, type SessionMessage, SessionMessenger } from "./core/session-messages.ts";
export { ADVISOR_SYSTEM, askSide, branchMessages, SIDE_SYSTEM } from "./core/side-model.ts";
export { cleanStatusText, loadStatusLine, runStatusLine, type StatusLineConfig } from "./core/status-line.ts";
export { analyzeTestChange, isTestConfigPath, isTestPath, type TamperFinding, userAllowsTestChanges } from "./core/test-tamper.ts";
export { cronCli } from "./cron/cli.ts";
export { agentPrompt, defaultOasisCommand, type RunnerOptions, runJob, runNow, SILENT_MARKER, tick } from "./cron/runner.ts";
export { graceMs, nextRun, parseDuration, parseSchedule, type Schedule, ScheduleError } from "./cron/schedule.ts";
export { CronError, type CronJob, type CronRun, CronStore, describeJob } from "./cron/store.ts";
export { createAgentIgnoreExtension } from "./extensions/agent-ignore.ts";
export { createAiCommentsExtension } from "./extensions/ai-comments.ts";
export { createAstGrepExtension } from "./extensions/ast-grep.ts";
export {
	CHECKPOINT_TYPE,
	type CheckpointData,
	type CheckpointOptions,
	createCheckpointsExtension,
	RESTORE_TYPE,
} from "./extensions/checkpoints.ts";
export { createCommitGateExtension } from "./extensions/commit-gate.ts";
export { type ContextSavingsOptions, createContextSavingsExtension } from "./extensions/context-savings.ts";
export { createCronExtension } from "./extensions/cron.ts";
export { createDoctorExtension } from "./extensions/doctor.ts";
export { createEditMatchExtension } from "./extensions/edit-match.ts";
export { createGitSafetyExtension } from "./extensions/git-safety.ts";
export { identityExtension, OASIS_GUIDELINES, OASIS_PREAMBLE, rewriteIdentity } from "./extensions/identity.ts";
export { oasisExtensions } from "./extensions/index.ts";
export { createLspExtension } from "./extensions/lsp.ts";
export { createMemoryExtension, type MemoryOptions } from "./extensions/memory.ts";
export { createNoopEditExtension } from "./extensions/noop-edit.ts";
export { createNotebookExtension } from "./extensions/notebook.ts";
export { createNotesExtension, RECALLED_NOTES_TYPE } from "./extensions/notes.ts";
export { createPackageVettingExtension } from "./extensions/package-vetting.ts";
export { createPermissionsExtension } from "./extensions/permissions.ts";
export { createProgressGuardExtension } from "./extensions/progress.ts";
export { createRepoMapExtension } from "./extensions/repo-map.ts";
export { safetyExtension } from "./extensions/safety.ts";
export { createSandboxExtension, type SandboxExtensionOptions, type SandboxState } from "./extensions/sandbox.ts";
export { createStandingCorrectionsExtension } from "./extensions/standing-corrections.ts";
export { createSyntaxCheckExtension } from "./extensions/syntax-check.ts";
export { todoExtension } from "./extensions/todo.ts";
export { TOOL_REPAIR_TYPE, toolRepairExtension } from "./extensions/tool-repair.ts";
export { createTurnGatesExtension, GATE_NOTICE_TYPE, GATE_REMINDER_TYPE, type TurnGatesOptions } from "./extensions/turn-gates.ts";
export { type ClaudeMcpServer, convertClaudeServer, expandClaudeVars, loadClaudeMcpServers } from "./mcp/claude.ts";
export { inspectMcpTool, McpPins, toolFingerprint } from "./mcp/trust.ts";
export { CorrectionStore, correctionViolations, extractCorrections } from "./memory/corrections.ts";
export { extractFollowups, type Followup, FollowupStore, formatFollowups } from "./memory/followups.ts";
export { NOTE_CATEGORIES, type Note, NoteStore, noteFreshness, tokenize as tokenizeNotes } from "./memory/notes.ts";
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
export {
	AGENT_IGNORE_FILES,
	type AgentIgnoreMatch,
	agentIgnoreMatch,
	agentIgnoreMessage,
	clearAgentIgnoreCache,
	ignoredByRules,
	isAgentIgnored,
	parseIgnoreFile,
} from "./security/agent-ignore.ts";
export { type CommitPlan, commitPlan, commitSecretHits, formatCommitSecretHits } from "./security/commit-gate.ts";
export {
	discardingCommand,
	discardReason,
	MAX_SAFETY_SNAPSHOTS,
	pruneSnapshots,
	type SafetySnapshot,
	snapshotNote,
	snapshotWorkingTree,
} from "./security/git-safety.ts";
export {
	bareName,
	editDistance,
	extractInstallTargets,
	type InstallTarget,
	type InstallVerdict,
	nearMiss,
	pinnedVersion,
	type VetResult,
	vetInstallCommand,
	vetPackage,
} from "./security/package-vetting.ts";
export {
	type Decision,
	describeRule,
	evaluatePermissions,
	globMatch,
	isPreApproved,
	type LoadedPermissions,
	loadPermissions,
	type PermissionRule,
	type PermissionVerdict,
	parseRule,
	ruleMatches,
	simpleCommands,
} from "./security/permissions.ts";
export {
	type ProtectedHit,
	protectedConfigPath,
	protectedConfigTarget,
	protectedEditsAllowed,
	protectedShellWrite,
} from "./security/protected-paths.ts";
export { findRuleSecrets, secretRuleCount, shannonEntropy } from "./security/rules.ts";
export {
	defaultVault,
	findSecrets,
	findSecretsInDiff,
	NO_UNMASK_TOOLS,
	redactSecrets,
	SECRET_SHIELD_NOTE,
	SecretVault,
	secretShieldEnabled,
} from "./security/secrets.ts";
export { gitInvocation } from "./shell/ast.ts";
export { type BackgroundJob, BackgroundShells, describeJob as describeBackgroundJob } from "./shell/background.ts";
export { analyzeCheck, type CheckAnalysis, isCheckCommand } from "./shell/checks.ts";
export { MonitorFeed, stripControl } from "./shell/monitor.ts";
export { evaluateShellCommand, type ShellVerdict } from "./shell/policy.ts";
export { analyzeShellRisk, isCriticalPath, type ShellRisk } from "./shell/risk.ts";
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
export { closestMatchHint, type RelaxedMatch, relaxedMatch } from "./tools/edit-match.ts";
export { candidatePaths, noOpEditWarning, type ScriptedEditSnapshot, scriptedEditKind, snapshotScriptedEdit } from "./tools/noop-edit.ts";
export {
	editNotebook,
	isNotebookPath,
	NOTEBOOK_CELL_TYPES,
	NOTEBOOK_EDIT_MODES,
	type Notebook,
	parseNotebook,
	readNotebook,
	renderNotebook,
} from "./tools/notebook.ts";
export { expandPatchCall } from "./tools/patch-calls.ts";
export { type RepairedCall, repairToolCall, unknownToolMessage } from "./tools/repair.ts";
export { ensureScratch, isScratchPath, SCRATCH_ROOT, scratchKey, scratchPrompt } from "./workspace/scratch.ts";
