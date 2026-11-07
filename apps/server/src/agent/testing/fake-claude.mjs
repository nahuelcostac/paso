// A stand-in for the `claude` executable, used by tests so they pass on machines without Claude Code.
// The scenario comes from the user's message: "SCENARIO:<name>[:argument] ..." (message content is
// the only channel a real caller controls). Every run is recorded to $FAKE_DIR/runs.jsonl.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (args[0] === '--version') { console.log('2.1.319 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  const state = existsSync(`${dir}/auth.json`) ? readFileSync(`${dir}/auth.json`, 'utf8') : '{"loggedIn":true}';
  console.log(state); process.exit(JSON.parse(state).loggedIn ? 0 : 1);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
let text = '';
try { text = JSON.parse(input.split('\n')[0]).message.content; } catch { /* leave empty */ }
appendFileSync(`${dir}/runs.jsonl`, JSON.stringify({ argv: args, env: process.env, cwd: process.cwd(), stdin: input, pid: process.pid }) + '\n');

const scenario = /SCENARIO:([a-z-]+)(?::(\S+))?/.exec(text);
const name = scenario?.[1] ?? 'ok';
const argument = scenario?.[2];
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined;
const sessionId = resumed ?? `fake-session-${process.pid}`;

const init = (overrides = {}) => out({
  type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'fake-model',
  permissionMode: 'dontAsk', mcp_servers: [{ name: 'paso', status: 'connected' }],
  tools: ['mcp__paso__read_step', 'mcp__paso__add_elements'], ...overrides,
});
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, ...extra });
const delta = (value) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } } });
const assistant = (content, extra = {}) => out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { role: 'assistant', content }, ...extra });

switch (name) {
  case 'ok':
    init(); out({ type: 'system', subtype: 'status', status: 'requesting' });
    delta('Ho'); delta('la'); assistant([{ type: 'text', text: 'Hola' }]);
    assistant([{ type: 'tool_use', id: 't1', name: 'mcp__paso__read_step', input: { projectId: 'p1', sceneId: 's1', stepId: 'st1', secretArgument: 'ARGUMENT-SECRET' } }]);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'RESULT-SECRET' }] }] } });
    assistant([{ type: 'tool_use', id: 't2', name: 'mcp__paso__add_elements', input: { projectId: 'p1', sceneId: 's1', stepId: 'st1', revision: 'r', elements: [] } }]);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'conflict' }] } });
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    assistant([{ type: 'text', text: 'Listo' }]); result();
    break;
  case 'partial': {
    // Split JSON lines across writes, add noise, and omit the final newline.
    const lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, permissionMode: 'dontAsk', mcp_servers: [{ name: 'paso', status: 'connected' }], tools: ['mcp__paso__read_step'] }),
      'not json at all', '', JSON.stringify({ type: 'unknown_future_type', x: 1 }), '{"type":"assistant","message":{"content":[{"type":"text","text":"Partido ✓"}]}}'];
    for (const line of lines) { const middle = Math.floor(line.length / 2); process.stdout.write(line.slice(0, middle)); await sleep(30); process.stdout.write(line.slice(middle) + '\n'); }
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    break;
  }
  case 'malformed': for (let i = 0; i < 40; i++) console.log('garbage line ' + i); await sleep(5000); break;
  case 'crash': init(); process.stderr.write('internal failure with details\n'); process.exit(3); break;
  case 'silent-exit': break;
  case 'hang': init(); await sleep(60_000); break;
  case 'tree': {
    init();
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(argument, String(grandchild.pid));
    delta('trabajando'); await sleep(60_000); break;
  }
  case 'slow': init(); for (let i = 0; i < 40; i++) { delta('.'); await sleep(50); } assistant([{ type: 'text', text: 'fin' }]); result(); break;
  case 'signed-out':
    init(); assistant([{ type: 'text', text: 'Not logged in · Please run /login' }], { error: 'authentication_failed', is_api_error_message: true });
    result({ is_error: true, result: 'Not logged in · Please run /login' }); break;
  case 'quota':
    init(); out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    assistant([{ type: 'text', text: "You've hit your limit · resets 5pm" }], { error: 'rate_limit' });
    result({ is_error: true, result: "You've hit your limit · resets 5pm" }); break;
  case 'model':
    init(); assistant([{ type: 'text', text: 'There\'s an issue with the selected model (nope). It may not exist or you may not have access to it.' }], { error: 'invalid_request' });
    result({ is_error: true, result: 'There\'s an issue with the selected model (nope). It may not exist or you may not have access to it.' }); break;
  case 'unsafe-tools': init({ tools: ['mcp__paso__read_step', 'Bash'] }); await sleep(60_000); break;
  case 'unsafe-mode': init({ permissionMode: 'bypassPermissions' }); await sleep(60_000); break;
  case 'unsafe-server': init({ mcp_servers: [{ name: 'paso', status: 'connected' }, { name: 'other', status: 'connected' }] }); await sleep(60_000); break;
  case 'unsafe-use': init(); assistant([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'echo PWNED' } }]); await sleep(60_000); break;
  case 'no-board': init({ mcp_servers: [{ name: 'paso', status: 'failed' }], tools: [] }); await sleep(60_000); break;
  case 'unknown-flag': process.stderr.write("error: unknown option '--setting-sources'\n"); process.exit(1); break;
  default: init(); result();
}
