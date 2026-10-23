/** Reads a newline-delimited JSON response and calls onEvent for each line. */
export async function readNdjson<E>(response: Response, onEvent: (event: E) => void): Promise<void> {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as E);
      newline = buffer.indexOf("\n");
    }
  }
}
