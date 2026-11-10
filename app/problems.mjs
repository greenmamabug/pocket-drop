// SPDX-License-Identifier: GPL-3.0-only
export function describeProblem(error) {
  const details = String(error?.message ?? error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[private URL hidden]')
    .slice(0, 16000);
  let summary = 'This audio item could not be prepared.',
    action = 'Check the files listed below, then Refresh and try again.';
  if (/unsupported|cannot read this as|codec|cannot play/i.test(details)) {
    summary = 'An audio file is unsupported or unreadable.';
    action =
      'Use MP3, AAC/M4A, or Opus. Try playing the affected file on your computer; download a fresh copy if it is damaged.';
  } else if (/space|ENOSPC|need \d+ bytes/i.test(details)) {
    summary = 'There is not enough storage space.';
    action =
      'Check whether the message names your Mac or Pocket, free space there, then try again.';
  } else if (/checksum|corrupt|Cannot read this 7z|central directory/i.test(details)) {
    summary = 'The archive may be incomplete or damaged.';
    action =
      'Let the download finish, or download the archive again. Keep your current original until its replacement works.';
  } else if (/No.*audio|no playlist|no track/i.test(details)) {
    summary = 'No playable audio was found.';
    action =
      'Choose the folder or archive that contains the audio files. Track-list and card-detail files are optional.';
  } else if (/changed|missing|ENOENT|unavailable|disconnected/i.test(details)) {
    summary = 'A file or device changed or became unavailable.';
    action =
      'Finish moving or downloading files, reconnect Pocket if needed, and Refresh before trying again.';
  }
  const files = [
    ...new Set(
      (details.match(/[^\n:]*\.(?:mp3|m4a|m4b|aac|opus|flac|wav|ogg|7z|zip)/gi) ?? []).map((s) =>
        s.trim(),
      ),
    ),
  ].slice(0, 100);
  return { summary, action, files, details };
}
