import { AccessPolicy, type FilesPolicy } from "../../src/policy/files-policy.js";

/** A policy allowing exactly these roots and denying nothing — the shape most tests want. */
export function filesPolicyFor(...allow: string[]): FilesPolicy {
  return { allow, deny: [] };
}

export function accessPolicyFor(...allow: string[]): AccessPolicy {
  return new AccessPolicy(filesPolicyFor(...allow));
}
