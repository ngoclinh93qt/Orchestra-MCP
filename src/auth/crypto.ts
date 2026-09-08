import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit-entropy URL-safe secret, suitable for authorization codes and tokens. */
export function generateSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex-encoded digests, safe against timing attacks. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity

/** A human-typeable one-time recovery code, shown exactly once at enrollment. */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g += 1) {
    let group = "";
    for (let i = 0; i < 5; i += 1) {
      group += RECOVERY_ALPHABET[randomBytes(1)[0]! % RECOVERY_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Normalizes user-typed recovery codes before hashing/comparing (case, dashes, spacing). */
export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]+/g, "");
}
