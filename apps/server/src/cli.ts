import { dataDirectory, startServer } from './server.js';

const port = Number(process.env.PASO_PORT ?? 3001);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PASO_PORT.');
const service = await startServer({
  dataDir: dataDirectory(),
  harnessRegistryPath: process.env.PASO_HARNESS_REGISTRY_PATH,
  runsDir: process.env.PASO_RUNS_DIR,
  workspacesPath: process.env.PASO_WORKSPACES_PATH,
  port, sessionToken: process.env.PASO_SESSION_TOKEN,
  allowedOrigins: process.env.PASO_ALLOWED_ORIGINS?.split(',').filter(Boolean),
  agent: {
    workDir: process.env.PASO_AGENT_WORKDIR, sessionsPath: process.env.PASO_AGENT_SESSIONS_PATH,
    mcp: { entry: process.env.PASO_MCP_ENTRY, browserExecutable: process.env.PASO_MCP_BROWSER_EXECUTABLE },
  },
});
console.log(`Paso listening on ${service.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close(); });
