import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Config } from "./routing.js";
import { ns } from "./interactive-support.js";
import { resolveRemoteAccess } from "./remote-access.js";

function guid(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) || /^(?:0|-)+$/.test(value) || /^(?:f|-)+$/i.test(value)) return null;
  return value.toLowerCase();
}
export function inventoryIdentity(target: string, snapshot: Record<string, unknown>) {
  const machineGuid = guid(snapshot.machineGuid); const hardwareUuid = guid(snapshot.hardwareUuid);
  const strength = machineGuid && hardwareUuid ? "windows_hardware" : "target_only";
  const key = createHash("sha256").update(JSON.stringify(strength === "windows_hardware" ? [machineGuid, hardwareUuid] : [target.toLowerCase()])).digest("hex");
  return { key, strength };
}
/** Called only with a successful secret-authenticated inventory diagnostic, never discovery metadata. */
export async function rememberAsset(ctx: PluginContext, cfg: Config, companyId: string, target: string, caseId: string, snapshot: Record<string, unknown>) {
  resolveRemoteAccess(cfg, companyId, target);
  const identity = inventoryIdentity(target, snapshot);
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_assets(company_id,identity_key,identity_strength,snapshot)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(company_id,identity_key) DO UPDATE SET
    identity_conflict=support_assets.identity_conflict OR (coalesce(lower(support_assets.snapshot->>'computer'),'') <> coalesce(lower(EXCLUDED.snapshot->>'computer'),'')),
    snapshot=EXCLUDED.snapshot,last_seen_at=now()`, [companyId, identity.key, identity.strength, JSON.stringify(snapshot)]);
  const [asset] = await ctx.db.query<{ id: string; identity_conflict: boolean }>(`SELECT id,identity_conflict FROM ${ns(ctx)}.support_assets WHERE company_id=$1 AND identity_key=$2`, [companyId, identity.key]);
  if (!asset) throw new Error("Inventory identity was not saved");
  const aliases = new Map<string, string>([[target.toLowerCase(), "authenticated_target"]]);
  if (typeof snapshot.computer === "string" && typeof snapshot.domain === "string") {
    const name = `${snapshot.computer}.${snapshot.domain}`.toLowerCase();
    if (/^[a-z0-9][a-z0-9.-]{0,252}$/.test(name)) aliases.set(name, "reported_name");
  }
  if (Array.isArray(snapshot.ipv4Addresses)) for (const ip of snapshot.ipv4Addresses.slice(0, 20)) {
    if (typeof ip === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) aliases.set(ip, "reported_address");
  }
  // Authenticated target evidence takes precedence over an address/name reported by the same host.
  aliases.set(target.toLowerCase(), "authenticated_target");
  for (const [address, source] of aliases) await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_asset_aliases(company_id,address,asset_id,source)
    VALUES($1,$2,$3,$4) ON CONFLICT(company_id,address) DO UPDATE SET asset_id=EXCLUDED.asset_id,source=EXCLUDED.source,last_seen_at=now()`, [companyId, address, asset.id, source]);
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_devices(company_id,target_address,snapshot,last_case_id,asset_id)
    VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(company_id,target_address)
    DO UPDATE SET snapshot=EXCLUDED.snapshot,last_case_id=EXCLUDED.last_case_id,asset_id=EXCLUDED.asset_id,last_seen_at=now()`, [companyId, target, JSON.stringify(snapshot), caseId, asset.id]);
  return { assetId: asset.id, identityStrength: identity.strength, identityConflict: asset.identity_conflict };
}
export async function listAssets(ctx: PluginContext, cfg: Config, companyId: string) {
  const rows = await ctx.db.query<{ id: string; identity_strength: string; identity_conflict: boolean; snapshot: unknown; last_seen_at: string; aliases: { address: string; source: string; observedAt: string }[] }>(
    `SELECT a.id,a.identity_strength,a.identity_conflict,a.snapshot,a.last_seen_at,
      jsonb_agg(jsonb_build_object('address',v.address,'source',v.source,'observedAt',v.last_seen_at) ORDER BY v.last_seen_at DESC) AS aliases
     FROM ${ns(ctx)}.support_assets a JOIN ${ns(ctx)}.support_asset_aliases v ON v.company_id=a.company_id AND v.asset_id=a.id
     WHERE a.company_id=$1 GROUP BY a.id ORDER BY a.last_seen_at DESC LIMIT 100`, [companyId]);
  return rows.filter(row => row.aliases.some(alias => { try { resolveRemoteAccess(cfg, companyId, alias.address); return true; } catch { return false; } }));
}
