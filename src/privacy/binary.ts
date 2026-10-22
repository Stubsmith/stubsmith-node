/**
 * Image body placeholder handling. Port of stubsmith/privacy/binary.py.
 *
 * `image/*` bodies are replaced by a canonical 1x1 placeholder before
 * fingerprinting and masking, so pixel data and EXIF never leave the process.
 */
import { normaliseContentType } from "./fingerprint.js";

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** 1x1 transparent PNG (used for `image/png` and any unknown `image/*`). */
export const PNG_1X1: Uint8Array = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
);

/** 1x1 transparent GIF89a (used for `image/gif`). */
export const GIF_1X1: Uint8Array = b64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");

/** 1x1 JPEG, minimal valid JFIF (used for `image/jpeg` and `image/jpg`). */
export const JPEG_1X1: Uint8Array = b64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEB" +
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/" +
  "wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/aAAcBAQAAAH/" +
  "//9k=",
);

/** True for any `image/*` media type (case-insensitive, parameters ignored). */
export function isImage(contentType: string | null | undefined): boolean {
  return normaliseContentType(contentType).startsWith("image/");
}

/** Placeholder bytes and canonical subtype (`png`, `gif`, `jpeg`); unknown `image/*` gives PNG. */
export function placeholderFor(contentType: string | null | undefined): { bytes: Uint8Array; subtype: string } {
  const ct = normaliseContentType(contentType);
  if (ct === "image/gif") return { bytes: GIF_1X1, subtype: "gif" };
  if (ct === "image/jpeg" || ct === "image/jpg") return { bytes: JPEG_1X1, subtype: "jpeg" };
  return { bytes: PNG_1X1, subtype: "png" };
}
