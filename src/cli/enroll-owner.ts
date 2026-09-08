import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateRecoveryCode, generateSecret } from "../auth/crypto.js";
import { OAuthStore } from "../auth/oauth-store.js";
import { loadConfig } from "../config.js";

/**
 * Generates the owner's one-time recovery code (used to approve the very first, and every
 * subsequent, OAuth authorization) and a local bearer token (for loopback clients that skip the
 * interactive OAuth flow). Both are printed exactly once, here, and stored only as hashes.
 * Re-running this command rotates both credentials.
 */
function main(): void {
  const config = loadConfig(process.env);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });

  const dbPath = join(config.stateDir, "bridge.sqlite3");
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true, mode: 0o700 });

  const store = new OAuthStore(dbPath);
  try {
    const recoveryCode = generateRecoveryCode();
    const localBearerToken = generateSecret();
    store.setRecoveryCode(recoveryCode);
    store.setLocalBearerToken(localBearerToken);
    chmodSync(dbPath, 0o600);

    // eslint-disable-next-line no-console
    console.log("Agent Bridge MCP — owner enrollment complete.\n");
    // eslint-disable-next-line no-console
    console.log("Save both of these in your password manager now. Neither is shown again.\n");
    // eslint-disable-next-line no-console
    console.log(`Recovery code (approves the ChatGPT OAuth connection):\n  ${recoveryCode}\n`);
    // eslint-disable-next-line no-console
    console.log(`Local bearer token (for a loopback MCP client, e.g. ChatGPT Desktop):\n  ${localBearerToken}\n`);
  } finally {
    store.close();
  }
}

main();
