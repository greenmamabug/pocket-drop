// SPDX-License-Identifier: GPL-3.0-only
import { probeToolReport } from '../vendor/firmware-tools/dist/node.js';

export function toolStartupError(report, { beforeWrite = false } = {}) {
  const detail = [report.stderr, report.stdout].filter(Boolean).join('\n').slice(-16000);
  const reason = report.timedOut
    ? 'The USB updater took too long to start on this Mac (90 seconds).'
    : report.code !== null && report.code !== undefined && report.code !== 0
      ? `The USB updater stopped during its startup check (exit ${report.code}).`
      : report.signal
        ? `macOS stopped the USB updater during its startup check (${report.signal}).`
        : 'The USB updater did not confirm that its player identity check is available.';
  const cause = detail
    .split('\n')
    .reverse()
    .find((line) => /\b\w*(?:Error|Exception):|Library not loaded|dyld\[/i.test(line))
    ?.trim();
  return new Error(
    reason +
      (cause ? '\n' + cause : '') +
      '\nNothing was written to the player. Keep your backup. Close other player-updater apps, then use Check update files and try again.' +
      (beforeWrite ? '\nYour prepared update is saved; choose Review update to retry.' : '') +
      '\n\nUSB updater startup details:\n' +
      (detail || 'The tool returned no startup output.'),
  );
}

export async function checkPlayerTool(
  binary,
  cwd,
  { inspect = probeToolReport, env = process.env, log = () => {} } = {},
) {
  let report;
  try {
    // Same environment as a write probe, but no plan, port, or device read/write is requested.
    report = await inspect(binary, cwd, { ...env, STUDIO_POCKET_EXPECT_CID: '0'.repeat(32) }, log);
  } catch (error) {
    throw toolStartupError({
      passed: false,
      stdout: '',
      stderr: String(error.message),
      code: null,
      signal: null,
      timedOut: false,
    });
  }
  if (!report.passed) throw toolStartupError(report);
  log('USB updater identity check verified. No player was opened.');
  return report;
}

// The upstream check still runs immediately before a write; a failed probe receives no plan.
export function playerPlatform(platform, log) {
  return {
    ...platform,
    overrides: async () => ({}),
    runMtk: async (plan, onLog, options) => {
      const result = await platform.runMtk(plan, onLog, options);
      if (result.probeRefused) {
        log('USB updater refused the pre-write capability check.');
        throw toolStartupError({ ...result, code: null }, { beforeWrite: true });
      }
      return result;
    },
  };
}
