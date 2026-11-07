import { startServer } from './server.js';

const port = 3001;
startServer({ port });
console.log(`Server listening on http://127.0.0.1:${port}`);
