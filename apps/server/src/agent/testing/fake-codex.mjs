// App-server simulator. Requests and env go only to the test's private temp folder.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => out({ id, result });
const notice = (method, params) => out({ method, params });
let threadId = 'fake-codex-thread';
let scenario = '';
let toolRpc;
const end = () => notice('turn/completed', { threadId, turn: { id: 'turn', status: 'completed' } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const q = JSON.parse(line);
  if (q.method === 'initialize') {
    appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\n');
    reply(q.id, { userAgent: `paso/${process.env.FAKE_CODEX_VERSION ?? '0.166.0'} (test)` });
  } else if (q.method === 'thread/start' || q.method === 'thread/resume') {
    if (q.params.threadId) threadId = q.params.threadId;
    appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ method: q.method, params: q.params }) + '\n');
    reply(q.id, { thread: { id: threadId, environments: q.method === 'thread/resume' ? [{ environmentId: 'local', cwd: q.params.cwd, runtimeWorkspaceRoots: [] }] : [] }, cwd: q.params.cwd, runtimeWorkspaceRoots: [], model: q.params.model,
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: [] });
  } else if (q.method === 'turn/start') {
    scenario = q.params.input[0].text;
    appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ method: q.method, params: q.params }) + '\n');
    reply(q.id, { turn: { id: 'turn' } });
    const errors = { 'signed-out': '401 authentication required', quota: 'usageLimitExceeded', model: 'modelNotFound', unsupported: 'unknown argument' };
    if (errors[scenario]) { notice('error', { willRetry: false, error: { message: errors[scenario] } }); continue; }
    if (scenario === 'crash') process.exit(3);
    if (scenario === 'protocol') { console.log('not json'); continue; }
    if (scenario === 'unsafe-mode') { reply(2, { thread: { id: threadId, environments: [] }, model: 'x', approvalPolicy: 'on-request', sandbox: { type: 'dangerFullAccess' } }); continue; }
    if (scenario === 'unsafe-server') { notice('mcpServer/startupStatus/updated', { name: 'evil' }); continue; }
    if (scenario === 'unsafe-use') { notice('item/started', { item: { type: 'commandExecution' } }); continue; }
    if (scenario === 'unsafe-call') { out({ id: 100, method: 'item/tool/call', params: { threadId, callId: 'bad', tool: 'exec_command', arguments: {} } }); continue; }
    if (scenario === 'approval') { out({ id: 100, method: 'item/commandExecution/requestApproval', params: {} }); continue; }
    if (scenario === 'tree') { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ child: child.pid }) + '\n'); }
    if (scenario === 'tree' || scenario === 'hang') continue;
    notice('item/agentMessage/delta', { delta: 'Ho' }); notice('item/agentMessage/delta', { delta: 'la' });
    notice('item/completed', { item: { type: 'agentMessage', text: 'Hola' } });
    toolRpc = 100;
    out({ id: toolRpc, method: 'item/tool/call', params: { threadId, turnId: 'turn', callId: 'read', tool: 'read_step', arguments: { projectId: 'p', sceneId: 's', stepId: 'st' } } });
  } else if (q.id === 100 && q.result) {
    toolRpc = 101;
    out({ id: toolRpc, method: 'item/tool/call', params: { threadId, turnId: 'turn', callId: 'write', tool: 'add_elements', arguments: { projectId: 'p', sceneId: 's', stepId: 'st', revision: 'invalid', elements: [] } } });
  } else if (q.id === 101 && q.result) {
    notice('item/completed', { item: { type: 'agentMessage', text: 'Listo' } }); end();
  }
}
