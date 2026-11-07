import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuration } from './api.js';
import { createBoardMcp } from './server.js';

try {
  const server = createBoardMcp(configuration(process.env));
  const transport = new StdioServerTransport();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close(); });
  await server.connect(transport);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Paso MCP could not start. Check its environment.');
  process.exitCode = 1;
}
