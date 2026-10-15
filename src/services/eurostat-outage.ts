/**
 * @fileoverview Upstream outage classification shared by every Eurostat fetch. An HTTP
 * 5xx answer, or a host that could not be reached, is a failure on Eurostat's side; once
 * it outlasts the retries it is reported as a retryable `upstream_fault`, so a caller can
 * tell an outage from a fault in its own request.
 * @module services/eurostat-outage
 */

import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/** The fields `fetchWithTimeout` and `withRetry` put on the errors they throw. */
interface FetchFailureData {
  errorSource?: string;
  retryAttempts?: number;
  retryable?: boolean;
  status?: number;
}

/**
 * True for a failure on the upstream's side: an HTTP 5xx answer, or a host that could
 * not be reached. A timeout, a 4xx, and a cancellation are not outages.
 */
export function isUpstreamOutage(error: unknown): error is McpError {
  if (!(error instanceof McpError)) return false;
  const data = error.data as FetchFailureData | undefined;
  return (
    (data?.errorSource === 'FetchHttpError' && data.status !== undefined && data.status >= 500) ||
    data?.errorSource === 'FetchNetworkErrorWrapper'
  );
}

/**
 * How an outage read, as a clause for a recovery hint: "answered HTTP 503" when the
 * error's `status` is a number, "could not be reached" when it carries none.
 */
export function outageAnswer(status: unknown): string {
  return typeof status === 'number' ? `answered HTTP ${status}` : 'could not be reached';
}

/**
 * `error` as an `upstream_fault` when it is an outage ({@link isUpstreamOutage}), or
 * `undefined` to leave it as thrown. `endpoint` names the Eurostat endpoint ("Eurostat's
 * Statistics API") and `request` what was asked of it ("a query of dataset "x""); `data`
 * rides along on the error. Every 5xx is retryable except a 501, which the fetch layer
 * marks deterministic.
 */
export function upstreamOutage(
  error: unknown,
  endpoint: string,
  request: string,
  data: Record<string, unknown>,
): McpError | undefined {
  if (!isUpstreamOutage(error)) return;
  const { retryAttempts, retryable, status } = error.data as FetchFailureData;
  if (status !== undefined) {
    const attempts = retryAttempts ? ` (failed after ${retryAttempts} attempts)` : '';
    return serviceUnavailable(
      `${endpoint} answered HTTP ${status} to ${request}${attempts}.`,
      { reason: 'upstream_fault', ...data, status, retryable: retryable !== false },
      { cause: error },
    );
  }
  return serviceUnavailable(
    `${endpoint} could not be reached for ${request}: ${error.message}`,
    { reason: 'upstream_fault', ...data, retryable: true },
    { cause: error },
  );
}
