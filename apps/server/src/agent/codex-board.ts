import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { harnessEnvironment, startProcess, type ManagedProcess } from './process.js';
import type { AgentRunRequest } from './types.js';

export const codexBoardTools = [
  'list_projects', 'read_project', 'read_scene', 'read_step', 'get_step_image',
  'create_scene', 'create_step', 'duplicate_step', 'update_step', 'delete_step', 'add_elements', 'update_elements', 'delete_elements',
] as const;
export const codexReadOnlyTools = new Set<string>(codexBoardTools.slice(0, 5));

/** MCP uses its own managed process group. The Codex process never receives the service token. */
class BoardTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private proc?: ManagedProcess;
  constructor(private request: AgentRunRequest, private signal: AbortSignal) {}
  async start() {
    const { request } = this;
    this.proc = startProcess({
      file: request.board.mcp.command, args: request.board.mcp.args, cwd: request.workDir,
      input: '', keepStdinOpen: true,
      env: harnessEnvironment({
        PASO_SERVICE_URL: request.board.serviceUrl, PASO_SESSION_TOKEN: request.board.sessionToken,
        ...(request.board.mcp.browserExecutable ? { PASO_MCP_BROWSER_EXECUTABLE: request.board.mcp.browserExecutable } : {}),
      }),
    }, {
      signal: this.signal, ...request.limits, idleTimeoutMs: request.limits.maxRunMs, maxLineBytes: 16 * 1024 * 1024,
      onLine: (line) => {
        try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line))); }
        catch { this.onerror?.(new Error('Invalid board MCP response')); }
      },
    });
    void this.proc.done.then(() => this.onclose?.());
  }
  async send(message: JSONRPCMessage) { this.proc?.write(JSON.stringify(message)); }
  async close() { await this.proc?.stop(); }
}

export async function connectCodexBoard(request: AgentRunRequest, signal: AbortSignal) {
  const transport = new BoardTransport(request, signal);
  const client = new Client({ name: 'paso-codex', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: Math.min(request.limits.idleTimeoutMs, 15_000) });
    const { tools, nextCursor } = await client.listTools({}, { timeout: 15_000 });
    if (nextCursor || tools.length !== codexBoardTools.length || new Set(tools.map((t) => t.name)).size !== tools.length
      || !tools.every((t) => (codexBoardTools as readonly string[]).includes(t.name))) {
      throw new Error('unsafe_configuration');
    }
    return {
      tools: tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema, deferLoading: false })),
      call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 }),
      async close() { try { await client.close(); } finally { await transport.close(); } },
    };
  } catch (error) {
    await client.close().catch(() => {}); await transport.close();
    throw error;
  }
}
