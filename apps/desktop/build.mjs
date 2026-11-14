import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
await Promise.all(['main.mjs', 'preload.cjs'].map((file) => cp(join(root, file), join(root, 'dist', file))));
