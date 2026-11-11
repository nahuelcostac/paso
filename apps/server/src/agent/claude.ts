import { idSchema } from '@paso/shared';
import { forgetClaude } from './forget.js';
import { harnessEnvironment, startProcess } from './process.js';
import type { AgentEvent, AgentRunRequest, FailureCode, HarnessAdapter, ToolTarget } from './types.js';

/** The name the Paso board server is registered under. Claude names its tools `mcp__<server>__<tool>`. */
export const boardServerName = 'paso';
const toolPrefix = `mcp__${boardServerName}__`;
const readOnlyTools = new Set(['list_projects', 'read_project', 'read_scene', 'read_step', 'get_step_image']);

/**
 * Built-in tools denied by name as well. With `--tools ""` none of them exist, so this list is a
 * second layer that only matters if the allow-list were ever widened by mistake.
 */
const deniedBuiltIns = [
  'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'Monitor', 'ToolSearch', 'RemoteTrigger', 'CronCreate', 'EnterWorktree',
];

const messages: Record<FailureCode, string> = {
  not_installed: 'No se ha encontrado Claude Code. Instálalo y vuelve a intentarlo.',
  signed_out: 'Claude Code no tiene la sesión iniciada. Ejecuta «claude» en una terminal, inicia sesión y vuelve a intentarlo.',
  quota: 'Has alcanzado el límite de uso de tu suscripción de Claude. Espera a que se restablezca e inténtalo de nuevo.',
  model_unavailable: 'El modelo pedido no está disponible con tu cuenta de Claude.',
  unsupported_version: 'Tu versión de Claude Code no admite esta función. Actualiza Claude Code e inténtalo de nuevo.',
  unsafe_configuration: 'Claude Code ofreció herramientas que no son del tablero. Se ha detenido la ejecución por seguridad.',
  board_unavailable: 'No se pudieron iniciar las herramientas del tablero. Comprueba que Paso está compilado.',
  timeout: 'Claude Code dejó de responder y se ha detenido.',
  crashed: 'Claude Code se cerró de forma inesperada.',
  protocol: 'Claude Code devolvió una respuesta que Paso no entiende.',
  blocked: 'No se pudo preparar la ejecución. Inténtalo de nuevo.',
  harness_error: 'Claude Code terminó con un error.',
};
export const failureMessage = (code: FailureCode) => messages[code];

/**
 * Exact arguments of one turn. The user's text is not here: it goes to stdin as message content.
 *
 * Safety controls, each one the CLI's own:
 *  - `--tools ""`: the set of built-in tools is an allow-list and it is empty. A built-in added by
 *    a future version is not enabled.
 *  - `--strict-mcp-config` and `--mcp-config`: the only MCP server is the Paso board. User, project
 *    and account (claude.ai connector) servers are ignored.
 *  - `--allowedTools mcp__paso__*`: only the board tools are pre-approved.
 *  - `--permission-mode dontAsk` and `--permission-prompts none`: anything not pre-approved is
 *    denied and nobody is asked. `bypassPermissions` and `--dangerously-skip-permissions` are never used.
 *  - `--setting-sources ""`: no user, project or local settings, hooks or CLAUDE.md files.
 *  - `--disable-slash-commands`: text starting with `/` is not a command or skill.
 */
export function claudeArguments(request: Pick<AgentRunRequest, 'resumeToken' | 'model' | 'effort' | 'context' | 'board'>) {
  const mcp = {
    mcpServers: {
      [boardServerName]: {
        type: 'stdio', command: request.board.mcp.command, args: request.board.mcp.args,
        // Expanded by Claude Code from its own environment, so neither argv nor a file holds the token.
        env: {
          PASO_SERVICE_URL: '${PASO_SERVICE_URL}', PASO_SESSION_TOKEN: '${PASO_SESSION_TOKEN}',
          ...(request.board.mcp.browserExecutable ? { PASO_MCP_BROWSER_EXECUTABLE: '${PASO_MCP_BROWSER_EXECUTABLE}' } : {}),
        },
      },
    },
  };
  const where = request.context.sceneId
    ? `proyecto «${request.context.projectId}», escena «${request.context.sceneId}»`
    : `proyecto «${request.context.projectId}»`;
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--allowedTools', `${toolPrefix}*`,
    '--disallowedTools', ...deniedBuiltIns,
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--append-system-prompt',
    `Eres el asistente de Paso, un editor de pizarras paso a paso. Trabajas en el ${where} (IDs de servicio). ` +
    'Solo puedes usar las herramientas del tablero de Paso: no hay terminal, archivos ni web. ' +
    'Lee el paso antes de editarlo y responde en español, de forma breve.',
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort ? ['--effort', request.effort] : []),
    ...(request.resumeToken ? ['--resume', request.resumeToken] : []),
  ];
}

export function claudeEnvironment(request: Pick<AgentRunRequest, 'board'>, source: NodeJS.ProcessEnv = process.env) {
  return harnessEnvironment({
    PASO_SERVICE_URL: request.board.serviceUrl,
    PASO_SESSION_TOKEN: request.board.sessionToken,
    ...(request.board.mcp.browserExecutable ? { PASO_MCP_BROWSER_EXECUTABLE: request.board.mcp.browserExecutable } : {}),
    // Belt and braces next to `--setting-sources ""`: no CLAUDE.md files, no auto memory.
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  }, source);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => typeof value === 'string' ? value : undefined;

function targetOf(input: unknown): ToolTarget | undefined {
  if (!isRecord(input)) return undefined;
  const target: ToolTarget = {};
  for (const key of ['projectId', 'sceneId', 'stepId'] as const) {
    const parsed = idSchema.safeParse(input[key]);
    if (parsed.success) target[key] = parsed.data;
  }
  return Object.keys(target).length ? target : undefined;
}

/** Decides a failure from what Claude said. Text is only inspected, never forwarded. */
export function classifyClaudeFailure(signals: { apiError?: string; text?: string; httpStatus?: number | null; limitRejected?: boolean; stderr?: string }): FailureCode {
  const text = `${signals.apiError ?? ''}\n${signals.text ?? ''}`.toLowerCase();
  if (signals.apiError === 'authentication_failed' || /not logged in|\/login|invalid api key|oauth token|token has expired|authentication/.test(text) || signals.httpStatus === 401) return 'signed_out';
  if (signals.limitRejected || signals.apiError === 'rate_limit' || signals.apiError === 'billing_error' || signals.httpStatus === 429
    || /hit your limit|usage limit|rate.?limit|limit reached|out of (extra )?usage|quota|credit balance/.test(text)) return 'quota';
  if (/model/.test(text) && /not found|not available|invalid|(does|may) not exist|unknown|no access|not have access/.test(text)) return 'model_unavailable';
  if (/unknown option|unknown argument|unrecognized option|invalid option/.test((signals.stderr ?? '').toLowerCase())) return 'unsupported_version';
  if (/not logged in|\/login/.test((signals.stderr ?? '').toLowerCase())) return 'signed_out';
  return 'harness_error';
}

/** Translates Claude's `stream-json` lines into normalized events. One instance per turn. */
export class ClaudeStream {
  sessionSeen = false;
  finished = false;
  private apiError?: string;
  private apiText?: string;
  private limitRejected = false;
  private malformed = 0;

  /** Returns the events for one line, or a failure when the output violates the safety contract. */
  line(raw: string): AgentEvent[] {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return this.bad(); }
    if (!isRecord(data) || typeof data.type !== 'string') return this.bad();
    switch (data.type) {
      case 'system': return data.subtype === 'init' ? this.init(data) : [];
      case 'stream_event': return this.partial(data.event);
      case 'assistant': return this.assistant(data);
      case 'user': return this.user(data);
      case 'rate_limit_event': {
        if (isRecord(data.rate_limit_info) && data.rate_limit_info.status === 'rejected') this.limitRejected = true;
        return [];
      }
      case 'result': return this.result(data);
      default: return []; // Other message types are not part of the contract; ignore them.
    }
  }
  private bad(): AgentEvent[] {
    // A stray non-JSON line is tolerated. A stream of them is not a protocol we understand.
    return ++this.malformed > 20 ? [{ type: 'failed', code: 'protocol', message: messages.protocol }] : [];
  }
  private init(data: Record<string, unknown>): AgentEvent[] {
    const tools = Array.isArray(data.tools) ? data.tools : null;
    const servers = Array.isArray(data.mcp_servers) ? data.mcp_servers : null;
    // Fail closed: if the session offers anything other than the board tools, do not let it work.
    if (!tools || !servers || data.permissionMode !== 'dontAsk'
      || !tools.every((tool) => typeof tool === 'string' && tool.startsWith(toolPrefix))
      || !servers.every((server) => isRecord(server) && server.name === boardServerName)) {
      return [{ type: 'failed', code: 'unsafe_configuration', message: messages.unsafe_configuration }];
    }
    if ((!servers.length || !tools.length || !servers.every((server) => isRecord(server) && server.status === 'connected'))) {
      return [{ type: 'failed', code: 'board_unavailable', message: messages.board_unavailable }];
    }
    this.sessionSeen = true;
    const id = str(data.session_id);
    return id ? [{ type: 'session', resumeToken: id, ...(str(data.model) ? { model: str(data.model)! } : {}) }] : [];
  }
  private partial(event: unknown): AgentEvent[] {
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) return [];
    const text = event.delta.type === 'text_delta' ? str(event.delta.text) : undefined;
    return text ? [{ type: 'text_delta', text }] : [];
  }
  private assistant(data: Record<string, unknown>): AgentEvent[] {
    if (data.parent_tool_use_id) return []; // Sub-agent traffic is not part of the conversation.
    const message = data.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    const out: AgentEvent[] = [];
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        if (typeof data.error === 'string') { this.apiError = data.error; this.apiText = block.text; } // An API error, not agent speech.
        else out.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (!block.name.startsWith(toolPrefix)) {
          return [{ type: 'failed', code: 'unsafe_configuration', message: messages.unsafe_configuration }];
        }
        const tool = block.name.slice(toolPrefix.length);
        const target = targetOf(block.input);
        out.push({ type: 'tool_use', id: block.id, tool, readOnly: readOnlyTools.has(tool), ...(target ? { target } : {}) });
      }
    }
    if (typeof data.error === 'string' && !this.apiError) this.apiError = data.error;
    return out;
  }
  private user(data: Record<string, unknown>): AgentEvent[] {
    const message = data.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    const out: AgentEvent[] = [];
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        out.push({ type: 'tool_result', id: block.tool_use_id, ok: block.is_error !== true });
      }
    }
    return out;
  }
  private result(data: Record<string, unknown>): AgentEvent[] {
    this.finished = true;
    if (data.is_error !== true) return [{ type: 'finished', reason: 'completed' }];
    const code = classifyClaudeFailure({
      apiError: this.apiError, text: this.apiText ?? str(data.result), limitRejected: this.limitRejected,
      httpStatus: typeof data.api_error_status === 'number' ? data.api_error_status : null,
    });
    return [{ type: 'failed', code, message: messages[code] }];
  }
}

/** Async queue so the adapter can be a generator over process callbacks. */
function queue<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(item: T) { items.push(item); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift()!; continue; }
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}

/** After a turn's `result`, a process that does not leave by itself is stopped after this long. */
const exitGraceMs = 5000;

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  forget: (token, workDir) => forgetClaude(token, workDir),
  run(request, signal) {
    const events = queue<AgentEvent>();
    const stream = new ClaudeStream();
    // The terminal event is held back until the whole process tree is gone, so "finished" means
    // nothing of this run is still running and the next message can start at once.
    let outcome: AgentEvent | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const note = (event: AgentEvent) => {
      if (outcome) return;
      if (event.type !== 'finished' && event.type !== 'failed') { events.push(event); return; }
      outcome = event;
      const mustStop = event.type === 'failed' && (event.code === 'unsafe_configuration' || event.code === 'board_unavailable' || event.code === 'protocol');
      if (mustStop) void proc.stop();
      else grace = setTimeout(() => void proc.stop(), exitGraceMs);
    };
    const proc = startProcess({
      file: request.executable, args: claudeArguments(request), cwd: request.workDir,
      env: claudeEnvironment(request),
      // Only content, never a command line: JSON on stdin.
      input: JSON.stringify({ type: 'user', message: { role: 'user', content: request.text } }),
    }, {
      onLine: (line) => { for (const event of stream.line(line)) note(event); },
      idleTimeoutMs: request.limits.idleTimeoutMs, maxRunMs: request.limits.maxRunMs, maxLineBytes: 16 * 1024 * 1024, signal,
    });
    void proc.done.then((end) => {
      clearTimeout(grace);
      if (!outcome) {
        const fromStderr = classifyClaudeFailure({ stderr: end.stderrTail });
        const code: FailureCode | 'cancelled' =
          end.reason === 'aborted' ? 'cancelled'
            : end.reason === 'idle' || end.reason === 'max-time' ? 'timeout'
              : end.reason === 'line-too-long' ? 'protocol'
                : end.reason === 'spawn-error' ? (end.spawnErrorCode === 'ENOENT' ? 'not_installed' : 'crashed')
                  : fromStderr !== 'harness_error' ? fromStderr : 'crashed';
        outcome = code === 'cancelled' ? { type: 'finished', reason: 'cancelled' } : { type: 'failed', code, message: messages[code] };
      }
      events.push(outcome);
      events.close();
    });
    return events;
  },
};
