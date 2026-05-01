#!/usr/bin/env -S tsx
/**
 * One-time helper: obtain a Google OAuth refresh token for a Google Workspace
 * account so the plugin can act on its behalf.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...  pnpm --filter paperclip-plugin-google-workspace grant <account-key>
 *
 * What it does:
 *   1. Spins up a localhost HTTP server on http://localhost:54321/oauth/callback.
 *   2. Builds the Google OAuth consent URL (with the plugin's default scopes
 *      plus offline access + force prompt, so we always get a refresh token).
 *   3. Opens the URL in the default browser.
 *   4. Receives the redirect, exchanges the auth code for a refresh token,
 *      prints the refresh token to the terminal with paste-into-Paperclip
 *      instructions.
 *
 * What it does NOT do:
 *   - Write to Paperclip's secret store (you copy the printed value into the
 *     company's Secrets page yourself).
 *   - Persist the client ID / secret (passed as env vars each run).
 *
 * If the redirect is blocked by your browser or you see "this site can't be
 * reached", make sure http://localhost:54321 is allowed by your firewall and
 * that the OAuth client in Google Cloud Console has
 * http://localhost:54321/oauth/callback listed as an authorized redirect URI
 * (Desktop OAuth client type — these are usually allowed by default for any
 * loopback address, but Web client types require explicit listing).
 */
import { createServer } from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { OAuth2Client } from "google-auth-library";

const execp = promisify(exec);

const REDIRECT_PORT = 54321;
const REDIRECT_PATH = "/oauth/callback";
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function fail(msg: string): never {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  try {
    await execp(cmd);
  } catch {
    console.error(`\n(couldn't auto-open browser — paste this URL manually:)\n  ${url}\n`);
  }
}

async function main(): Promise<void> {
  const [, , accountKey, ...rest] = process.argv;
  if (!accountKey || rest.length > 0) {
    fail(
      "Usage: pnpm --filter paperclip-plugin-google-workspace grant <account-key>\n" +
        "Pass the account key (e.g. 'personal') as the only positional arg.\n" +
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars before running.",
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fail(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars must be set.\n" +
        "Get them from Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client ID (Desktop app type).",
    );
  }

  const scopesEnv = process.env.GOOGLE_SCOPES;
  const scopes = scopesEnv ? scopesEnv.split(",").map((s) => s.trim()) : DEFAULT_SCOPES;

  const oauth2Client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  console.log(`\n--- Google OAuth grant for "${accountKey}" ---`);
  console.log(`Scopes: ${scopes.join(", ")}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log("\nOpening consent screen in your browser...\n");

  const code: string = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
        if (reqUrl.pathname !== REDIRECT_PATH) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const err = reqUrl.searchParams.get("error");
        if (err) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            `<h1>Auth error</h1><p>${err}</p><p>You can close this window and re-run the script.</p>`,
          );
          server.close();
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        const c = reqUrl.searchParams.get("code");
        if (!c) {
          res.writeHead(400);
          res.end("missing code");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          "<h1>Auth granted</h1><p>You can close this window and return to the terminal.</p>",
        );
        server.close();
        resolve(c);
      } catch (e) {
        try {
          res.writeHead(500);
          res.end("error");
        } catch {
          /* ignore */
        }
        server.close();
        reject(e);
      }
    });
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      void openBrowser(authUrl);
    });
    server.on("error", reject);
  });

  console.log("Auth code received, exchanging for refresh token...");
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    fail(
      "No refresh_token was returned. Common causes:\n" +
        "  - You've already granted this account before — revoke it at https://myaccount.google.com/permissions and retry.\n" +
        "  - The OAuth client type isn't 'Desktop app' or 'Web app' with the right config.\n" +
        "Re-run the script after revoking.",
    );
  }

  console.log("\n========================================================================");
  console.log(`Refresh token for account "${accountKey}":\n`);
  console.log(tokens.refresh_token);
  console.log("\n------------------------------------------------------------------------");
  console.log("Next steps inside Paperclip:");
  console.log(
    `  1. Pick the company that should own this account (e.g. Personal, Operations).`,
  );
  console.log(`  2. Open /instance/settings/companies/<company>/secrets and create a Secret.`);
  console.log(`     Name suggestion: "google-${accountKey}-refresh-token"`);
  console.log(`     Value: paste the refresh token above.`);
  console.log(`  3. Also create Secrets for:`);
  console.log(`     - "google-${accountKey}-client-id"     value: ${clientId.slice(0, 8)}…`);
  console.log(`     - "google-${accountKey}-client-secret" value: (the GOOGLE_CLIENT_SECRET)`);
  console.log(`  4. Open /instance/settings/plugins/google-workspace and add an account:`);
  console.log(`     - Identifier: ${accountKey}`);
  console.log(`     - Email: (the Google email you authenticated as)`);
  console.log(`     - Allowed companies: tick the company UUID(s) that should use it`);
  console.log(`     - clientIdRef / clientSecretRef / refreshTokenRef: paste the secret UUIDs`);
  console.log("========================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
