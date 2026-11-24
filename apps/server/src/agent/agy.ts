import { execFile } from 'node:child_process';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { idSchema } from '@paso/shared';
import { describeSteps, describeTarget } from './where.js';
import { forgetAgy } from './forget.js';
import { harnessEnvironment, startProcess, type ManagedProcess } from './process.js';
import type { AgentEvent, AgentRunRequest, FailureCode, HarnessAdapter, ToolTarget } from './types.js';

/**
 * Antigravity (`agy`) runs one turn in print mode with `stream-json` on stdin and stdout.
 *
 * The board-only policy is agy's own custom agent, which Paso writes to a workspace it owns (see `agyAgentFile`):
 * no built-in tools or default components, none of the person's skills, rules, plugins, subagents or MCP servers,
 * and the Paso board as its only MCP server. agy's `init` event lists the default tool set whatever the agent
 * allows, so it cannot prove the policy. What Paso checks instead, before the person's message is written to stdin:
 * the installed version is one this policy was verified with or newer, and the session runs the Paso agent (an
 * agent file agy cannot load makes it refuse to start, it never falls back to its default agent). While the turn
 * runs, any tool call other than a board tool on the Paso server stops the whole process tree.
 */
export const agyAgentName = 'paso-board';
export const agyServerName = 'paso';
/** The version the board-only agent was verified with (AG-07). Older versions are refused. */
export const agyMinimumVersion = '1.5.16';
export const agyBoardTools = [
  'list_projects', 'read_project', 'read_scene', 'read_step', 'get_step_image',
  'create_scene', 'create_step', 'duplicate_step', 'update_step', 'delete_step', 'add_elements', 'update_elements', 'delete_elements',
] as const;
const readOnlyTools = new Set<string>(agyBoardTools.slice(0, 5));
/** agy reaches MCP servers through these tools. Only calls naming the Paso server and a board tool are allowed. */
const mcpCallTools = new Set(['call_mcp_tool']);
const mcpResourceTools = new Set(['list_resources', 'read_resource']);

const messages: Record<FailureCode, string> = {
  not_installed: "Antigravity wasn't found. Install it and try again.",
  signed_out: "Antigravity isn't signed in. Run \"agy\" in a terminal, sign in and try again.",
  quota: "You've reached the usage limit of your Antigravity plan. Wait for it to reset and try again.",
  model_unavailable: "The requested model isn't available with your Antigravity account.",
  unsupported_version: `Your version of Antigravity doesn't support this. Update Antigravity (${agyMinimumVersion} or newer) and try again.`,
  unsafe_configuration: 'Antigravity tried to use something that is not a board tool. The run was stopped for safety.',
  board_unavailable: "The board tools couldn't start. Check that Paso is built.",
  timeout: 'Antigravity stopped responding and was stopped.',
  crashed: 'Antigravity closed unexpectedly.',
  protocol: "Antigravity sent a response Paso doesn't understand.",
  blocked: "Couldn't prepare the run. Try again.",
  harness_error: 'Antigravity ended with an error.',
};
export const agyFailureMessage = (code: FailureCode) => messages[code];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => typeof value === 'string' ? value : undefined;

/** The folder agy runs in: Paso's, next to the agent workspace, holding only the Paso agent. */
export const agyWorkspace = (workDir: string) => join(dirname(workDir), 'agy-workspace');

/**
 * The custom agent. Strings are written as JSON, which YAML reads as the same quoted strings, so no path can break
 * the frontmatter. The service token is not here: the MCP server inherits it from agy's environment.
 *
 *  - `tools: []` and `excludeDefaultComponents: true`: no built-in tools (shell, files, web, browser, subagents).
 *  - `inheritCustomizations: false` and `inheritMcp: false`: none of the person's skills, rules, plugins, subagents
 *    or MCP servers, wherever they are configured.
 *  - `mcpServers`: the Paso board, the only server.
 *  - `subagent: false`, `hidden: true`: it is only ever Paso's main agent.
 */
export function agyAgentFile(request: Pick<AgentRunRequest, 'board'>) {
  const json = JSON.stringify;
  return [
    '---',
    `name: ${agyAgentName}`,
    'description: Paso board assistant. Only Paso uses it.',
    'mainAgent: true',
    'subagent: false',
    'hidden: true',
    'excludeDefaultComponents: true',
    'inheritCustomizations: false',
    'inheritMcp: false',
    'tools: []',
    'mcpServers:',
    `  - name: ${agyServerName}`,
    `    command: ${json(request.board.mcp.command)}`,
    `    args: ${json(request.board.mcp.args)}`,
    '---',
    '# Paso',
    "You are Paso's assistant, in a whiteboard editor for explaining things step by step.",
    "You can only use Paso's board tools, on the paso MCP server: there is no terminal, no files and no web.",
    'Each message starts with where you are working, in service IDs. Read a step before you edit it.',
    "Reply briefly, in the language of the user's message.",
    '',
  ].join('\n');
}

/**
 * Settings for this session only; agy never saves them. Headless runs deny any tool that needs permission and is not
 * allowed, so only the board's MCP tools are allowed, and the other kinds are denied by name as a second layer.
 */
export const agySettings = () => ({
  permissions: { allow: [`mcp(${agyServerName}/*)`], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)'] },
});

/** Exact arguments of one turn. The person's text is not here: it goes to stdin as message content. */
export function agyArguments(request: Pick<AgentRunRequest, 'resumeToken' | 'model' | 'effort'>) {
  return [
    '--agent', agyAgentName,
    '--settings', JSON.stringify(agySettings()),
    '--disable-slash-commands',
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort ? ['--effort', request.effort] : []),
    ...(request.resumeToken ? ['--conversation', request.resumeToken] : []),
    // Print mode with no prompt in argv: the turn comes from stdin.
    '-p=',
  ];
}

export function agyEnvironment(request: Pick<AgentRunRequest, 'board'>, source: NodeJS.ProcessEnv = process.env) {
  return harnessEnvironment({
    // The board MCP server inherits these from agy. agy itself has no tool that could read them.
    PASO_SERVICE_URL: request.board.serviceUrl,
    PASO_SESSION_TOKEN: request.board.sessionToken,
    ...(request.board.mcp.browserExecutable ? { PASO_MCP_BROWSER_EXECUTABLE: request.board.mcp.browserExecutable } : {}),
    ...(request.board.mcp.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }, source);
}

/**
 * The turn's one stdin line. agy's stream input takes text blocks only, so a message with images never gets here
 * (`acceptsImages` is false). Where the agent works is said first, as the agent file is the same for every session.
 */
export function agyInput(request: Pick<AgentRunRequest, 'text' | 'context'>) {
  const where = `[Paso] You are working in the ${describeTarget(request.context)} (service IDs).${describeSteps(request.context.steps)}`;
  return JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: request.text ? `${where}\n\n${request.text}` : where }] } });
}

/** Decides a failure from what agy said. Text is only inspected, never forwarded. */
export function classifyAgyFailure(text: string): FailureCode {
  const t = text.toLowerCase();
  if (/authentication (required|failed)|not logged in|please sign in|log in, then retry|stored credentials are (expired|revoked)/.test(t)) return 'signed_out';
  if (/resource_exhausted|\b429\b|quota|rate.?limit|usage limit|limit reached/.test(t)) return 'quota';
  if (/invalid model selection|not recognized as a known model|model .*not (found|available)|conflicts with --effort/.test(t)) return 'model_unavailable';
  if (/unknown agent|flags? provided but not defined|unknown flag|invalid value for setting/.test(t)) return 'unsupported_version';
  return 'harness_error';
}

function targetOf(input: unknown): ToolTarget | undefined {
  if (!isRecord(input)) return undefined;
  const target: ToolTarget = {};
  for (const key of ['projectId', 'sceneId', 'stepId'] as const) {
    const parsed = idSchema.safeParse(input[key]);
    if (parsed.success) target[key] = parsed.data;
  }
  return Object.keys(target).length ? target : undefined;
}

/** Translates agy's `stream-json` lines into normalized events. One instance per turn. */
export class AgyStream {
  conversation?: string;
  ready = false;
  finished = false;
  private texts = new Map<number, string>();
  private tools = new Map<number, string>();
  private malformed = 0;
  constructor(private resumeToken?: string) {}

  line(raw: string): AgentEvent[] {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return this.bad(); }
    if (!isRecord(data) || typeof data.event !== 'string') return this.bad();
    switch (data.event) {
      case 'init': return this.init(data);
      case 'step_update': return this.ready ? this.step(data.step_update) : this.fail('protocol');
      case 'result': return this.result(data.result);
      default: return []; // Other events are not part of the contract.
    }
  }
  private bad(): AgentEvent[] {
    return ++this.malformed > 20 ? this.fail('protocol') : [];
  }
  private fail(code: FailureCode): AgentEvent[] { return [{ type: 'failed', code, message: messages[code] }]; }
  private init(data: Record<string, unknown>): AgentEvent[] {
    if (this.ready) return this.fail('protocol');
    const init = isRecord(data.init) ? data.init : undefined;
    // Fail closed: the session must run Paso's agent, never agy's default one.
    if (!init || init.agent !== agyAgentName) return this.fail('unsafe_configuration');
    const id = str(data.conversation_id);
    if (!id || (this.resumeToken && id !== this.resumeToken)) return this.fail('protocol');
    this.conversation = id;
    this.ready = true;
    return [{ type: 'session', resumeToken: id, ...(str(init.model) ? { model: str(init.model)! } : {}) }];
  }
  private step(update: unknown): AgentEvent[] {
    if (!isRecord(update) || typeof update.step_index !== 'number') return this.bad();
    if (update.conversation_id !== undefined && update.conversation_id !== this.conversation) return this.fail('protocol');
    const index = update.step_index;
    // Anything that names a tool is checked, whatever its step type.
    if (update.step_type === 'tool' || update.tool_name !== undefined || update.tool_info !== undefined) return this.tool(index, update);
    if (update.step_type !== 'agent_response') return [];
    const out: AgentEvent[] = [];
    const delta = str(update.text_delta);
    if (delta) {
      this.texts.set(index, (this.texts.get(index) ?? '') + delta);
      out.push({ type: 'text_delta', text: delta });
    }
    if (update.state === 'DONE' || update.state === 'ERROR') {
      const text = (this.texts.get(index) ?? '').trim();
      this.texts.delete(index);
      if (text) out.push({ type: 'text', text });
    }
    return out;
  }
  /**
   * Which board tool a tool step calls, or undefined when it is anything else. agy names an always-loaded MCP tool
   * `mcp_<server>_<tool>` with the tool's own arguments; a tool it discovers on demand goes through `call_mcp_tool`.
   */
  private boardCall(name: string | undefined, parameters: Record<string, unknown>) {
    const isBoard = (tool: unknown): tool is string => typeof tool === 'string' && (agyBoardTools as readonly string[]).includes(tool);
    const prefix = `mcp_${agyServerName}_`;
    if (name?.startsWith(prefix) && isBoard(name.slice(prefix.length))) return { tool: name.slice(prefix.length), input: parameters };
    if (name !== undefined && mcpCallTools.has(name) && parameters.ServerName === agyServerName && isBoard(parameters.ToolName)) {
      return { tool: parameters.ToolName, input: parameters.Arguments };
    }
    return undefined;
  }
  private tool(index: number, update: Record<string, unknown>): AgentEvent[] {
    const info = isRecord(update.tool_info) ? update.tool_info : {};
    const name = str(update.tool_name) ?? str(info.name);
    const parameters = isRecord(info.parameters) ? info.parameters : {};
    const board = this.boardCall(name, parameters);
    // Reading MCP resources only reaches the servers of this agent, and Paso's is the only one.
    const resource = name !== undefined && mcpResourceTools.has(name) && (parameters.ServerName === undefined || parameters.ServerName === agyServerName);
    if (!board && !resource) return this.fail('unsafe_configuration');
    const tool = board ? board.tool : name!;
    const seen = this.tools.get(index);
    if (seen !== undefined && seen !== tool) return this.fail('unsafe_configuration');
    const id = `${this.conversation}:${index}`;
    const out: AgentEvent[] = [];
    if (seen === undefined) {
      this.tools.set(index, tool);
      const target = board ? targetOf(board.input) : undefined;
      out.push({ type: 'tool_use', id, tool, readOnly: !board || readOnlyTools.has(tool), ...(target ? { target } : {}) });
    }
    if (update.state === 'DONE' || update.state === 'ERROR') out.push({ type: 'tool_result', id, ok: update.state === 'DONE' && info.error === undefined });
    return out;
  }
  private result(result: unknown): AgentEvent[] {
    this.finished = true;
    if (!isRecord(result)) return this.fail('protocol');
    if (result.status === 'SUCCESS') return [{ type: 'finished', reason: 'completed' }];
    if (result.finished_reason === 'interrupted' || result.finished_reason === 'cancelled') return [{ type: 'finished', reason: 'cancelled' }];
    return this.fail(classifyAgyFailure(str(result.error) ?? ''));
  }
}

const versionParts = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10));
export function agyVersionSupported(version: string | null) {
  if (!version) return false;
  const [have, need] = [versionParts(version), versionParts(agyMinimumVersion)];
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i];
  }
  return true;
}
/** The installed version, or `missing` when there is no executable to ask. */
function installedVersion(executable: string, env: Record<string, string>): Promise<string | null | 'missing'> {
  return new Promise((done) => execFile(executable, ['--version'], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, env },
    (error, stdout) => done((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing'
      : error ? null : String(stdout).match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null)));
}

/** Writes the agent to Paso's agy workspace. The folder must be a real directory Paso owns, not a link elsewhere. */
export async function prepareAgy(request: Pick<AgentRunRequest, 'workDir' | 'board'>) {
  const workspace = agyWorkspace(request.workDir);
  const agents = join(workspace, '.agents', 'agents');
  // Each level is created and checked on its own, so a link is never followed to create folders elsewhere.
  for (const folder of [workspace, join(workspace, '.agents'), agents]) {
    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_configuration');
  }
  const file = join(agents, `${agyAgentName}.md`);
  const temp = join(agents, `.${agyAgentName}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temp, agyAgentFile(request), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
  return workspace;
}

/** After a turn's `result`, a process that does not leave by itself is stopped after this long. */
const exitGraceMs = 5000;

export const agyAdapter: HarnessAdapter = {
  id: 'agy',
  // agy's stream input takes text only. The paperclip is disabled and the service refuses images before sending.
  acceptsImages: false,
  failureMessage: agyFailureMessage,
  forget: (token) => forgetAgy(token),
  async *run(request, signal) {
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let outcome: AgentEvent | undefined;
    let proc: ManagedProcess | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const push = (event: AgentEvent) => { events.push(event); wake?.(); };
    const note = (event: AgentEvent) => {
      if (outcome) return;
      if (event.type !== 'finished' && event.type !== 'failed') { push(event); return; }
      outcome = event;
      if (event.type === 'failed') void proc?.stop();
      else grace = setTimeout(() => void proc?.stop(), exitGraceMs);
    };
    const env = agyEnvironment(request);
    try {
      const version = await installedVersion(request.executable, env);
      if (version === 'missing') { yield { type: 'failed', code: 'not_installed', message: messages.not_installed }; return; }
      if (!agyVersionSupported(version)) { yield { type: 'failed', code: 'unsupported_version', message: messages.unsupported_version }; return; }
      const cwd = await prepareAgy(request);
      if (signal.aborted) { yield { type: 'finished', reason: 'cancelled' }; return; }
      const stream = new AgyStream(request.resumeToken);
      proc = startProcess({ file: request.executable, args: agyArguments(request), cwd, env, input: '', keepStdinOpen: true }, {
        onLine: (line) => {
          const wasReady = stream.ready;
          for (const event of stream.line(line)) note(event);
          // The message goes in only once agy said it runs Paso's agent.
          if (!wasReady && stream.ready && !outcome) { proc?.write(agyInput(request)); proc?.endInput(); }
        },
        idleTimeoutMs: request.limits.idleTimeoutMs, maxRunMs: request.limits.maxRunMs, maxLineBytes: 64 * 1024 * 1024, signal,
      });
      void proc.done.then((end) => {
        clearTimeout(grace);
        if (!outcome) {
          const fromStderr = classifyAgyFailure(end.stderrTail);
          const code: FailureCode | 'cancelled' =
            end.reason === 'aborted' ? 'cancelled'
              : end.reason === 'idle' || end.reason === 'max-time' ? 'timeout'
                : end.reason === 'line-too-long' ? 'protocol'
                  : end.reason === 'spawn-error' ? (end.spawnErrorCode === 'ENOENT' ? 'not_installed' : 'crashed')
                    : fromStderr !== 'harness_error' ? fromStderr : 'crashed';
          outcome = code === 'cancelled' ? { type: 'finished', reason: 'cancelled' } : { type: 'failed', code, message: messages[code] };
        }
        ended = true; wake?.();
      });
      for (;;) {
        if (events.length) { yield events.shift()!; continue; }
        if (ended) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } catch (error) {
      // Only preparing the workspace throws: a linked folder is unsafe, any other failure leaves nothing to run.
      const code: FailureCode = error instanceof Error && error.message === 'unsafe_configuration' ? 'unsafe_configuration' : 'blocked';
      if (signal.aborted) outcome ??= { type: 'finished', reason: 'cancelled' };
      else outcome ??= { type: 'failed', code, message: messages[code] };
    } finally {
      clearTimeout(grace);
      await proc?.stop();
    }
    yield outcome ?? { type: 'failed', code: 'protocol', message: messages.protocol };
  },
};
