import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
for (const folder of ['app', 'ui', 'scripts']) {
  for (const file of await fs.readdir(folder)) {
    if (/\.(?:mjs|cjs|js)$/.test(file) && !file.startsWith('.'))
      execFileSync(process.execPath, ['--check', path.join(folder, file)], { stdio: 'inherit' });
  }
}
console.log('First-party JavaScript syntax checks passed.');
