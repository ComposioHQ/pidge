import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const config = vi.hoisted(() => ({ token: "audit-only-notify-token" as string | undefined }));
vi.mock("@/shared/environment/env", () => ({ env: () => ({ PIDGE_NOTIFY_TOKEN: config.token }) }));
vi.mock("@/web/eve/sessions", () => ({ eveOrigin: () => "http://agent.test" }));

afterEach(() => {
  config.token = "audit-only-notify-token";
  vi.unstubAllGlobals();
});

describe("notification proxy", () => {
  it("rejects unauthorized and disabled calls before reading or forwarding", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "accepted" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    for (const token of [config.token, undefined]) {
      config.token = token;
      const request = new Request("https://pidge.test/api/notify", { method: "POST", body: "unread" });
      expect((await POST(request)).status).toBe(token ? 401 : 404);
      expect(request.bodyUsed).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds streamed bytes despite absent or false length headers", async () => {
    const fetcher = vi.fn(async () => Response.json({}, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    for (const length of [undefined, "1", "20000"]) {
      let chunks = 0;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(8192));
            if (chunks === 10) controller.close();
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const headers: Record<string, string> = { authorization: `Bearer ${config.token}` };
      if (length !== undefined) headers["content-length"] = length;
      const request = new Request("https://pidge.test/api/notify", {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit);
      expect((await POST(request)).status).toBe(413);
      expect(chunks).toBeLessThanOrEqual(3);
      if (length !== "20000") expect(cancel).toHaveBeenCalled();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a validated notification with bearer auth and preserves the upstream status", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "accepted" }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    const payload = { text: "Example notification", idempotencyKey: "example-1" };
    const response = await POST(
      new Request("https://pidge.test/api/notify", {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}` },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(202);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://agent.test/eve/v1/notify");
    expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${config.token}`);
    expect(JSON.parse(options.body as string)).toEqual(payload);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
