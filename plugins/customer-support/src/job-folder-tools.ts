import type { PaperclipPluginManifestV1,PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError,type Config } from "./routing.js";
import { prepareJobFolder,createJobFolder,searchJobFolders } from "./job-folders.js";
const profileId = { type: "string",description: "Saved company directory file_root record ID" };
const job = { profileId,date: { type: "string",description: "Job date YYYY-MM-DD" },customer: { type: "string",maxLength: 100 },sequence: { type: "integer",minimum: 1,maximum: 99 } };
export const jobFolderTools: NonNullable<PaperclipPluginManifestV1["tools"]> = [
  { name: "support_search_job_folders",displayName: "Find job folders",requiredUserPermission: "support:diagnose",executionTimeoutMs: 210000,
    description: "Search one reviewed company Job folders profile using the file server's saved Windows access. Literal customer/date search; at most 512 immediate folders inspected and 50 returned, with partial limits. Returns folder names, age, template mismatches and missing original-files subfolders; does not read document contents, recurse, follow junctions, move or delete. A directory timestamp does not prove a job is pending/stale; ask staff to confirm. Use support_search_directory kind=file_root to choose a profile.",
    parametersSchema: { type: "object",additionalProperties: false,properties: { profileId,query: { type: "string",maxLength: 100 },date: job.date,staleDays: { type: "integer",minimum: 1,maximum: 3650 } },required: ["profileId"] } },
  { name: "support_prepare_job_folder",displayName: "Preview a new job folder",requiredUserPermission: "support:repair",writes: true,
    description: "Prepare exact company-profile naming and an original-files subfolder, and open this human's file-server case. No folders are created. Requires a saved file_root, date, plain customer name and sequence. Show the returned root, target, folder, subfolder and recovery notes before support_create_job_folder. Never replace preparation with requester-supplied PowerShell.",
    parametersSchema: { type: "object",additionalProperties: false,properties: job,required: Object.keys(job) } },
  { name: "support_create_job_folder",displayName: "Create the reviewed job folder",requiredUserPermission: "support:repair",requiresUserConfirmation: true,writes: true,executionTimeoutMs: 300000,
    description: "Confirm the exact prepared target/root/job/subfolder inline. Uses the existing durable one-shot action engine with verification and audit. Refuses a changed profile/plan, another person's case, redirected paths or an existing job. No overwrite, move, deletion or automatic replay after uncertain execution. Keep files in their saved company root; emergency delegation does not bypass this explicit confirmation.",
    parametersSchema: { type: "object",additionalProperties: false,properties: { ...job,caseId: { type: "string" },expectedReviewVersion: { type: "integer" },profileVersion: { type: "integer" },planHash: { type: "string" },target: { type: "string" },root: { type: "string" },folderName: { type: "string" },originalsFolder: { type: "string" } },required: [...Object.keys(job),"caseId","expectedReviewVersion","profileVersion","planHash","target","root","folderName","originalsFolder"] } },
];
export function registerJobFolderTools(ctx: PluginContext,getConfig: () => Promise<Config>) {
  for (const tool of jobFolderTools) ctx.tools.register(tool.name,tool,async (params,run) => {
    try {
      if (run.userPermission !== tool.requiredUserPermission) throw new IntakeError(403,"Paperclip must verify your job-folder permission");
      const input = params as Record<string,unknown>;
      return { data: tool.name === "support_search_job_folders" ? await searchJobFolders(ctx,await getConfig(),run,input) : tool.name === "support_prepare_job_folder" ? await prepareJobFolder(ctx,await getConfig(),run,input) : await createJobFolder(ctx,getConfig,run,input) };
    } catch (error) { return { error: error instanceof IntakeError ? error.message : "Job-folder operation failed. Inspect saved case history before retrying a creation." }; }
  });
}
