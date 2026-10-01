import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError } from "./routing.js";
export async function pinSourceAccount(ctx: PluginContext,companyId: string,caseId: string,accountId: string) {
  const ns = ctx.db.namespace;
  if (!/^plugin_[a-z0-9_]+$/.test(ns)) throw new Error("Invalid support namespace");
  const pinned = await ctx.db.execute(`UPDATE ${ns}.support_cases SET source_account_id=$3 WHERE company_id=$1 AND id=$2 AND (source_account_id IS NULL OR source_account_id=$3)`,[companyId,caseId,accountId]);
  if (pinned.rowCount !== 1) throw new IntakeError(409,"The case belongs to another source account. Restore its original connection instead of moving its thread.");
}
