// SPDX-License-Identifier: GPL-3.0-only
export function newerVersion(candidate, current) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const a = parse(candidate),
    b = parse(current);
  return !!a && !!b && a.some((n, i) => n > b[i] && a.slice(0, i).every((v, j) => v === b[j]));
}
export async function checkUpdate(repository, current, arch, { fetcher = fetch } = {}) {
  if (!repository)
    return {
      status: 'unconfigured',
      current,
      message: 'No update source is configured yet. Open Downloads for shared builds.',
    };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('Use a GitHub repository in owner/name form.');
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'No public release was found for this repository.'
        : 'The update service is unavailable. Try again later.',
    );
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1024 ** 2) throw new Error('Update response is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!/^v?\d+\.\d+\.\d+$/.test(data.tag_name))
    throw new Error('The release version is not recognized.');
  const asset = (data.assets ?? []).find((a) =>
    new RegExp(`-mac-${arch === 'arm64' ? 'arm64' : 'x64'}\\.zip$`, 'i').test(a.name),
  );
  const url = asset?.browser_download_url;
  if (
    url &&
    !url
      .toLowerCase()
      .startsWith(`https://github.com/${repository.toLowerCase()}/releases/download/`)
  )
    throw new Error('Unexpected update download address.');
  return {
    status: newerVersion(data.tag_name, current) ? 'available' : 'current',
    current,
    version: data.tag_name,
    notes: String(data.body ?? 'No release notes supplied.').slice(0, 20000),
    url: url ?? null,
    message: asset ? '' : 'This release has no download for this Mac.',
  };
}
