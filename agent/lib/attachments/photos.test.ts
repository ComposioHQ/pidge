import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { FilePart, ModelMessage, TextPart, UserContent } from "ai";
import type { FetchFileFunction } from "eve/channels";
import { photonIMessageChannel } from "eve/channels/photon";
import { afterEach, describe, expect, it, vi } from "vitest";
import rawMessage from "../../../test/fixtures/photos/message.json";
import photon from "../../channels/photon";
import { withReadablePhotos } from "./photos";

// Exercise the installed 0.83.3 pipeline. These internals are test-only and intentionally version-sensitive (D2).
const eveRoot = new URL("./", import.meta.resolve("eve"));
const internals = (path: string) => import(new URL(path, eveRoot).href);
const { addPhotonAttachmentDownloads } = await internals("public/channels/photon/attachments.js");
const { photonInboundContent } = await internals("public/channels/photon/inboundContent.js");
const { stageAttachmentsForAdapter, hydrateSandboxAttachments } = await internals("harness/attachment-staging.js");
const { ContextContainer, contextStorage } = await internals("context/container.js");
const { SandboxKey } = await internals("context/keys.js");
const { ChannelKey } = await internals("runtime/sessions/runtime-context-keys.js");
const heic = await readFile(new URL("../../../test/fixtures/photos/example.heic", import.meta.url));
const png = await readFile(new URL("../../../test/fixtures/photos/example.png", import.meta.url));

afterEach(() => vi.restoreAllMocks());

/** No webhook dispatch, model, message sends, notifications, or network. Only the download action is stubbed. */
async function pipeline(channel: unknown, raw: unknown = rawMessage, bytes = heic, downloadError?: Error) {
  const { adapter } = channel as typeof photon & {
    adapter: {
      fetchFile: FetchFileFunction;
      createAdapterContext: (input: unknown) => {
        bot: {
          getAdapter: (name: string) => {
            initialize: () => Promise<void>;
            parseMessage: (raw: unknown) => unknown;
            app: unknown;
          };
        };
      };
    };
  };
  const imessage = adapter.createAdapterContext({ state: { thread: null }, session: {} }).bot.getAdapter("imessage");
  vi.spyOn(imessage, "initialize").mockImplementation(async () => {});
  const download = vi.fn(async () => {
    if (downloadError) throw downloadError;
    return { read: async () => bytes };
  });
  imessage.app = {
    __internal: { platforms: new Map([["iMessage", { definition: { actions: { getAttachment: download } } }]]) },
  };
  const message = imessage.parseMessage(raw);
  await addPhotonAttachmentDownloads(message, imessage);
  const content = photonInboundContent(message) as UserContent;
  // Simulate the queue serialization that drops fetchData closures.
  const queued = JSON.parse(JSON.stringify(content));
  const files = new Map<string, Buffer>();
  const sandbox = {
    resolvePath: (path: string) => `/workspace/${path}`,
    writeBinaryFile: async ({ path, content }: { path: string; content: Buffer }) => {
      files.set(`/workspace/${path}`, content);
    },
    readBinaryFile: async ({ path }: { path: string }) => files.get(path) ?? null,
  };
  const ctx = new ContextContainer();
  ctx.set(ChannelKey, adapter);
  ctx.set(SandboxKey, { open: async () => sandbox });
  const hydrated: ModelMessage[] = await contextStorage.run(ctx, async () => {
    const staged = await stageAttachmentsForAdapter(queued, sandbox, { ctx, session: {}, state: {} });
    return hydrateSandboxAttachments([{ role: "user", content: staged }]);
  });
  return { content: hydrated[0]?.content as (FilePart | TextPart)[], download };
}

describe("iMessage photos through pinned Eve and Photon", () => {
  it("reproduces the old HEIC text-reference failure", async () => {
    const original = photonIMessageChannel({ credentials: async () => ({ projectId: "test", projectSecret: "test" }) });
    const { content, download } = await pipeline(original);
    expect(download).toHaveBeenCalledWith(expect.anything(), "test-photo-attachment", "+12025550124");
    expect(content).toContainEqual({ type: "text", text: "What is in this photo?" });
    expect(content.some((part) => part.type === "file")).toBe(false);
    expect(JSON.stringify(content)).toContain("image/heic");
  });

  it.each([true, false])("delivers JPEG bytes to the model with caption=%s", async (caption) => {
    const raw = caption ? rawMessage : { ...rawMessage, content: rawMessage.content.items[1]?.content };
    const { content, download } = await pipeline(photon, raw);
    expect(download).toHaveBeenCalledOnce();
    const image = content.find((part) => part.type === "file");
    expect(image?.mediaType).toBe("image/jpeg");
    expect(Buffer.isBuffer(image?.data)).toBe(true);
    expect(Buffer.from((image?.data ?? []) as Uint8Array).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(image?.filename).toMatch(/\/photo\.jpg$/);
  });

  it("keeps a normal PNG readable without conversion", async () => {
    const raw = structuredClone(rawMessage);
    const attachment = raw.content.items[1]?.content;
    Object.assign(attachment ?? {}, { name: "photo.png", mimeType: "image/png", size: png.length });
    const { content } = await pipeline(photon, raw, png);
    expect(content.find((part) => part.type === "file")).toMatchObject({ mediaType: "image/png", data: png });
  });

  it("turns corrupt HEIC and failed downloads into notes while retaining the caption", async () => {
    for (const failure of ["conversion", "download"]) {
      vi.restoreAllMocks();
      const { content } = await pipeline(
        photon,
        rawMessage,
        Buffer.from("not an image"),
        failure === "download" ? new Error("test download failed") : undefined,
      );
      expect(content).toContainEqual({ type: "text", text: "What is in this photo?" });
      expect(content.some((part) => part.type === "file")).toBe(false);
      expect(JSON.stringify(content)).toContain("could not be retrieved");
      if (failure === "conversion") expect(JSON.stringify(content)).toContain("could not be converted to JPEG");
    }
  });

  it("recognizes HEIC bytes with generic MIME and preserves unrelated resolver results", async () => {
    const fetchFile = vi
      .fn<FetchFileFunction>()
      .mockResolvedValue({ bytes: heic, mediaType: "application/octet-stream" });
    expect(await withReadablePhotos(fetchFile)("test:")).toMatchObject({ mediaType: "image/jpeg" });
    fetchFile.mockResolvedValue(png);
    expect(await withReadablePhotos(fetchFile)("test:")).toBe(png);
    fetchFile.mockResolvedValue(null);
    expect(await withReadablePhotos(fetchFile)("https://example.test/")).toBeNull();
  });

  it("rejects images over Eve's model limits and videos with a note", async () => {
    const wide = execFileSync("convert", ["-size", "8001x1", "xc:white", "png:-"]);
    const heavy = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    const cases: [Buffer, string, string][] = [
      [wide, "image/png", "too large"],
      [heavy, "image/png", "too large"],
      [png, "video/quicktime", "Videos aren't supported"],
    ];
    for (const [bytes, mediaType, message] of cases) {
      const fetchFile = vi.fn<FetchFileFunction>().mockResolvedValue({ bytes, mediaType });
      await expect(withReadablePhotos(fetchFile)("test:")).rejects.toThrow(message);
    }
  });
});
