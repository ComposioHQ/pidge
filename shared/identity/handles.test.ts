import { describe, expect, it } from "vitest";
import { normalizeImessageHandle } from "./handles";

describe("normalizeImessageHandle", () => {
  it("maps equivalent phone spellings to one E.164 identity", () => {
    for (const raw of ["+1 (415) 555-0100", "4155550100", "14155550100", "tel:+14155550100", " +1.415.555.0100 "]) {
      expect(normalizeImessageHandle(raw)).toBe("+14155550100");
    }
    expect(normalizeImessageHandle("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("lowercases emails", () => {
    expect(normalizeImessageHandle("  Alex@Example.COM ")).toBe("alex@example.com");
    expect(normalizeImessageHandle("mailto:a@b.co")).toBe("a@b.co");
  });

  it("rejects anything that is not a phone number or email", () => {
    for (const raw of ["", "hello", "555-0100", "+1", "a@b", "+123456789012345678", "41555501OO"]) {
      expect(normalizeImessageHandle(raw)).toBeNull();
    }
  });
});
