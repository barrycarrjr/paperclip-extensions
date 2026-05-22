/**
 * Lists all Google Business Profile accounts accessible to the configured
 * OAuth credentials. Run this to find the numeric googleAccountId needed for
 * the plugin config's locations[].googleAccountId field.
 *
 * Usage:
 *   GBP_CLIENT_ID=<id> GBP_CLIENT_SECRET=<secret> GBP_REFRESH_TOKEN=<token> pnpm tsx scripts/list-accounts.ts
 *
 * Or set the env vars first:
 *   $env:GBP_CLIENT_ID = "..."
 *   $env:GBP_CLIENT_SECRET = "..."
 *   $env:GBP_REFRESH_TOKEN = "..."
 *   pnpm tsx scripts/list-accounts.ts
 */

import { OAuth2Client } from "google-auth-library";

interface GbpAccount {
  name: string;         // e.g. "accounts/123456789"
  accountName: string;  // display name
  type: string;
  role: string;
  state?: { status?: string };
  profilePhotoUrl?: string;
}

interface GbpAccountsResponse {
  accounts?: GbpAccount[];
  nextPageToken?: string;
}

async function main(): Promise<void> {
  const clientId = process.env["GBP_CLIENT_ID"];
  const clientSecret = process.env["GBP_CLIENT_SECRET"];
  const refreshToken = process.env["GBP_REFRESH_TOKEN"];

  if (!clientId || !clientSecret || !refreshToken) {
    console.error("Missing required env vars: GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN");
    console.error("\nUsage (PowerShell):");
    console.error("  $env:GBP_CLIENT_ID = '...'");
    console.error("  $env:GBP_CLIENT_SECRET = '...'");
    console.error("  $env:GBP_REFRESH_TOKEN = '...'");
    console.error("  pnpm tsx scripts/list-accounts.ts");
    process.exit(1);
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const { token } = await oauth2Client.getAccessToken();
  if (!token) {
    console.error("Failed to obtain access token. Check your credentials.");
    process.exit(1);
  }

  const accounts: GbpAccount[] = [];
  let pageToken: string | undefined;

  do {
    const url = `https://mybusiness.googleapis.com/v4/accounts${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`GBP API error ${res.status}: ${text.slice(0, 300)}`);
      process.exit(1);
    }

    const data = JSON.parse(text) as GbpAccountsResponse;
    if (data.accounts) accounts.push(...data.accounts);
    pageToken = data.nextPageToken;
  } while (pageToken);

  if (accounts.length === 0) {
    console.log("No GBP accounts found for this credential.");
    return;
  }

  console.log(`\nFound ${accounts.length} GBP account(s):\n`);
  for (const acct of accounts) {
    // name is "accounts/123456789" — extract the numeric ID
    const numericId = acct.name.split("/").pop() ?? acct.name;
    console.log(`  Display name : ${acct.accountName}`);
    console.log(`  Account ID   : ${numericId}   ← use this as googleAccountId`);
    console.log(`  Type         : ${acct.type}`);
    console.log(`  Role         : ${acct.role}`);
    if (acct.state?.status) console.log(`  Status       : ${acct.state.status}`);
    console.log();
  }

  console.log("Copy the Account ID into plugin config → locations[].googleAccountId");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
