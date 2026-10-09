import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "./localFolder.js";

export interface ProfileSettings {
  rememberSignIn?: boolean;
  profilesFolder?: string;
}

/**
 * Where a carrier's kept Chrome profile lives, or null when profiles are
 * off. Defaults to ~/.paperclip/insurance-portals/profiles/<carrier>. A
 * cloud-synced folder is refused: the profile holds live session cookies.
 */
export function profileDirFor(cfg: ProfileSettings, carrier: string, home = homedir()): string | null {
  if (cfg.rememberSignIn === false) return null;
  const root = cfg.profilesFolder?.trim()
    ? resolve(expandHome(cfg.profilesFolder.trim()))
    : join(home, ".paperclip", "insurance-portals", "profiles");
  if (/\/Library\/CloudStorage\/|google ?drive|dropbox|onedrive|icloud|Mobile Documents/i.test(root)) {
    throw new Error(
      "[EPROFILE_FOLDER] The browser profiles folder must not be inside a cloud-synced folder (Google Drive, Dropbox, iCloud, OneDrive): it holds live sign-in cookies.",
    );
  }
  return join(root, carrier);
}

