import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PipelineError } from "./lifecycle.js";

export interface CompanySkillRow {
  id: string;
  company_id: string;
  key: string;
  markdown: string;
  updated_at: string | Date;
}

export function normalizedSkillContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export async function readCompanySkill(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  companySkillId: string,
  skillKey: string,
): Promise<CompanySkillRow> {
  const rows = await ctx.db.query<CompanySkillRow>(
    "SELECT id, company_id, key, markdown, updated_at FROM public.company_skills WHERE id = $1 AND company_id = $2",
    [companySkillId, companyId],
  );
  const skill = rows[0];
  if (!skill) throw new PipelineError("not_found", "Company skill was not found in this company");
  if (skill.key !== skillKey) throw new PipelineError("conflict", "Company skill key does not match the saved skill");
  return skill;
}

export async function verifyCompanySkill(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  companySkillId: string,
  skillKey: string,
  skillContent: string,
): Promise<void> {
  const skill = await readCompanySkill(ctx, companyId, companySkillId, skillKey);
  if (normalizedSkillContent(skill.markdown) !== normalizedSkillContent(skillContent)) {
    throw new PipelineError("conflict", "Skill content does not match the current company skill. Save the skill first, then retry with its complete content.");
  }
}
