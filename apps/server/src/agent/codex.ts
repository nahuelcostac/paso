import { idSchema } from '@paso/shared';
import { describeTarget } from './where.js';
import { connectCodexBoard, codexBoardTools, codexReadOnlyTools } from './codex-board.js';
import { classifyCodexFailure, codexDefaultEffort, codexFailureMessage, codexVersion, prepareCodex } from './codex-policy.js';
import { forgetCodex } from './forget.js';
import { startProcess, type ManagedProcess } from './process.js';
import type { AgentEvent, FailureCode, HarnessAdapter, ToolTarget } from './types.js';

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const allowedItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction', 'dynamicToolCall']);
function targetOf(input: Record<string, unknown>) {
  const target: ToolTarget = {};
  for (const key of ['projectId', 'sceneId', 'stepId'] as const) {
    const value = idSchema.safeParse(input[key]);
    if (value.success) target[key] = value.data;
  }
  return Object.keys(target).length ? target : undefined;
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  forget: (token, workDir) => forgetCodex(token, workDir),
  async *run(request, signal) {
    let board: Awaited<ReturnType<typeof connectCodexBoard>> | undefined;
    let proc: ManagedProcess | undefined;
    let terminal: AgentEvent | undefined;
    const events: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const push = (event: AgentEvent) => { events.push(event); wake?.(); };
    const fail = (code: FailureCode) => {
      if (terminal) return;
      terminal = { type: 'failed', code, message: codexFailureMessage(code) };
      void proc?.stop();
    };
    const pendingCalls = new Set<Promise<void>>();
    let threadId: string | undefined;
    let turnStarted = false;
    const seenTools = new Set<string>();
    try {
      const policy = await prepareCodex(request);
      if (signal.aborted) { yield { type: 'finished', reason: 'cancelled' }; return; }
      board = await connectCodexBoard(request, signal);
      const rpc = (id: number, method: string, params: unknown) => proc?.write(JSON.stringify({ id, method, params }));
      const where = describeTarget(request.context);
      const onLine = (line: string) => {
        if (terminal || signal.aborted) return;
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { fail('protocol'); return; }
        if (!record(msg)) { fail('protocol'); return; }
        if (record(msg.error)) { fail(classifyCodexFailure(JSON.stringify(msg.error))); return; }
        if (msg.id === 1 && record(msg.result)) {
          if (typeof msg.result.userAgent !== 'string' || !msg.result.userAgent.includes(`/${codexVersion} `)) { fail('unsupported_version'); return; }
          proc?.write(JSON.stringify({ method: 'initialized' }));
          rpc(2, request.resumeToken ? 'thread/resume' : 'thread/start', {
            ...(request.resumeToken ? { threadId: request.resumeToken } : { environments: [], dynamicTools: board!.tools }),
            cwd: policy.cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
            model: policy.model, config: policy.config,
            baseInstructions: 'Eres el asistente de Paso. Solo usas herramientas del tablero y respondes en español.',
            developerInstructions: `Trabajas en el ${where} (IDs de servicio). Lee el paso antes de editarlo. No tienes terminal, archivos ni web.`,
            runtimeWorkspaceRoots: [],
          });
          return;
        }
        if (msg.id === 2 && record(msg.result)) {
          const r = msg.result;
          if (r.cwd !== policy.cwd || (r.activePermissionProfile !== undefined && r.activePermissionProfile !== null)
            || !Array.isArray(r.runtimeWorkspaceRoots) || r.runtimeWorkspaceRoots.length
            || !record(r.sandbox) || r.sandbox.type !== 'readOnly' || r.sandbox.networkAccess !== false
            || r.approvalPolicy !== 'never' || r.approvalsReviewer !== 'user'
            || !record(r.thread) || !Array.isArray(r.thread.environments)
            || (r.thread.environments.length !== 0 && !(request.resumeToken && r.thread.environments.length === 1
              && record(r.thread.environments[0]) && r.thread.environments[0].environmentId === 'local'
              && r.thread.environments[0].cwd === policy.cwd
              && Array.isArray(r.thread.environments[0].runtimeWorkspaceRoots) && r.thread.environments[0].runtimeWorkspaceRoots.length === 0))
            || !Array.isArray(r.instructionSources) || r.instructionSources.length) { fail('unsafe_configuration'); return; }
          if (typeof r.thread.id !== 'string' || (request.resumeToken && r.thread.id !== request.resumeToken) || r.model !== policy.model) { fail('protocol'); return; }
          threadId = r.thread.id;
          push({ type: 'session', resumeToken: threadId, model: policy.model });
          // 0.166.0 restores the local environment on resume. Every turn explicitly clears it
          // before inference. No turn is submitted with the restored environment.
          rpc(3, 'turn/start', { threadId, environments: [], approvalPolicy: 'never',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
            // Codex keeps a turn's effort for the turns after it, so every turn states its own: the chosen level, or
            // the catalog's default, which is what "automatic" means for Codex in Paso.
            effort: request.effort ?? codexDefaultEffort,
            input: [{ type: 'text', text: request.text }] });
          turnStarted = true;
          return;
        }
        const p = record(msg.params) ? msg.params : {};
        if (msg.id !== undefined && typeof msg.method === 'string') {
          // Every server request is denied except the board bridge. No approvals or user prompts.
          if (msg.method !== 'item/tool/call' || !turnStarted || p.threadId !== threadId
            || (p.namespace !== undefined && p.namespace !== null) || typeof p.tool !== 'string'
            || !(codexBoardTools as readonly string[]).includes(p.tool) || !record(p.arguments)
            || typeof p.callId !== 'string' || seenTools.has(p.callId)) { fail('unsafe_configuration'); return; }
          seenTools.add(p.callId);
          const tool = p.tool, id = p.callId, args = p.arguments;
          const target = targetOf(args);
          push({ type: 'tool_use', tool, id, readOnly: codexReadOnlyTools.has(tool), ...(target ? { target } : {}) });
          const call = (async () => {
            try {
              const result = await board!.call(tool, args);
              if (terminal || signal.aborted) return;
              const content = Array.isArray(result.content) ? result.content : [];
              const contentItems = content.flatMap<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>((c) => {
                if (!record(c)) return [];
                if (c.type === 'text' && typeof c.text === 'string') return [{ type: 'inputText', text: c.text }];
                if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') return [{ type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` }];
                return [];
              });
              const ok = result.isError !== true;
              push({ type: 'tool_result', id, ok });
              proc?.write(JSON.stringify({ id: msg.id, result: { contentItems, success: ok } }));
            } catch { if (!signal.aborted) fail('board_unavailable'); }
          })();
          pendingCalls.add(call); void call.finally(() => pendingCalls.delete(call));
          return;
        }
        if (msg.method === 'item/started' || msg.method === 'item/completed') {
          if (!record(p.item) || typeof p.item.type !== 'string') { fail('protocol'); return; }
          if (!allowedItems.has(p.item.type)) { fail('unsafe_configuration'); return; }
          if (p.item.type === 'dynamicToolCall' && ((p.item.namespace !== undefined && p.item.namespace !== null) || typeof p.item.tool !== 'string' || !(codexBoardTools as readonly string[]).includes(p.item.tool))) { fail('unsafe_configuration'); return; }
          if (msg.method === 'item/completed' && p.item.type === 'agentMessage' && typeof p.item.text === 'string' && p.item.text) push({ type: 'text', text: p.item.text });
        } else if (msg.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
          push({ type: 'text_delta', text: p.delta });
        } else if (msg.method === 'mcpServer/startupStatus/updated') {
          fail('unsafe_configuration'); // Codex itself must have no MCP servers at all.
        } else if (msg.method === 'error' && p.willRetry !== true) {
          fail(classifyCodexFailure(JSON.stringify(p.error)));
        } else if (msg.method === 'turn/completed') {
          if (!turnStarted || !record(p.turn)) { fail('protocol'); return; }
          if (p.turn.status === 'completed') terminal = { type: 'finished', reason: 'completed' };
          else if (p.turn.status === 'interrupted') terminal = { type: 'finished', reason: 'cancelled' };
          else { fail(classifyCodexFailure(JSON.stringify(p.turn.error))); return; }
          void proc?.stop();
        }
      };
      proc = startProcess({ file: request.executable, args: policy.args, env: policy.env, cwd: policy.cwd,
        input: JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'paso', version: '1.0.0' }, capabilities: { experimentalApi: true } } }),
        keepStdinOpen: true,
      }, { ...request.limits, maxLineBytes: 16 * 1024 * 1024, signal, onLine });
      void proc.done.then((end) => {
        if (signal.aborted) terminal = { type: 'finished', reason: 'cancelled' };
        if (!terminal) {
          const mapped = classifyCodexFailure(end.stderrTail);
          const code = end.reason === 'spawn-error' ? (end.spawnErrorCode === 'ENOENT' ? 'not_installed' : 'crashed')
            : end.reason === 'idle' || end.reason === 'max-time' ? 'timeout'
              : end.reason === 'line-too-long' ? 'protocol' : mapped === 'harness_error' ? 'crashed' : mapped;
          terminal = { type: 'failed', code, message: codexFailureMessage(code) };
        }
        ended = true; wake?.();
      });
      for (;;) {
        if (events.length) { yield events.shift()!; continue; }
        if (ended) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } catch (error) {
      if (signal.aborted) terminal = { type: 'finished', reason: 'cancelled' };
      else {
        const code = error instanceof Error && error.message === 'unsafe_configuration' ? 'unsafe_configuration' : 'board_unavailable';
        terminal = { type: 'failed', code, message: codexFailureMessage(code) };
      }
    } finally {
      await proc?.stop();
      await board?.close().catch(() => {});
      await Promise.allSettled(pendingCalls);
    }
    yield terminal ?? { type: 'failed', code: 'protocol', message: codexFailureMessage('protocol') };
  },
};
