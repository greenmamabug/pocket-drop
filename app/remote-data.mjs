// SPDX-License-Identifier: GPL-3.0-only
// Bounds apply to streamed responses as well as Content-Length.
export async function remoteData(fetcher, url, { limit = 2 * 1024 ** 2, ...options } = {}) {
  const response = await fetcher(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(
      `The service could not complete the request (${response.status}). Try again later.`,
    );
    error.status = response.status;
    throw error;
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('The service returned too much data.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The service returned no data.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('The service returned too much data.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
