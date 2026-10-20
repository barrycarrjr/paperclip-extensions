import { definePlugin, operationFailure, runWorker, type PluginContext, type ToolRunContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { AmazonService, accounts } from "./amazon.js";
import { TIMEOUT_MARGIN_MS, TOOLS } from "./manifest.js";
import { AmazonError, fail, object, text } from "./safety.js";
import { ListingWatch } from "./watch.js";
import { compatibleParams } from "./compatibility.js";

type FailureCode = Parameters<typeof operationFailure>[0];
// Host failure codes tell an agent whether retrying can help (PLUGIN_SPEC 11.6).
const FAILURES: Record<string, FailureCode> = {
  EINPUT: "invalid_input", ECOMPAT: "invalid_input", ECURSOR: "invalid_input", EPAGE_EXPIRED: "invalid_input",
  ECOMPANY: "not_authorized", ECONFIG: "not_authorized", EREPORT: "not_authorized",
  ECREDENTIALS: "needs_reconnect", EAUTH: "needs_reconnect",
  ENETWORK: "unavailable", ERATE: "unavailable", EAUDIT: "unavailable", EHOST: "unavailable", EDEADLINE: "timeout",
};
export function failureCode(err: unknown): FailureCode {
  if (!(err instanceof AmazonError)) return "failed";
  if (err.code === "EHTTP") return err.status === 400 || err.status === 422 ? "invalid_input" : err.status === 404 ? "not_found" : (err.status ?? 0) >= 500 ? "unavailable" : "failed";
  return FAILURES[err.code] ?? "failed";
}
export function validateParams(raw: unknown, declaration: typeof TOOLS[number]): Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  const params = object(raw), schema = object(declaration.parametersSchema), props = object(schema.properties);
  if (Object.keys(params).some(k=>!Object.hasOwn(props,k)) || (schema.required ?? []).some((k:string)=> params[k] === undefined)) fail();
  for (const [key,value] of Object.entries(params)) {
    const s = object(props[key]);
    if (s.type === "string") text(value,s.maxLength ?? 256);
    if (s.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < s.minimum || value > s.maximum)) fail();
    if (s.enum && !s.enum.includes(value)) fail();
  }
  return params;
}
// Host calls that must not hold a finished result past the host timeout.
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AmazonError("EAUDIT")), Math.max(1, ms)); timer.unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
export function createPlugin(deps: ConstructorParameters<typeof AmazonService>[1] = {}) {
  let service: AmazonService | undefined;
  let watch: ListingWatch | undefined;
  const now = deps.now ?? Date.now;
  return definePlugin({
    async setup(ctx: PluginContext) {
      service = new AmazonService(ctx,deps);
      watch = new ListingWatch(ctx,service,now);
      ctx.jobs.register("listing_watch_status",async()=>watch!.scheduled("status"));
      ctx.jobs.register("listing_watch_content",async()=>watch!.scheduled("content"));
      for (const declaration of TOOLS) {
        const operation = declaration.name.replace(/^amazon_/, "");
        ctx.tools.register(declaration.name,declaration,async (params: unknown,run: ToolRunContext): Promise<ToolResult> => {
          const startedAt = now();
          const finishBy = startedAt + (declaration.executionTimeoutMs ?? 30_000) - TIMEOUT_MARGIN_MS;
          let started = false;
          try {
            // Log fixed metadata only, never arguments, account labels, provider
            // errors, report URLs, identifiers or resolved secrets.
            await bounded(ctx.activity.log({ companyId:run.companyId, message:`Amazon ${operation} started`, metadata:{ operation, outcome:"started" } }), finishBy - now());
            started = true;
            const p = validateParams(compatibleParams(operation,params),declaration);
            const data = operation === "list_listing_changes" ? await watch!.listChanges(p,run.companyId,finishBy) : await service!.run(operation,p,run.companyId,startedAt);
            const arrays = [...["reports","transactions","balances","inventory","orders","rows","records","destinations","salesAndTrafficByDate","salesAndTrafficByAsin"].map(k => data[k]), object(data.content).modules];
            const count = arrays.reduce((total: number,v)=>total+(Array.isArray(v) ? v.length : 0),0);
            // The work is done, so a slow or failed outcome log never turns a
            // completed read or report request into a reported failure.
            try { await bounded(ctx.activity.log({ companyId:run.companyId, message:`Amazon ${operation} completed`, metadata:{ operation, outcome:"succeeded", count, truncated:data.truncated === true } }), Math.min(5_000, finishBy + TIMEOUT_MARGIN_MS / 2 - now())); }
            catch { ctx.logger.warn("Amazon activity log unavailable."); }
            return { content: declaration.writes ? "Amazon report requested." : "Amazon read completed.", data };
          } catch (err) {
            const code = !started ? "EAUDIT" : err instanceof AmazonError ? err.code : "EINTERNAL";
            if (started) {
              try { await bounded(ctx.activity.log({ companyId:run.companyId, message:`Amazon ${operation} failed`, metadata:{ operation,outcome:"failed",code } }), Math.min(5_000, finishBy + TIMEOUT_MARGIN_MS / 2 - now())); }
              catch { ctx.logger.warn("Amazon activity log unavailable."); }
            }
            const known = err instanceof AmazonError && started ? err : !started ? new AmazonError("EAUDIT") : undefined;
            const message = known ? known.message : `[${code}] Amazon request could not complete. Check host health and retry later. List reports before repeating a report request.`;
            // A write the host protects from repeats (PLUGIN_SPEC 11.7) keeps its
            // claim only when the report POST may have taken effect. No report
            // was created here, so the failure is raised instead of returned: the host then
            // releases the claim and an identical retry can run.
            if (declaration.writes && !(err instanceof AmazonError && err.dispatch)) throw new Error(message);
            return operationFailure(failureCode(known ?? err), message, known?.retryAfterSeconds ? { retryAfterMs: known.retryAfterSeconds * 1000 } : undefined);
          }
        });
      }
    },
    async onConfigChanged() { service?.clear(); watch?.clear(); },
    async onShutdown() { service?.clear(); watch?.clear(); },
    async onHealth() { return { status:"ok",message:"Amazon worker ready. Use amazon_test_connection in an allowed company to test credentials." }; },
    async onValidateConfig(config) {
      try { const rows=accounts(config); return { ok:true,warnings:rows.length ? ["Local validation only. Run amazon_test_connection from an allowed company to verify Amazon authorization."] : ["No seller connections configured."] }; }
      catch { return { ok:false,errors:["Invalid Amazon configuration. Use unique keys, explicit company IDs (no wildcards), and either credentialsRef or all three legacy references plus sellerId. Never mix credential modes."] }; }
    },
  });
}
const plugin = createPlugin();
export default plugin;
runWorker(plugin,import.meta.url);
