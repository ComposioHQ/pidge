import { execFile } from "node:child_process";
import { attachmentError, type FetchFileFunction } from "eve/channels";

// Eve 0.83.3 shows the model JPEG, PNG, GIF, and WebP only up to 3 MiB and 8,000 px per side. Larger images were
// silently reduced to a file label, so reject them with a note the model can relay.
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SIDE = 8000;
const TOO_LARGE =
  "This image is too large to view (limit 3 MiB and 8,000 pixels per side). Ask for a smaller copy or a screenshot.";

/** Keep Eve's authenticated Photon download, then normalize HEIC and reject what the model cannot see. */
export function withReadablePhotos(fetchFile: FetchFileFunction): FetchFileFunction {
  return async (url, context) => {
    const file = await fetchFile(url, context);
    if (file === null) return null;
    const bytes = Buffer.isBuffer(file) ? file : file.bytes;
    const mediaType = Buffer.isBuffer(file) ? "" : (file.mediaType ?? "");
    if (/^video\//i.test(mediaType)) {
      throw attachmentError("Videos aren't supported yet. Ask for a photo or a short description instead.");
    }
    // Photon MIME metadata can be missing or generic. Read the HEIF container's brands instead.
    const brands = bytes.toString("ascii", 8, Math.min(bytes.length, bytes.length >= 4 ? bytes.readUInt32BE(0) : 0));
    const heic = bytes.toString("ascii", 4, 8) === "ftyp" && /heic|heix|hevc|hevx/.test(brands);
    if (!heic && !/^image\/hei[cf]$/i.test(mediaType)) {
      if (viewableImage(bytes)) await assertFits(bytes);
      return file;
    }
    let jpeg: Buffer;
    try {
      // Decode only the primary still. No user-controlled paths or shell, and no persistent temporary files.
      // jpeg:extent lowers quality (not dimensions) so ordinary iPhone photos stay under Eve's byte limit.
      jpeg = await magick(
        "convert",
        ["heic:-[0]", "-auto-orient", "-strip", "-define", "jpeg:extent=3000KB", "jpeg:-"],
        bytes,
      );
    } catch (cause) {
      throw attachmentError("This photo could not be converted to JPEG. Ask for a JPEG or PNG copy.", { cause });
    }
    await assertFits(jpeg);
    return { bytes: jpeg, mediaType: "image/jpeg", filename: "photo.jpg" };
  };
}

/** JPEG, PNG, GIF, or WebP: the formats Eve inlines for the model. */
function viewableImage(b: Buffer): boolean {
  return (
    (b[0] === 0xff && b[1] === 0xd8) ||
    b.toString("latin1", 0, 4) === "\x89PNG" ||
    b.toString("ascii", 0, 4) === "GIF8" ||
    (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP")
  );
}

async function assertFits(bytes: Buffer): Promise<void> {
  if (bytes.length > MAX_BYTES) throw attachmentError(TOO_LARGE);
  // An unreadable header is left to Eve's own handling.
  const size = await magick("identify", ["-format", "%w %h", "-[0]"], bytes).catch(() => null);
  if (size && Math.max(...size.toString().split(" ").map(Number)) > MAX_SIDE) throw attachmentError(TOO_LARGE);
}

function magick(command: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: "buffer", timeout: 30_000, maxBuffer: 25 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}
