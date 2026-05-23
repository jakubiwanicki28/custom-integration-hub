import { logger } from './logger.js';

const log = logger.child({ lib: 'fetch' });

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const hostname = safeHostname(url);
      log.error({ url, timeoutMs }, 'Request timed out');
      throw new Error(`Request to ${hostname} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse JSON from Response with safe error handling — never throws SyntaxError */
export async function safeJson<T>(res: Response): Promise<T> {
  const text = await safeText(res);
  try {
    return JSON.parse(text) as T;
  } catch {
    const hostname = safeHostname(res.url);
    log.error({ url: res.url, status: res.status, body: text.slice(0, 500) },
      `Failed to parse JSON from ${hostname}`);
    throw new Error(`Invalid JSON response from ${hostname} (status ${res.status})`);
  }
}

/** Read Response body as text with safe error handling */
export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const hostname = safeHostname(res.url);
    log.error({ url: res.url, status: res.status },
      `Failed to read response text from ${hostname}`);
    throw new Error(`Failed to read response from ${hostname} (status ${res.status})`);
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
