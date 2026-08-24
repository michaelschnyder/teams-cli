export type DiagnosticsOptions = {
  progress: boolean;
  debug: boolean;
};

let options: DiagnosticsOptions = { progress: false, debug: false };
let activeStatus: string | null = null;
let requestAttempt = 1;

export function configureDiagnostics(next: DiagnosticsOptions): void {
  options = next;
  activeStatus = null;
  requestAttempt = 1;
}

export function setRequestAttempt(attempt: number): void {
  requestAttempt = attempt;
}

export function showStatus(message: string): void {
  if (!options.progress) return;
  activeStatus = message;
  process.stderr.write(`\r\x1b[2K${message}`);
}

export function clearStatus(): void {
  if (!options.progress || activeStatus === null) return;
  process.stderr.write("\r\x1b[2K");
  activeStatus = null;
}

function sanitizedUrl(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const parts = url.pathname.split("/").map((part, index, all) =>
    all[index - 1] === "conversations" || all[index - 1] === "messages"
      ? "<redacted>"
      : part);
  return `${url.origin}${parts.join("/")}`;
}

function debugLine(message: string): void {
  if (!options.debug) return;
  if (activeStatus !== null) process.stderr.write("\r\x1b[2K");
  process.stderr.write(`[debug] ${message}\n`);
  if (activeStatus !== null) process.stderr.write(activeStatus);
}

export function debugDecision(message: string): void {
  debugLine(message);
}

export async function observedFetch(
  implementation: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const url = sanitizedUrl(input);
  const started = performance.now();
  debugLine(`request method=${method} url=${url} attempt=${requestAttempt}`);
  try {
    const response = await implementation(input, init);
    debugLine(
      `response method=${method} url=${url} status=${response.status} durationMs=${Math.round(performance.now() - started)} attempt=${requestAttempt}`,
    );
    return response;
  } catch (error) {
    const category = error instanceof DOMException && error.name === "AbortError"
      ? "aborted"
      : error instanceof TypeError ? "network" : "unknown";
    debugLine(
      `error method=${method} url=${url} category=${category} durationMs=${Math.round(performance.now() - started)} attempt=${requestAttempt}`,
    );
    throw error;
  }
}
