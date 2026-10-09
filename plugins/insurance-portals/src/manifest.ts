import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "insurance-portals";
const PLUGIN_VERSION = "0.2.1";

const SETUP_INSTRUCTIONS = `# Setup — Insurance Portals

Lets agents fetch the current policy and declarations-page PDFs from **Foremost**, **Liberty Mutual** and **Selective** and save them to Google Drive (or any folder on this computer). Reckon on **about 15 minutes**.

The plugin is **read-only**: it only signs in and opens documents. It never pays, changes a policy or submits anything, and once signed in it blocks any request that looks like a payment, change or submission.

Agents never see the portal user names, passwords or login codes. They only call \`insurance_fetch_documents\` and get back file names and Drive links.

---

## 1. Save the secrets (Company settings → Secrets)

Open the company that will use this plugin, then **Company settings → Secrets → New secret**. Create one secret per line. The names are suggestions; the plugin only cares which secret you pick in step 3.

| Secret name | Value |
|---|---|
| \`FOREMOST_USERNAME\` | your Foremost sign-in user name or email |
| \`FOREMOST_PASSWORD\` | your Foremost password |
| \`LIBERTY_MUTUAL_USERNAME\` | your Liberty Mutual sign-in user name or email |
| \`LIBERTY_MUTUAL_PASSWORD\` | your Liberty Mutual password |
| \`SELECTIVE_USERNAME\` | your Selective (MySelective) user ID |
| \`SELECTIVE_PASSWORD\` | your Selective password |

You only need the pairs for carriers you use.

## 2. Mailbox for login codes (Liberty Mutual and Selective)

Liberty Mutual and Selective email a one-time code at sign-in. The plugin reads it from the mailbox they send to.

**Gmail:** turn on 2-Step Verification for the Google account, then create an app password at **myaccount.google.com/apppasswords** and save it as a secret (e.g. \`GMAIL_APP_PASSWORD\`). If the Email Tools plugin already uses an app password for this mailbox, you can pick that same secret instead.

What the plugin reads, and nothing else: it opens the folder read-only, looks only at mail **from** the carrier that is signing in (Foremost: foremost.com and its subdomains such as policy.foremost.com; Liberty Mutual: libertymutual.com; Selective: selective.com and its subdomains such as underwritingalerts.selective.com), and downloads only the **newest** such message that arrived after it asked for the code. Nothing is marked read, moved or deleted.

## 3. Where files are saved

Two ways, picked by **Save to** (default \`auto\`):

- **Local folder (no Google keys needed).** If Google Drive for desktop is installed and signed in, the plugin finds its **My Drive** folder by itself and saves there, so the files sync to Drive. To use another folder, set **Local folder**. This is what \`auto\` uses when the Google fields are empty.
- **Google Drive API.** Pick the **Google OAuth client ID**, **client secret** and **refresh token** secrets the Google Workspace plugin uses (its token carries Drive access). \`auto\` uses this when all three are set.

Either way, missing folders are created and nothing is overwritten or deleted.

## 4. Configure the plugin (this page, **Configuration** tab)

- **Allowed companies**: tick the company whose agents may call the tool. Empty = nobody can.
- Pick each secret from step 1 in the six carrier fields.
- **Code mailbox address**: the email address the codes go to. **Code mailbox app password**: the secret from step 2.
- **Save to** / **Local folder**, or the three **Google** fields, per step 3.
- Click **Save**.

## 5. Try it

Ask an agent to call \`insurance_fetch_documents\` with \`carrier: "liberty_mutual"\` and \`destination: "Insurance/Liberty Mutual"\`. A run takes one to four minutes, most of it waiting for the code email.

---

## Requirements

- **Google Chrome** installed on the Paperclip computer (the usual place is fine; set **Chrome path** otherwise).
- The computer must be awake during a run.

## Troubleshooting

- **\`[ELOGIN_REJECTED]\`**: the portal did not accept the user name or password. The plugin submits the password **once** per run and never retries, so it will not lock you out. Fix the secret and run again.
- **\`[ECODE_TIMEOUT]\`**: no code email arrived from that carrier within about two minutes. Check the mailbox address, that codes go to that mailbox, and that the carrier's email isn't filtered out of the Inbox (set **Code mailbox folder** if it lands elsewhere).
- **\`[ECAPTCHA]\`**: the portal showed a robot check. The plugin does not solve these. Sign in once by hand, then try later.
- **Signed in but no documents found**: the portal's layout differs from what the plugin expects. Turn on **Debug screenshots**, run again, and share the folder it names in the plugin log with whoever maintains the plugin. The screenshots stay on this computer and can show policy details, so delete them when done.
- **\`[ECOMPANY_NOT_ALLOWED]\`**: tick the calling company in **Allowed companies**.
`;

const secret = (title: string, description: string) => ({
  type: "string",
  format: "secret-ref",
  title,
  description,
});

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Insurance Portals",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Read-only: signs in to Foremost, Liberty Mutual and Selective and saves the current policy and declarations-page PDFs to Google Drive (through Drive for desktop or the Drive API). Login codes are read from email; agents never see credentials.",
  author: "Bryon Stout",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "activity.log.write",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: [
      "allowedCompanies",
      "foremostUsername",
      "foremostPassword",
      "libertyMutualUsername",
      "libertyMutualPassword",
      "selectiveUsername",
      "selectivePassword",
      "codeMailboxAddress",
      "codeMailboxPassword",
      "codeMailboxHost",
      "codeMailboxFolder",
      "googleClientId",
      "googleClientSecret",
      "googleRefreshToken",
      "saveTo",
      "localFolder",
      "chromePath",
      "showBrowser",
      "debugScreenshots",
      "maxDocuments",
    ],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description:
          "Companies whose agents may call insurance_fetch_documents. The secrets below must belong to the calling company. Empty = no company can use this plugin.",
        items: { type: "string", format: "company-id" },
      },
      foremostUsername: secret("Foremost user name", "Secret holding the Foremost sign-in user name or email."),
      foremostPassword: secret("Foremost password", "Secret holding the Foremost password."),
      libertyMutualUsername: secret("Liberty Mutual user name", "Secret holding the Liberty Mutual sign-in user name or email."),
      libertyMutualPassword: secret("Liberty Mutual password", "Secret holding the Liberty Mutual password."),
      selectiveUsername: secret("Selective user ID", "Secret holding the Selective (MySelective) user ID."),
      selectivePassword: secret("Selective password", "Secret holding the Selective password."),
      codeMailboxAddress: {
        type: "string",
        title: "Code mailbox address",
        description: "The email address the carriers send login codes to (e.g. a Gmail address).",
      },
      codeMailboxPassword: secret(
        "Code mailbox app password",
        "Secret holding the mailbox app password (Gmail: myaccount.google.com/apppasswords). Used read-only.",
      ),
      codeMailboxHost: {
        type: "string",
        title: "Code mailbox IMAP host",
        default: "imap.gmail.com",
        description: "IMAP server for the code mailbox. Gmail is imap.gmail.com.",
      },
      codeMailboxFolder: {
        type: "string",
        title: "Code mailbox folder",
        default: "INBOX",
        description: "Folder to look in for code emails. Leave as INBOX unless a filter moves them.",
      },
      googleClientId: secret("Google OAuth client ID", "Same secret the Google Workspace plugin uses."),
      googleClientSecret: secret("Google OAuth client secret", "Same secret the Google Workspace plugin uses."),
      googleRefreshToken: secret(
        "Google refresh token (Drive access)",
        "A refresh token that includes Drive access, e.g. the one the Google Workspace plugin uses for this Google account.",
      ),
      saveTo: {
        type: "string",
        enum: ["auto", "local", "google-drive"],
        default: "auto",
        title: "Save to",
        description:
          "'auto' = Google Drive API when all three Google fields are set, otherwise the local folder. 'local' = always the local folder. 'google-drive' = always the Drive API.",
      },
      localFolder: {
        type: "string",
        title: "Local folder (optional)",
        description:
          "Folder on this computer that the destination path is created under. Leave blank to use the Google Drive for desktop 'My Drive' folder (found automatically when exactly one Google account is signed in), so files sync to Drive. '~' means your home folder.",
      },
      chromePath: {
        type: "string",
        title: "Chrome path (optional)",
        description: "Leave blank to use Google Chrome from its usual place.",
      },
      showBrowser: {
        type: "boolean",
        title: "Show the browser window",
        default: false,
        description: "Off = Chrome runs invisibly. Turn on to watch a run on this computer.",
      },
      debugScreenshots: {
        type: "boolean",
        title: "Debug screenshots",
        default: false,
        description:
          "Save a screenshot of each step to a temporary folder on this computer (named in the plugin log). Can show policy details; never sent anywhere. Leave off normally.",
      },
      maxDocuments: {
        type: "integer",
        title: "Most documents per run",
        default: 20,
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["allowedCompanies"],
  },
  tools: [
    {
      name: "insurance_fetch_documents",
      displayName: "Fetch insurance policy documents",
      description:
        "Sign in to an insurance carrier's customer portal (read-only), download the current policy and declarations-page PDFs, and save them to a Google Drive folder. Never pays, changes or submits anything. Takes 1 to 4 minutes. Returns the saved file names and Drive links.",
      executionTimeoutMs: 300_000,
      writes: true,
      parametersSchema: {
        type: "object",
        required: ["carrier", "destination"],
        additionalProperties: false,
        properties: {
          carrier: {
            type: "string",
            enum: ["foremost", "liberty_mutual", "selective"],
            description: "Which carrier portal to fetch from.",
          },
          destination: {
            type: "string",
            description:
              "Google Drive folder path under My Drive, e.g. 'Insurance/Liberty Mutual/2026'. Missing folders are created. Files already there are never overwritten.",
          },
        },
      },
    },
  ],
};

export default manifest;
