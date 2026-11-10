// SPDX-License-Identifier: GPL-3.0-only
// Diagnose the transfer error before secondary Python stdout-cleanup exceptions.
export function playerWriteFailure(lines, verificationDetail = '') {
  const lostSerial = lines.some((line) =>
    /termios\.error:.*(?:Device not configured|Input\/output error)|(?:SerialException|OSError):.*(?:device disconnected|device not configured|device reports readiness to read but returned no data)/i.test(
      line,
    ),
  );
  return (
    (lostSerial
      ? 'The USB serial connection to the player became unavailable during writing. '
      : 'The player update did not finish verification. ') +
    'The update is incomplete. Keep the backup and prepared image. Use Review update to retry; do not make a new backup from the player. ' +
    (lostSerial
      ? 'For repeated USB failures, stop further write attempts and use Test USB connection — read only first. '
      : '') +
    (verificationDetail ? '\n\nVerification details: ' + verificationDetail : '')
  );
}
