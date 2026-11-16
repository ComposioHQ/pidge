/**
 * Normalizes an iMessage sender handle (phone number or email) to a canonical form:
 * - emails: trimmed, lowercased
 * - phone numbers: E.164 (`+` and digits); 10-digit numbers are treated as North American (+1)
 * Returns null for anything that is neither, so callers fail closed.
 */
export function normalizeImessageHandle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^(tel:|mailto:|imessage:)/i, "");
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Display form that hides most of a handle, for UI lists and logs that must not carry full contact details. */
export function maskHandle(handle: string): string {
  if (handle.includes("@")) {
    const [local = "", domain = ""] = handle.split("@");
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${handle.slice(0, 2)}******${handle.slice(-2)}`;
}
