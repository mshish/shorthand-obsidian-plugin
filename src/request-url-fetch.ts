import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export type RequestUrl = (
  request: RequestUrlParam | string,
) => Promise<RequestUrlResponse>;

/**
 * Obsidian plugins run in Chromium's renderer, where global fetch is subject to CORS;
 * requestUrl is the plugin API for requests the renderer would refuse. Anthropic in
 * particular rejects direct browser-origin calls without an explicit opt-in header.
 * Injecting this fetch also prevents the AI SDK from selecting its Node-only download
 * path, whose dynamic undici import cannot resolve from a bundled plugin with no
 * node_modules.
 *
 * The LLM backend uses only buffered generateText calls, so no streaming bridge is
 * needed here.
 *
 * requestUrl has no cancellation API, so this adapter deliberately cannot forward the
 * Request's signal. A timed-out pass therefore leaves its HTTP request running, and repeated
 * timeouts can accumulate dangling requests for the life of a capture. This wastes sockets and
 * memory but cannot corrupt conversation history: LlmAgentClient checks both the pass generation
 * and signal.aborted before appending a late response.
 */
export function createRequestUrlFetch(requestUrl: RequestUrl): typeof window.fetch {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const body = request.body === null ? undefined : await request.arrayBuffer();

    const result = await requestUrl({
      url: request.url,
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      // Provider errors must reach the AI SDK as responses so it can interpret a 401 or
      // 429 instead of seeing an opaque transport exception.
      throw: false,
    });

    // The Fetch Response constructor forbids bodies for these statuses even when the
    // buffered body is empty; preserving that rule prevents successful no-content calls
    // from turning into constructor errors.
    const responseBody = [204, 205, 304].includes(result.status) ? null : result.arrayBuffer;
    return new Response(responseBody, {
      status: result.status,
      headers: result.headers,
    });
  };

  // Bun's test globals add a non-standard `fetch.preconnect` member to typeof fetch.
  // The AI SDK consumes the standard call signature only, and Obsidian's Chromium fetch
  // has no such member, so manufacturing a misleading no-op property would hide that fact.
  return fetch as typeof window.fetch;
}
