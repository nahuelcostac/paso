/**
 * Common interface for in-app agent harnesses (Claude Code, Codex, agy).
 *
 * A harness adapter runs ONE turn: one user message in, a stream of normalized events out.
 * Sessions, concurrency, cancellation bookkeeping and resume live in `sessions.ts`, so an
 * adapter only translates between this interface and one CLI. Nothing in these types is
 * specific to a particular CLI: `resumeToken` is opaque and tool names are Paso board tools.
 */
export const harnessIds = ['claude', 'codex', 'agy'] as const;
export type HarnessId = typeof harnessIds[number];

/** Which board step a tool call touches, when the call says so. IDs are service IDs. */
export type ToolTarget = { projectId?: string; sceneId?: string; stepId?: string };

export type FailureCode =
  | 'not_installed' // The executable is missing.
  | 'signed_out' // The user's own login is missing or expired.
  | 'quota' // Subscription limit reached.
  | 'model_unavailable' // The requested model cannot be used with this account.
  | 'unsupported_version' // The installed CLI rejected a required option.
  | 'unsafe_configuration' // The harness exposed something beyond the board tools; the run was stopped.
  | 'board_unavailable' // The Paso board tools did not start.
  | 'timeout' // No output for too long, or the run exceeded its maximum duration.
  | 'crashed' // The process ended without finishing the turn.
  | 'protocol' // Output that cannot be understood.
  | 'blocked' // A run hook refused to start the run.
  | 'harness_error'; // Any other error reported by the harness.

/** Events an adapter emits for one turn. Exactly one `finished` or `failed` ends the stream. */
export type AgentEvent =
  /** Added by Paso when a run is accepted, before the harness starts. Adapters never emit it. */
  | { type: 'started' }
  /** The harness identified its conversation. Store `resumeToken` to continue the session later. */
  | { type: 'session'; resumeToken: string; model?: string }
  /** Incremental assistant text. A later `text` event repeats the complete block. */
  | { type: 'text_delta'; text: string }
  /** A complete assistant text block. */
  | { type: 'text'; text: string }
  /** The agent called a board tool. Arguments are never forwarded, only the target. */
  | { type: 'tool_use'; id: string; tool: string; readOnly: boolean; target?: ToolTarget }
  | { type: 'tool_result'; id: string; ok: boolean }
  | { type: 'finished'; reason: 'completed' | 'cancelled' }
  | { type: 'failed'; code: FailureCode; message: string };

export type AgentRunRequest = {
  /** Absolute path of the executable, as resolved by harness detection. */
  executable: string;
  /** Neutral, empty directory the process runs in. */
  workDir: string;
  /** The user's text. It reaches the harness only as message content. */
  text: string;
  /** Continue an earlier conversation. */
  resumeToken?: string;
  /** Passed only when set. Otherwise the CLI's own default applies. */
  model?: string;
  context: { projectId: string; sceneId?: string };
  board: {
    /** Loopback origin of this service. */
    serviceUrl: string;
    /** The service token. Adapters must hand it over through the environment, never argv or files. */
    sessionToken: string;
    /** How to start the Paso MCP server. */
    mcp: { command: string; args: string[]; browserExecutable?: string };
  };
  limits: { idleTimeoutMs: number; maxRunMs: number };
};

export interface HarnessAdapter {
  readonly id: HarnessId;
  /**
   * Runs one turn and yields events. Never throws. Aborting `signal` stops the whole process
   * tree and ends the stream with `finished` (reason `cancelled`).
   */
  run(request: AgentRunRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

/** What a run hook sees. Restore points (AG-03, connected by IN-04) attach here. */
export type AgentRunContext = {
  sessionId: string;
  runId: string;
  harness: HarnessId;
  projectId: string;
  sceneId?: string;
};
export type AgentRunOutcome = { status: 'completed' | 'cancelled' | 'failed'; failure?: FailureCode };
export type AgentRunHooks = {
  /**
   * Called once before a run starts the harness, after the run was accepted. If it throws, the
   * run does not start and ends with a `failed` event of code `blocked`.
   */
  beforeRun?(context: AgentRunContext): Promise<void> | void;
  /**
   * Called once after the run has ended, whatever the outcome, and after its terminal event was
   * emitted. Errors are ignored: a finished run cannot be failed afterwards.
   */
  afterRun?(context: AgentRunContext, outcome: AgentRunOutcome): Promise<void> | void;
};
