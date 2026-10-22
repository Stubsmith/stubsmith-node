import { describe, expect, it } from "vitest";
import { GIF_1X1, JPEG_1X1, PNG_1X1, isImage, placeholderFor } from "../../src/privacy/binary.js";

describe("isImage", () => {
  it("accepts image/png", () => {
    expect(isImage("image/png")).toBe(true);
  });

  it("accepts image/jpeg", () => {
    expect(isImage("image/jpeg")).toBe(true);
  });

  it("accepts image/gif", () => {
    expect(isImage("image/gif")).toBe(true);
  });

  it("accepts image/webp", () => {
    expect(isImage("image/webp")).toBe(true);
  });

  it("ignores content type parameters", () => {
    expect(isImage("image/png; charset=utf-8")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isImage("Image/PNG")).toBe(true);
  });

  it("rejects non-image types", () => {
    expect(isImage("application/json")).toBe(false);
    expect(isImage("text/html")).toBe(false);
    expect(isImage("")).toBe(false);
    expect(isImage("video/mp4")).toBe(false);
  });
});

describe("placeholder bytes", () => {
  it("starts the PNG with its magic bytes", () => {
    expect([...PNG_1X1.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("starts the GIF with GIF8", () => {
    expect(Buffer.from(GIF_1X1.subarray(0, 4)).toString("latin1")).toBe("GIF8");
  });

  it("starts the JPEG with its magic bytes", () => {
    expect([...JPEG_1X1.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("starts the GIF with GIF89a", () => {
    expect(Buffer.from(GIF_1X1.subarray(0, 6)).toString("latin1")).toBe("GIF89a");
  });
});

describe("placeholderFor", () => {
  it("maps image/png to the PNG placeholder", () => {
    const { bytes, subtype } = placeholderFor("image/png");
    expect(bytes).toEqual(PNG_1X1);
    expect(subtype).toBe("png");
  });

  it("maps image/gif to the GIF placeholder", () => {
    const { bytes, subtype } = placeholderFor("image/gif");
    expect(bytes).toEqual(GIF_1X1);
    expect(subtype).toBe("gif");
  });

  it("maps image/jpeg to the JPEG placeholder", () => {
    const { bytes, subtype } = placeholderFor("image/jpeg");
    expect(bytes).toEqual(JPEG_1X1);
    expect(subtype).toBe("jpeg");
  });

  it("maps image/jpg to the JPEG placeholder", () => {
    const { bytes, subtype } = placeholderFor("image/jpg");
    expect(bytes).toEqual(JPEG_1X1);
    expect(subtype).toBe("jpeg");
  });

  it("falls back to PNG for an unknown image subtype (webp)", () => {
    const { bytes, subtype } = placeholderFor("image/webp");
    expect(bytes).toEqual(PNG_1X1);
    expect(subtype).toBe("png");
  });

  it("falls back to PNG for an unknown image subtype (avif)", () => {
    const { bytes, subtype } = placeholderFor("image/avif");
    expect(bytes).toEqual(PNG_1X1);
    expect(subtype).toBe("png");
  });

  it("ignores content type parameters", () => {
    const { bytes, subtype } = placeholderFor("image/png; q=0.9");
    expect(bytes).toEqual(PNG_1X1);
    expect(subtype).toBe("png");
  });
});
