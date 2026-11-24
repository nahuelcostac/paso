// agy print-mode simulator. Records go only to the test's private temp folder.
// It loads the Paso agent from its working directory, as agy does, and starts the board MCP server it names.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const record = (value) => appendFileSync(process.env.FAKE_RECORD, JSON.stringify(value) + '\n');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (args[0] === '--version') { console.log(process.env.FAKE_AGY_VERSION ?? '1.5.16'); process.exit(0); }
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
record({ args, env: process.env, cwd: process.cwd() });

const agentName = flag('--agent');
let agent = '';
try { agent = readFileSync(join(process.cwd(), '.agents', 'agents', `${agentName}.md`), 'utf8'); } catch { /* Missing below. */ }
if (!agent) {
  process.stderr.write(`error: unknown agent "${agentName}" (no custom agents are available)\n`);
  out({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: `unknown agent "${agentName}"`, finished_reason: 'error' } });
  process.exit(1);
}
const conversation = process.env.FAKE_AGY_CONVERSATION ?? flag('--conversation') ?? 'fake-agy-conversation';
const step = (step_index, fields) => out({ event: 'step_update', step_update: { conversation_id: conversation, step_index, ...fields } });
const result = (status, extra = {}) => out({ event: 'result', result: { conversation_id: conversation, status, response: '', ...extra } });

// Whatever arrives on stdin before init would be a message sent before Paso checked the agent.
let input = '';
let early = false;
process.stdin.on('data', (chunk) => { input += chunk; });
await new Promise((resolve) => setTimeout(resolve, 150));
if (input) early = true;
out({ event: 'init', conversation_id: conversation, init: {
  cwd: process.cwd(), agent: process.env.FAKE_AGY_AGENT ?? agentName, ...(flag('--model') ? { model: flag('--model') } : {}),
  // Like the real CLI, init lists the default tool set whatever the agent allows.
  tools: ['run_command', 'view_file', 'write_to_file', 'call_mcp_tool', 'search_web'], permission_mode: 'request-review',
} });
await new Promise((resolve) => process.stdin.on('end', resolve));
const line = input.trim();
record({ early, stdin: line });
const message = JSON.parse(line);
const text = message.message.content[0].text;
const scenario = text.split('\n').at(-1);
// Stays alive until Paso stops it, as a stuck CLI would.
const hang = () => new Promise(() => setInterval(() => {}, 1000));

/** A minimal MCP client over stdio for the server named in the agent file. */
async function board(calls) {
  const command = JSON.parse(agent.match(/^ {4}command: (.+)$/m)[1]);
  const serverArgs = JSON.parse(agent.match(/^ {4}args: (.+)$/m)[1]);
  const child = spawn(command, serverArgs, { stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      waiting.get(reply.id)?.(reply); waiting.delete(reply.id);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agy', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const results = [];
  for (const [name, input] of calls) results.push((await rpc('tools/call', { name, arguments: input })).result);
  child.kill();
  return results;
}

step(0, { state: 'DONE', step_type: 'user_input' });
if (scenario === 'quota') { result('ERROR', { error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Your quota will reset in 3h.', finished_reason: 'error' }); process.exit(1); }
if (scenario === 'signed-out') {
  process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
  result('ERROR', { error: 'authentication failed or timed out', finished_reason: 'error' }); process.exit(1);
}
if (scenario === 'model') { result('ERROR', { error: 'invalid model selection (--model "x" --effort ""): model x is not recognized as a known model', finished_reason: 'error' }); process.exit(1); }
if (scenario === 'crash') process.exit(3);
if (scenario === 'protocol') { for (let i = 0; i < 30; i++) console.log('not json'); await hang(); }
const read0 = () => ({ projectId: 'p', sceneId: 's', stepId: 'st' });
const tool = (index, name, parameters) => step(index, { state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters } });
if (scenario === 'unsafe-tool') { tool(1, 'run_command', { CommandLine: 'touch /tmp/unsafe' }); await hang(); }
if (scenario === 'other-server') { tool(1, 'call_mcp_tool', { ServerName: 'evil', ToolName: 'read_step', Arguments: {} }); await hang(); }
if (scenario === 'manage-task') { tool(1, 'manage_task', { Action: 'list' }); await hang(); }
if (scenario === 'other-prefix') { tool(1, 'mcp_evil_read_step', read0()); await hang(); }
if (scenario === 'unknown-board-tool') { tool(1, 'call_mcp_tool', { ServerName: 'paso', ToolName: 'run_shell', Arguments: {} }); await hang(); }
if (scenario === 'tree') { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); record({ child: child.pid }); }
if (scenario === 'tree' || scenario === 'hang') await hang();

step(1, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Ho' });
step(1, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'la' });
step(1, { state: 'DONE', step_type: 'agent_response', text_delta: '\n' });
const read = { projectId: 'p', sceneId: 's', stepId: 'st' };
const bad = { projectId: 'p', sceneId: 's', stepId: 'st', revision: 'invalid', elements: [{ id: 'x', type: 'rectangle', x: 0, y: 0 }] };
// An always-loaded board tool, as agy names it, and one reached through call_mcp_tool.
tool(2, 'mcp_paso_read_step', read);
tool(3, 'call_mcp_tool', { ServerName: 'paso', ToolName: 'add_elements', Arguments: bad });
const [readResult, badResult] = await board([['read_step', read], ['add_elements', bad]]);
record({ readResult, badResult });
step(2, { state: readResult.isError ? 'ERROR' : 'DONE', step_type: 'tool', tool_name: 'mcp_paso_read_step', tool_info: { name: 'mcp_paso_read_step', parameters: read } });
step(3, { state: badResult.isError ? 'ERROR' : 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'paso', ToolName: 'add_elements', Arguments: bad }, ...(badResult.isError ? { error: { type: 'TOOL_ERROR', message: 'x' } } : {}) } });
step(4, { state: 'DONE', step_type: 'agent_response', text_delta: 'Listo.' });
result('SUCCESS', { response: 'Hola\nListo.' });
