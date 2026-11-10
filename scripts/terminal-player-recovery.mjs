// SPDX-License-Identifier: GPL-3.0-only
// Uses the installed app's existing recovery engine. No new backup or image is created.
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);

export async function recoverFromTerminal(
  updater,
  { ask, print, assertExclusive = async () => {} },
) {
  if (!updater.journal?.pendingWrite || updater.journal.completed)
    throw new Error(
      'No interrupted update was found. This tool only recovers an existing prepared update.',
    );
  print('Checking the USB connection first. This step only reads; it cannot repair the player.');
  const connection = await updater.connectionTest();
  if (connection?.passed !== true)
    throw new Error('The connection test did not pass. No recovery write was started.');
  print('Read test passed. This does not guarantee that writing will succeed.');
  await updater.review();
  print('Saved update verified for player …' + updater.state.summary.unitId.slice(-8));
  for (const item of updater.state.summary.checklist ?? []) print('  ' + item);
  print(
    'This will retry the saved system image and verify the entire result. Keep the cable connected.',
  );
  const answer = await ask('Type WRITE to retry the prepared update, or press Return to stop: ');
  if (answer !== 'WRITE') {
    print('Stopped. No recovery write was started; the earlier update remains incomplete.');
    return { verified: false, aborted: true };
  }
  await assertExclusive();
  print(
    'A new USB session is starting. Press the reset pinhole again WHEN the tool says it is waiting.',
  );
  await updater.write('WRITE', updater.state.token);
  if (updater.state.phase !== 'complete' || updater.state.pendingWrite)
    throw new Error('The write was not fully verified. Keep the backup and prepared image.');
  print('SUCCESS: the complete player image was read back and verified.');
  return { verified: true };
}

function ask(prompt) {
  return new Promise((resolve) => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.on('SIGINT', () => input.close());
    input.on('close', () => resolve(''));
    input.question(prompt, (answer) => {
      resolve(answer);
      input.close();
    });
  });
}

async function matchingPids(name) {
  try {
    const { stdout } = await exec('/usr/bin/pgrep', ['-x', name]);
    return stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => pid && pid !== process.pid);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

async function main(argv) {
  const checkOnly = argv.includes('--check');
  const mainIndex = argv.indexOf('--app-main');
  const appMain =
    mainIndex === -1
      ? '/Applications/Pocket Drop.app/Contents/Resources/app.asar/app/main.mjs'
      : argv[mainIndex + 1];
  if (process.platform !== 'darwin' || process.arch !== 'x64')
    throw new Error('Use this recovery tool on the Intel Mac with Pocket Drop 4.7.4 installed.');
  if (!appMain || !path.isAbsolute(appMain)) throw new Error('The installed app path is invalid.');
  const base = path.dirname(appMain);
  const pkg = JSON.parse(await fs.readFile(path.join(base, '..', 'package.json'), 'utf8'));
  if (pkg.name !== 'pocket-drop' || pkg.version !== '4.7.4')
    throw new Error('This tool requires Pocket Drop 4.7.4 in Applications.');
  const load = (name) => import(pathToFileURL(path.join(base, name)).href);
  const [{ PlayerUpdater }, { Device }, { locatePlayerBundle }] = await Promise.all([
    load('player-updater.mjs'),
    load('device.mjs'),
    load('player-bundle.mjs'),
  ]);
  if (!(await locatePlayerBundle('x64')))
    throw new Error('The installed app does not contain the expected verified updater runtime.');
  if (checkOnly) {
    console.log(
      'PASS: installed app, Terminal imports and bundled runtime verified. No USB device opened.',
    );
    return;
  }
  if (!process.stdin.isTTY)
    throw new Error('Run this tool in Terminal so it can ask for confirmation.');
  const assertExclusive = async () => {
    if ((await matchingPids('Pocket Drop')).length || (await matchingPids('mtk')).length)
      throw new Error(
        'Quit Pocket Drop and other player-updater tools before running this command.',
      );
  };
  await assertExclusive();
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const candidates = [];
  for (const name of ['pocket-drop', 'Pocket Drop']) {
    const folder = path.join(support, name);
    const stat = await fs.lstat(path.join(folder, 'player-update.json')).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) candidates.push(folder);
  }
  if (candidates.length !== 1)
    throw new Error(
      'Could not identify one saved Pocket Drop update. Keep your backup; do not make a new one.',
    );
  const folder = candidates[0];
  const settings = JSON.parse(
    await fs.readFile(path.join(folder, 'settings.json'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    }),
  );
  const logFile = path.join(folder, 'terminal-recovery-' + Date.now() + '.log');
  await fs.writeFile(logFile, '', { flag: 'wx', mode: 0o600 });
  const print = (message) => {
    const text = String(message);
    appendFileSync(logFile, new Date().toISOString() + ' ' + text + '\n');
    console.log(text);
  };
  print('Pocket Drop Terminal recovery — existing prepared image only.');
  print('Log saved privately on this Mac: ' + logFile);
  print('Keep this Terminal window open and leave other updater apps closed.');
  let updater, lastLine;
  const library = {
    device: new Device(undefined, undefined, { volumeUUID: settings.volumeUUID }),
    busy: false,
    stopScan: async () => {},
    log: async (message) => print(message),
    publish() {
      const state = this.playerUpdate;
      const line = state?.running ? state.details?.at(-1) : null;
      if (line && line !== lastLine) {
        lastLine = line;
        print(line);
      }
    },
  };
  updater = await new PlayerUpdater({
    library,
    folder,
    record: (event, error) => {
      if (event !== 'player-tool') print(event + ': ' + (error?.message ?? error));
    },
  }).load();
  const sleep = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {
    stdio: 'ignore',
  });
  sleep.on('error', (error) => print('Keep the Mac awake: ' + error.message));
  const interrupt = () => {
    if (updater.state.running && updater.state.action === 'write') {
      print('Writing or verifying: keep the cable connected and wait for the final result.');
      return;
    }
    updater.cancel();
  };
  process.on('SIGINT', interrupt);
  try {
    await recoverFromTerminal(updater, { ask, print, assertExclusive });
  } catch (error) {
    const root = updater.state.details?.findLast((line) =>
      /termios\.error:|SerialException:|SerialException\(/.test(line),
    );
    if (root) print('USB connection error: ' + root);
    print('STOPPED: ' + error.message);
    print('The earlier update remains incomplete. Keep the original backup and prepared image.');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    sleep.kill();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
