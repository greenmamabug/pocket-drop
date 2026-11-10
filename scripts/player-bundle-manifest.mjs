// SPDX-License-Identifier: GPL-3.0-only
// Run after signing native libraries/frameworks, before sealing the outer app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPlayerBundleManifest } from '../app/player-bundle.mjs';
const folder = path.resolve(process.argv[2]);
await fs.writeFile(
  path.join(folder, 'manifest.json'),
  JSON.stringify(await createPlayerBundleManifest(folder, process.argv[3]), null, 2) + '\n',
);
