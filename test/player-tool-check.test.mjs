// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPlayerTool, playerPlatform } from '../app/player-tool-check.mjs';
import { savedPlayerBackup } from '../app/player-backups.mjs';
import { probeToolReport } from '../vendor/firmware-tools/dist/node.js';
import { PROBE_TIMEOUT_MS } from '../vendor/firmware-tools/dist/mtk.js';
const temporary = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket tool spaces '));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};
const script = async (root, text) => {
  const file = path.join(root, 'fake tool.sh');
  await fs.writeFile(file, '#!/bin/sh\n' + text, { mode: 0o755 });
  return file;
};

test('capability preflight uses no plan arguments and the expected-CID environment, in a path with spaces', () =>
  temporary(async (root) => {
    const tool = await script(
      root,
      'test "$#" = 0 || exit 8\ntest "$STUDIO_POCKET_PROBE" = 1 || exit 9\ntest "$STUDIO_POCKET_EXPECT_CID" = 00000000000000000000000000000000 || exit 10\necho "Studio Pocket - identity gate 1"\n',
    );
    const result = await checkPlayerTool(tool, root);
    assert.equal(result.passed, true);
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(PROBE_TIMEOUT_MS, 90000);
  }));

test('a crashed startup retains the real cause rather than reporting a missing identity implementation', () =>
  temporary(async (root) => {
    const tool = await script(
      root,
      'echo "Traceback (most recent call last):" >&2\necho "ImportError: native library could not load" >&2\nexit 1\n',
    );
    await assert.rejects(checkPlayerTool(tool, root), (error) => {
      assert.match(error.message, /startup check \(exit 1\)/);
      assert.match(error.message, /ImportError: native library could not load/);
      assert.match(error.message, /Nothing was written/);
      assert.doesNotMatch(error.message, /Rebuild|scripts\//);
      return true;
    });
  }));

test('timeout, missing reply and fake successful output with a failing exit all fail closed', () =>
  temporary(async (root) => {
    let tool = await script(root, 'exec sleep 5\n');
    const report = await probeToolReport(tool, root, process.env, () => {}, 50);
    assert.equal(report.timedOut, true);
    await assert.rejects(
      checkPlayerTool(tool, root, { inspect: async () => report }),
      /took too long/,
    );
    tool = await script(root, 'echo "usage: mtk"\nexit 2\n');
    await assert.rejects(checkPlayerTool(tool, root), /exit 2/);
    tool = await script(root, 'echo "Studio Pocket - identity gate 1"\nexit 1\n');
    await assert.rejects(checkPlayerTool(tool, root), /exit 1/);
    tool = await script(root, 'echo "Studio Pocket - identity gate 99"\nexit 0\n');
    await assert.rejects(checkPlayerTool(tool, root), /did not confirm/);
  }));

test('the actual pre-write probe cannot be bypassed and its stderr reaches the app', async () => {
  const p = playerPlatform(
    {
      runMtk: async (_plan, _log, options) => {
        assert.equal(options.expectCid, 'a'.repeat(32));
        return {
          code: -4,
          probeRefused: true,
          stdout: '',
          stderr: 'OSError: fixture startup failure',
        };
      },
    },
    () => {},
  );
  await assert.rejects(
    p.runMtk({}, () => {}, { expectCid: 'a'.repeat(32) }),
    (error) => {
      assert.match(error.message, /OSError: fixture startup failure/);
      assert.match(error.message, /Nothing was written/);
      assert.match(error.message, /prepared update is saved/);
      return true;
    },
  );
});

test('saved backup discovery rejects partial, untrusted or linked backups and keeps player identity', () =>
  temporary(async (root) => {
    assert.equal(await savedPlayerBackup(root), null);
    const id = '1234567890abcdef1234567890abcdef';
    const base = path.join(root, 'units', id, 'upgrade');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(
      path.join(root, '.pocket-drop-backups.json'),
      '{"format":"pocket-drop-player-backups","version":1}\n',
    );
    await fs.writeFile(path.join(root, 'current-unit'), id);
    const report = {
      state: 'studiopocket',
      layout: { trustedForWrite: true },
      imageSha256: 'a'.repeat(64),
      imageSizeBytes: 4,
    };
    await fs.writeFile(path.join(base, 'read-report.json'), JSON.stringify(report));
    assert.equal(await savedPlayerBackup(root), null);
    await fs.writeFile(path.join(base, 'system.img'), 'test');
    assert.equal((await savedPlayerBackup(root)).unitId, id);
    await fs.writeFile(path.join(base, 'system.img'), 'truncated');
    assert.equal(await savedPlayerBackup(root), null);
    await fs.rm(path.join(base, 'system.img'));
    await fs.writeFile(path.join(root, 'other.img'), 'test');
    await fs.symlink(path.join(root, 'other.img'), path.join(base, 'system.img'));
    assert.equal(await savedPlayerBackup(root), null);
  }));
