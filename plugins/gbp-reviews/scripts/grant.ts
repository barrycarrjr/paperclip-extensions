/**
 * One-time OAuth2 grant script for GBP Reviews plugin.
 *
 * Gets a refresh token covering business.manage + gmail.readonly scopes.
 * Run once per Google account; store the printed token as a Paperclip secret.
 *
 * Usage:
 *   pnpm --filter paperclip-plugin-gbp-reviews grant
 *   # or directly:
 *   pnpm tsx scripts/grant.ts
 *
 * Prerequisites:
 *   1. Go to Google Cloud Console → APIs & Services → Credentials
 *   2. Create OAuth 2.0 credentials with Application type = "Web application"
 *   3. Add http://localhost:8080/callback as an Authorized redirect URI
 *   4. Enable: My Business Account API and Gmail API on your GCP project
 *   5. Set GBP_CLIENT_ID and GBP_CLIENT_SECRET env vars (or enter when prompted)
 *
 * Note: "TVs and Limited Input devices" (device code flow) does NOT support the
 * business.manage scope. Web application type is required.
 */

import * as http from "node:http";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { OAuth2Client } from "google-auth-library";

const REDIRECT_PORT = 8080;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/gmail.readonly",
];

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  const clientId =
    process.env["GBP_CLIENT_ID"] ??
    (await rl.question("OAuth Client ID: ")).trim();
  const clientSecret =
    process.env["GBP_CLIENT_SECRET"] ??
    (await rl.question("OAuth Client Secret: ")).trim();

  rl.close();

  if (!clientId || !clientSecret) {
    console.error("Client ID and secret are required.");
    process.exit(1);
  }

  const oAuth2Client = new OAuth2Client({ clientId, clientSecret, redirectUri: REDIRECT_URI });

  const authorizeUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force refresh token even if previously granted
  });

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Open this URL in your browser to authorize:");
  console.log(`\n  ${authorizeUrl}\n`);
  console.log(`  (waiting for callback on http://localhost:${REDIRECT_PORT}/callback)`);
  console.log("═══════════════════════════════════════════════════\n");

  // Wait for browser redirect with auth code
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const parsed = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (parsed.pathname !== "/callback") return;

      const code = parsed.searchParams.get("code");
      const error = parsed.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Authorization denied. You can close this tab.</h2>");
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Authorization successful! You can close this tab.</h2>");
        server.close();
        resolve(code);
      }
    });

    server.listen(REDIRECT_PORT, "localhost");
    server.on("error", (err) => {
      reject(new Error(`Could not start local server on port ${REDIRECT_PORT}: ${err.message}`));
    });
  });

  // Exchange auth code for tokens
  const { tokens } = await oAuth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error("\n❌ No refresh token returned.");
    console.error("   This happens when access was previously granted without revoking.");
    console.error("   Revoke at https://myaccount.google.com/permissions then run again.");
    process.exit(1);
  }

  console.log("\n✅ Success! Create a Paperclip secret with this refresh token:\n");
  console.log(`REFRESH TOKEN: ${tokens.refresh_token}\n`);
  console.log("Then add the secret UUID to the plugin config under accounts[].refreshTokenRef.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
