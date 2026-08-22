import { describe, expect, test } from "bun:test";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { createRequestUrlFetch, type RequestUrl } from "../src/request-url-fetch.js";

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): RequestUrlResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers,
    arrayBuffer: bytes.buffer,
    json: JSON.parse(body) as unknown,
    text: body,
  };
}

describe("requestUrl fetch adapter", () => {
  test("maps the request and round-trips a buffered JSON response", async () => {
    let received: RequestUrlParam | string | undefined;
    const requestUrl: RequestUrl = async (request) => {
      received = request;
      return response(201, JSON.stringify({ id: "generated" }), {
        "content-type": "application/json",
        "x-provider": "fake",
      });
    };

    const result = await createRequestUrlFetch(requestUrl)("https://llm.example.test/generate", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });

    expect(received).not.toBeUndefined();
    expect(typeof received).toBe("object");
    const request = received as RequestUrlParam;
    expect(request).toMatchObject({
      url: "https://llm.example.test/generate",
      method: "POST",
      throw: false,
    });
    expect(request.headers).toEqual({
      authorization: "Bearer test",
      "content-type": "application/json",
    });
    expect(new TextDecoder().decode(request.body as ArrayBuffer)).toBe(JSON.stringify({ prompt: "hello" }));
    expect(result.status).toBe(201);
    expect(result.headers.get("x-provider")).toBe("fake");
    expect(await result.json()).toEqual({ id: "generated" });
  });

  test("returns non-2xx statuses as Responses", async () => {
    const requestUrl: RequestUrl = async (request) => {
      expect(request).toMatchObject({ throw: false });
      return response(429, JSON.stringify({ error: "rate limited" }), {
        "retry-after": "10",
      });
    };

    const result = await createRequestUrlFetch(requestUrl)("https://llm.example.test/generate");

    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("10");
    expect(await result.json()).toEqual({ error: "rate limited" });
  });
});
