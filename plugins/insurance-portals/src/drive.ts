/**
 * Save files into a Google Drive folder path with the Drive REST API.
 *
 * Uses the same kind of OAuth client + refresh token the Google Workspace
 * plugin stores, so an operator can point this plugin at those secrets.
 * Missing folders along the path are created. Existing files are never
 * overwritten or deleted: an identical file (same MD5) is skipped, a
 * different one with the same name is saved alongside with a numbered name.
 */
import { createHash } from "node:crypto";
import { safeFileName, splitDrivePath } from "./safety.js";

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface SavedFile {
  name: string;
  id: string;
  link: string | null;
  status: "saved" | "already_saved";
}

const FOLDER = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";

function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export class Drive {
  private constructor(private token: string) {}

  static async connect(creds: DriveCredentials): Promise<Drive> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(
        `[EDRIVE_AUTH] Google refused the Drive sign-in (${json.error ?? res.status}). Check the Google client and refresh token secrets in the plugin settings.`,
      );
    }
    return new Drive(json.access_token);
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`[EDRIVE_API] Drive returned ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async list(query: string, fields: string): Promise<Array<Record<string, string>>> {
    const url = `${API}/files?${new URLSearchParams({
      q: query,
      fields: `files(${fields})`,
      pageSize: "100",
      spaces: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    })}`;
    const r = await this.api<{ files?: Array<Record<string, string>> }>(url);
    return r.files ?? [];
  }

  /** Resolve (creating as needed) the folder at `path` under My Drive. */
  async ensureFolder(path: string): Promise<string> {
    let parent = "root";
    for (const name of splitDrivePath(path)) {
      const found = await this.list(
        `name = '${q(name)}' and '${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`,
        "id,name",
      );
      if (found.length > 0) {
        parent = found[0].id;
        continue;
      }
      const created = await this.api<{ id: string }>(`${API}/files?fields=id&supportsAllDrives=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      parent = created.id;
    }
    return parent;
  }

  async savePdf(folderId: string, wantedName: string, bytes: Buffer): Promise<SavedFile> {
    const md5 = createHash("md5").update(bytes).digest("hex");
    const base = safeFileName(wantedName.replace(/\.pdf$/i, "")) || "document";
    const siblings = await this.list(
      `'${folderId}' in parents and trashed = false and name contains '${q(base)}'`,
      "id,name,md5Checksum,webViewLink",
    );
    const same = siblings.find((f) => f.md5Checksum === md5);
    if (same) return { name: same.name, id: same.id, link: same.webViewLink ?? null, status: "already_saved" };

    const taken = new Set(siblings.map((f) => f.name));
    let name = `${base}.pdf`;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n}).pdf`;

    const boundary = `pc${Date.now().toString(36)}`;
    const meta = JSON.stringify({ name, parents: [folderId], mimeType: "application/pdf" });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const up = await this.api<{ id: string; name: string; webViewLink?: string }>(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
      { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body },
    );
    return { name: up.name, id: up.id, link: up.webViewLink ?? null, status: "saved" };
  }
}
