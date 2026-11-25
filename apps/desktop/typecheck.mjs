import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

for (const directory of ['.', 'lib', 'icon']) {
  for (const file of readdirSync(directory)) {
    if (['.mjs', '.cjs'].includes(extname(file))) {
      execFileSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    }
  }
}
