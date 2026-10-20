// Commit complete marketplace snapshots and their changes in one statement.
// Never infer the owner of historical rows, or remove unseen partial pages.
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AmazonService, accounts } from "./amazon.js";
import { AmazonError, date, fail, integer, object, text } from "./safety.js";
import { CursorStore, CURSOR_TTL, PAGE_BYTES, PAGE_NODES, projectWith, take } from "./paging.js";
import { contentSnapshot, diffSnapshots, fingerprint, statusSnapshot, submittedContent, trimCatalogItem, trimItemOffers, trimListing, type Snapshot } from "./listings.js";

export type WatchKind = "status" | "content";
export const WATCH_BUDGET_MS = 240_000, MAX_LISTINGS = 2000;
const MAX_PAGES = 100, MAX_STATE_BYTES = 4 * 1024 * 1024;
type Stored = {sku:string;asin:string|null;data:Snapshot};
type Change = {sku:string;asin:string|null;field:string;before:unknown;after:unknown};
type Auth = Awaited<ReturnType<AmazonService["authorize"]>>;
const digest = (v:unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const optionalFailure = (e:unknown) => e instanceof AmazonError && (["EAUTH","ENETWORK","ERESPONSE"].includes(e.code) || e.code === "ERATE" && e.coverageCause === "provider" || e.code === "EHTTP" && (e.status === 404 || (e.status ?? 0) >= 500));
type Evidence = {required:number;read:number;providerFailures:number;budgetFailures:number;notAttemptedBudget:number;unavailableListings:number};
type Coverage = {listings:number;asins:number;offers:Evidence;catalog:Evidence;aplus:Evidence;submitted:Evidence;sources:{missingSummary:number;missingAsin:number;missingIssues:number;missingSubmittedAttributes:number;missingCatalogAttributes:number;missingCatalogSummary:number}};
const evidence = ():Evidence => ({required:0,read:0,providerFailures:0,budgetFailures:0,notAttemptedBudget:0,unavailableListings:0});
const coverage = ():Coverage => ({listings:0,asins:0,offers:evidence(),catalog:evidence(),aplus:evidence(),submitted:evidence(),sources:{missingSummary:0,missingAsin:0,missingIssues:0,missingSubmittedAttributes:0,missingCatalogAttributes:0,missingCatalogSummary:0}});
const hasObject = (value:unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
const incompleteCoverage = (c:Coverage) => Object.values(c.sources).some(n=>n>0) || [c.offers,c.catalog,c.aplus,c.submitted].some(e=>e.read<e.required);
// Keep structured health in the existing bounded note column, without changing
// a historical migration. Plain notes from earlier builds remain readable.
function runHealth(note:unknown,ok:boolean) {
  if(typeof note === "string" && note.length <= 4096)try {
    const r=JSON.parse(note);
    if(r.v===1 && typeof r.complete==="boolean" && typeof r.enumerationComplete==="boolean" && typeof r.degraded==="boolean" && hasObject(r.coverage)) {
      const c=r.coverage;
      const numbers=[c.listings,c.asins,...[c.offers,c.catalog,c.aplus,c.submitted].flatMap(e=>e?[e.required,e.read,e.providerFailures,e.budgetFailures,e.notAttemptedBudget,e.unavailableListings]:[undefined]),...Object.values(c.sources??{})];
      if(numbers.length===32 && numbers.every(n=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<=MAX_LISTINGS))return {complete:r.complete,enumerationComplete:r.enumerationComplete,degraded:r.degraded,coverage:c,error:typeof r.error==="string"&&/^E[A-Z_]+$/.test(r.error)?r.error:undefined};
    }
  }catch{/* Earlier plain notes have no structured coverage evidence. */}
  return {complete:ok?null:false,enumerationComplete:null,degraded:null,coverage:null};
}

function preserve(data:Snapshot,prior:Snapshot|undefined,field:string) {
  if(prior&&Object.hasOwn(prior,field))data[field]=prior[field];else delete data[field];
}

export class ListingWatch {
  private cursors = new CursorStore();
  private nextTarget:Record<WatchKind,number>={status:0,content:0};
  constructor(private ctx:PluginContext, private service:AmazonService, private now:()=>number = Date.now) {}
  clear() { this.cursors.clear(); }
  private bounded<T>(start:()=>Promise<T>, deadline:number):Promise<T> {
    const left = deadline-this.now();
    if (left <= 0) return Promise.reject(new AmazonError("EDEADLINE"));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new AmazonError("EDEADLINE")),left);timer.unref?.();
      start().then(v=>{clearTimeout(timer);if(this.now()<deadline)resolve(v);else reject(new AmazonError("EDEADLINE"));},e=>{clearTimeout(timer);reject(e);});
    });
  }
  private async read(auth:Auth,operation:string,p:Record<string,unknown>,company:string,deadline:number) {
    const result = await this.service.read(operation,{...p,account:auth.account.key},company,deadline,auth);
    if (result.truncated) fail("EINCOMPLETE");
    return result as Record<string,any>;
  }
  private async all(auth:Auth,operation:string,p:Record<string,unknown>,field:string,company:string,deadline:number,max:number) {
    const values:any[]=[];let cursor:unknown,bytes=2;
    for(let page=0;page<MAX_PAGES;page++) {
      const result=await this.read(auth,operation,{...p,...(cursor?{cursor}:{})},company,deadline);
      if(!Array.isArray(result[field])) fail("ERESPONSE");
      for(const row of result[field]){bytes+=Buffer.byteLength(JSON.stringify(row))+1;if(values.length>=max||bytes>MAX_STATE_BYTES)fail("EINCOMPLETE");values.push(row);}
      cursor=result.nextCursor;if(!cursor)return values;
    }
    return fail("EINCOMPLETE");
  }
  private async aplus(auth:Auth,asin:string,marketplaceId:string,company:string,deadline:number,memo:<T>(key:string,load:()=>Promise<T>)=>Promise<T>) {
    const records=await this.all(auth,"list_aplus_publish_records",{asin,marketplaceId},"records",company,deadline,10);
    const keys=[...new Set(records.map(r=>text(r.contentReferenceKey,128)))].sort();const docs=[];
    for(const contentReferenceKey of keys) {
      docs.push(await memo(`document:${contentReferenceKey}`,async()=>{
      const modules:unknown[]=[];let moduleOffset:unknown;
      for(let page=0;page<10;page++) {
        const doc=await this.read(auth,"get_aplus_content",{contentReferenceKey,marketplaceId,...(moduleOffset===undefined?{}:{moduleOffset})},company,deadline);
        modules.push(...doc.content.modules);if(modules.length>100)fail("EINCOMPLETE");moduleOffset=doc.nextModuleOffset;
        if(moduleOffset===null) {
          const meta=object(object(doc.metadata).contentMetadata);
          return {contentReferenceKey,name:meta.name??object(doc.content).name,status:meta.status,fingerprint:fingerprint(modules)};
        }
        if(page===9)fail("EINCOMPLETE");
      }
      return fail("EINCOMPLETE");
      }));
    }
    return docs;
  }
  async check(company:string,key:string,kind:WatchKind,marketplaceId:string,deadline=this.now()+WATCH_BUDGET_MS) {
    const started=new Date(this.now()).toISOString();
    const auth=await this.service.authorize(company,key,deadline,true);
    if(!auth.account.listingWatch || !auth.account.marketplaceIds.includes(marketplaceId))fail("ECOMPANY");
    const db=this.ctx.db, base=[auth.scope,company,marketplaceId,kind];
    const observedCoverage=coverage();let enumerationComplete=false;
    const cache=new Map<string,unknown>(),asinListings=new Map<string,number>();
    const runNote=(complete:boolean,error?:string)=>JSON.stringify({v:1,complete,enumerationComplete,degraded:!complete,coverage:observedCoverage,...(error?{error}:{})});
    try {
      await this.bounded(()=>this.ctx.activity.log({companyId:company,message:`Amazon listing watch ${kind} started`,metadata:{operation:`listing_watch_${kind}`,outcome:"started"}}),deadline);
      await this.bounded(()=>db.execute(`INSERT INTO ${db.namespace}.watch_state_v2 (scope_id, company_id, marketplace_id, kind, account_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope_id, marketplace_id, kind) DO NOTHING`,[...base,key]),deadline);
      const states=await this.bounded(()=>db.query<{revision:number;complete:boolean;snapshots:Stored[]}>(`SELECT revision, complete, snapshots FROM ${db.namespace}.watch_state_v2 WHERE scope_id=$1 AND company_id=$2 AND marketplace_id=$3 AND kind=$4`,base),deadline);
      const state=states[0];if(!state || !Array.isArray(state.snapshots) || Buffer.byteLength(JSON.stringify(state.snapshots))>MAX_STATE_BYTES)fail("ERESPONSE");
      const previous=new Map(state.snapshots.map(s=>[s.sku,s]));
      const listings=await this.all(auth,"list_listings",{marketplaceId,limit:20},"listings",company,deadline,MAX_LISTINGS);
      const seen=new Set<string>();
      const entries=listings.map(listing=>{
        const sku=text(listing.sku,100);if(seen.has(sku))fail("EINCOMPLETE");seen.add(sku);
        const summary=Array.isArray(listing.summaries)?listing.summaries.find((s:any)=>s.marketplaceId===marketplaceId):undefined;
        const asin=summary?.asin===undefined?null:text(summary.asin,10,/^[A-Z0-9]{10}$/);
        if(!summary)observedCoverage.sources.missingSummary++;
        if(!asin)observedCoverage.sources.missingAsin++;else asinListings.set(asin,(asinListings.get(asin)??0)+1);
        return {listing,sku,summary,asin};
      });
      enumerationComplete=true;observedCoverage.listings=entries.length;observedCoverage.asins=asinListings.size;
      if(kind==="status")observedCoverage.offers.required=asinListings.size;
      else {observedCoverage.catalog.required=asinListings.size;observedCoverage.aplus.required=asinListings.size;observedCoverage.submitted.required=entries.length;}
      // These maps belong to this scope, marketplace and check only. Bound
      // their aggregate bytes and recheck ownership before every cached use.
      let cacheBytes=0;
      const memo=async<T>(key:string,load:()=>Promise<T>):Promise<T>=>{
        if(cache.has(key)){await auth.ensureCurrent(deadline);return cache.get(key) as T;}
        const value=await load();cacheBytes+=Buffer.byteLength(JSON.stringify(value)??"null");
        if(cacheBytes>MAX_STATE_BYTES||cache.size>=MAX_LISTINGS*13)fail("EINCOMPLETE");
        cache.set(key,value);return value;
      };
      const readEvidence=async<T>(name:"offers"|"catalog"|"aplus",asin:string,load:()=>Promise<T>,optional:boolean):Promise<T|undefined>=>memo(`${name}:${asin}`,async()=>{
        const counts=observedCoverage[name];
        try {const value=await load();counts.read++;return value;}
        catch(e){
          if(e instanceof AmazonError&&e.code==="EDEADLINE"&&e.coverageAttempted)counts.budgetFailures++;
          if(optionalFailure(e)){counts.providerFailures++;counts.unavailableListings+=asinListings.get(asin)??0;if(optional)return undefined;}
          throw e;
        }
      });
      let snapshotBytes=2,changeBytes=2;
      const current:Stored[]=[],changes:Change[]=[];
      for(const {listing,sku,summary,asin} of entries) {
        const prior=previous.get(sku);let data:Snapshot;
        if(kind==="status") {
          const offers=asin?await readEvidence("offers",asin,async()=>trimItemOffers((await this.read(auth,"get_item_offers",{asin,marketplaceId},company,deadline)).offers),true):undefined;
          data=statusSnapshot(trimListing({...listing,summaries:summary?[summary]:[]},marketplaceId),offers);
          // A matched summary is observed data: omitted image/title/status
          // means empty. No eligible summary means that source is unknown.
          for(const field of ["asin","status","title","mainImage","ourPrice"])if(!summary)preserve(data,prior?.data,field);
          // The list response requested offers explicitly; an absent price is
          // an observed removal. Issue omission is left conservative because
          // no provider claim about that omission has been established.
          if(!Array.isArray(listing.issues)){observedCoverage.sources.missingIssues++;preserve(data,prior?.data,"issues");}
          if(!offers)for(const field of ["buyBoxHolder","buyBoxPrice","offerCount","otherSellers"]) {
            if(prior && Object.hasOwn(prior.data,field))data[field]=prior.data[field];else delete data[field];
          }
        } else {
          let submitted:Record<string,any>;
          try {submitted=object((await this.read(auth,"get_listing",{sku,marketplaceId},company,deadline)).listing);observedCoverage.submitted.read++;}
          catch(e){if(e instanceof AmazonError&&e.code==="EDEADLINE"&&e.coverageAttempted)observedCoverage.submitted.budgetFailures++;else if(optionalFailure(e)){observedCoverage.submitted.providerFailures++;observedCoverage.submitted.unavailableListings++;}throw e;}
          const catalog=asin?await readEvidence("catalog",asin,async()=>object((await this.read(auth,"get_catalog_item",{asin,marketplaceId},company,deadline)).item),false):undefined;
          const live=catalog?object(trimCatalogItem(catalog,marketplaceId)):{};
          const aplus=asin?await readEvidence("aplus",asin,()=>this.aplus(auth,asin,marketplaceId,company,deadline,memo),true):undefined;
          const submittedFields=object(submittedContent(submitted.attributes,marketplaceId));
          const submittedKnown=hasObject(submitted.attributes),liveKnown=hasObject(catalog?.attributes);
          const liveSummary=Array.isArray(catalog?.summaries)&&catalog.summaries.some((s:any)=>s.marketplaceId===marketplaceId);
          if(!submittedKnown)observedCoverage.sources.missingSubmittedAttributes++;
          if(catalog&&!liveKnown)observedCoverage.sources.missingCatalogAttributes++;
          if(catalog&&!liveSummary)observedCoverage.sources.missingCatalogSummary++;
          data=contentSnapshot(submittedFields,live,aplus??[]);
          // Availability belongs to a source, not each optional value. An
          // existing attributes object with absent keys observes null/[] and
          // stores those values, so later additions compare against emptiness.
          const observed:Record<string,boolean>={
            submittedTitle:submittedKnown,submittedBullets:submittedKnown,
            submittedDescription:submittedKnown,searchTerms:submittedKnown,
            liveTitle:liveSummary,liveBullets:liveKnown,liveDescription:liveKnown,
            brand:liveSummary,category:liveSummary,
            productType:!!catalog,images:!!catalog,
            titleOverridden:submittedKnown&&liveSummary,
          };
          for(const [field,known] of Object.entries(observed))if(!known)preserve(data,prior?.data,field);
          if(aplus===undefined){if(prior&&Object.hasOwn(prior.data,"aplus"))data.aplus=prior.data.aplus;else delete data.aplus;}
        }
        // Only a genuinely unobserved or new stored-format field starts a
        // field baseline. Observed null and [] are already known values.
        const delta=prior?diffSnapshots(prior.data,data).filter(c=>Object.hasOwn(prior.data,c.field)):state.complete?[{field:"listing",before:null,after:"added"}]:[];
        for(const c of delta){const change={sku,asin,field:c.field,before:c.before??null,after:c.after??null};changeBytes+=Buffer.byteLength(JSON.stringify(change))+1;if(changeBytes>MAX_STATE_BYTES)fail("EINCOMPLETE");changes.push(change);}
        const stored={sku,asin,data};snapshotBytes+=Buffer.byteLength(JSON.stringify(stored))+1;if(snapshotBytes>MAX_STATE_BYTES)fail("EINCOMPLETE");current.push(stored);
      }
      for(const [sku,prior] of previous)if(!seen.has(sku))changes.push({sku,asin:prior.asin,field:"listing",before:"present",after:"removed"});
      const snapshots=JSON.stringify(auth.scrub(current)),deltas=JSON.stringify(auth.scrub(changes));
      if(Buffer.byteLength(snapshots)>MAX_STATE_BYTES||Buffer.byteLength(deltas)>MAX_STATE_BYTES)fail("EINCOMPLETE");
      const complete=!incompleteCoverage(observedCoverage),degraded=!complete;
      const finished=new Date(this.now()).toISOString();await auth.ensureCurrent();
      const saved=await this.bounded(()=>db.execute(`WITH saved AS (
        UPDATE ${db.namespace}.watch_state_v2 SET revision=revision+1, complete=true, snapshots=$5::jsonb
        WHERE scope_id=$1 AND company_id=$2 AND marketplace_id=$3 AND kind=$4 AND revision=$6 RETURNING scope_id
      ), recorded AS (
        INSERT INTO ${db.namespace}.watch_changes_v2 (scope_id,company_id,marketplace_id,kind,sku,asin,field,before,after,detected_at)
        SELECT $1,$2,$3,$4,c.sku,c.asin,c.field,c.before,c.after,$8::timestamptz FROM saved
        CROSS JOIN jsonb_to_recordset($7::jsonb) AS c(sku text,asin text,field text,before jsonb,after jsonb) RETURNING scope_id
      ) INSERT INTO ${db.namespace}.watch_runs_v2 (scope_id,company_id,marketplace_id,kind,started_at,finished_at,ok,listings,changes,note)
        SELECT $1,$2,$3,$4,$9::timestamptz,$8::timestamptz,$13,$10,$11,$12 FROM saved`,[...base,snapshots,state.revision,deltas,finished,started,current.length,changes.length,runNote(complete),complete]),deadline);
      if(saved.rowCount!==1)fail("ECONCURRENT");await auth.ensureCurrent();
      try { await this.bounded(()=>this.ctx.activity.log({companyId:company,message:`Amazon listing watch ${kind} ${complete?"completed":"coverage incomplete"}`,metadata:{operation:`listing_watch_${kind}`,outcome:complete?"succeeded":"incomplete",count:current.length,changes:changes.length,degraded}}),Math.min(deadline,this.now()+5_000)); }
      catch { this.ctx.logger.warn("Amazon activity log unavailable."); }
      await auth.ensureCurrent();
      return {ok:complete,complete,enumerationComplete,degraded,coverage:observedCoverage,listings:current.length,changes:changes.length};
    } catch(e) {
      if(e instanceof AmazonError&&(e.code==="EDEADLINE"||e.code==="ERATE"&&e.coverageCause==="budget"))for(const name of ["offers","catalog","aplus"] as const){
        const counts=observedCoverage[name];counts.notAttemptedBudget=counts.required-counts.read-counts.providerFailures-counts.budgetFailures;
        if(counts.required)counts.unavailableListings=[...asinListings].reduce((n,[asin,count])=>n+(cache.has(`${name}:${asin}`)&&cache.get(`${name}:${asin}`)!==undefined?0:count),0);
      }
      if(e instanceof AmazonError&&(e.code==="EDEADLINE"||e.code==="ERATE"&&e.coverageCause==="budget")){const c=observedCoverage.submitted;c.notAttemptedBudget=c.required-c.read-c.providerFailures-c.budgetFailures;c.unavailableListings=c.required-c.read;}
      try {
        // A fixed failure receipt uses only the scope authorized at entry.
        // It reads no secret/state and remains safe after revocation or quota failure.
        await this.bounded(()=>db.execute(`INSERT INTO ${db.namespace}.watch_runs_v2 (scope_id,company_id,marketplace_id,kind,started_at,finished_at,ok,listings,changes,note) VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,false,0,0,$7)`,[...base,started,new Date(this.now()).toISOString(),runNote(false,e instanceof AmazonError?e.code:"EHOST")]),Math.max(deadline,this.now()+5_000));
      } catch { /* A lost DB reply can have committed. Do not overwrite state. */ }
      throw e;
    }
  }
  async scheduled(kind:WatchKind) {
    const deadline=this.now()+WATCH_BUDGET_MS;
    const config=await this.bounded(()=>this.ctx.config.get(),deadline);let incomplete=false;
    // A fresh, entirely empty configuration has no enabled monitoring. Keep
    // strict validation for every nonempty or malformed configuration.
    if(hasObject(config)&&Object.keys(config as object).length===0)return;
    const enabled=accounts(config).filter(a=>a.listingWatch===true);
    if(enabled.some(a=>!a.allowedCompanies.length))incomplete=true;
    const targets=enabled.flatMap(account=>account.allowedCompanies.flatMap(company=>account.marketplaceIds.map(marketplace=>({account,company,marketplace}))));
    const first=this.nextTarget[kind]%Math.max(1,targets.length);
    this.nextTarget[kind]=(first+1)%Math.max(1,targets.length);
    for(let offset=0;offset<targets.length;offset++) {
        const index=(first+offset)%targets.length,{account,company,marketplace}=targets[index];
        if(this.now()>=deadline-10_000){this.nextTarget[kind]=index;incomplete=true;break;}
        try {if(!(await this.check(company,account.key,kind,marketplace,deadline)).complete)incomplete=true;}
        catch {incomplete=true;try{await this.bounded(()=>this.ctx.activity.log({companyId:company,message:`Amazon listing watch ${kind} failed`,metadata:{operation:`listing_watch_${kind}`,outcome:"failed"}}),Math.max(deadline,this.now()+5_000));}catch{/* Fixed health receipt only. */}this.ctx.logger.warn("Amazon Listing Watch incomplete; prior completed snapshots retained.");}
    }
    if(incomplete)fail("EINCOMPLETE");
  }
  async listChanges(p:Record<string,any>,company:string,deadline:number) {
    const auth=await this.service.authorize(company,p.account,deadline),db=this.ctx.db;
    const limit=integer(p.limit,25,100);if(!limit)fail();
    if(p.marketplaceId!==undefined&&!auth.account.marketplaceIds.includes(p.marketplaceId))fail();
    for(const k of ["sku","asin","field"])if(p[k]!==undefined)text(p[k],100);
    const binding=digest([auth.fingerprint,Object.fromEntries(Object.entries(p).filter(([k])=>k!=="cursor").sort(([a],[b])=>a.localeCompare(b)))]);
    const resumed=p.cursor?this.cursors.get(text(p.cursor,64),binding,this.now()):undefined;
    const watermark=resumed?.query.until??new Date(this.now()).toISOString();
    const since=date(p.since??resumed?.query.since??new Date(this.now()-7*86400_000).toISOString());
    const params:unknown[]=[auth.scope,company,since,watermark];
    const where=["scope_id=$1","company_id=$2","detected_at >= $3::timestamptz","detected_at <= $4::timestamptz"];
    for(const k of ["marketplaceId","sku","asin","field"])if(p[k]!==undefined){params.push(p[k]);where.push(`${k==="marketplaceId"?"marketplace_id":k}=$${params.length}`);}
    if(resumed){params.push(resumed.query.afterTime,resumed.query.afterId);where.push(`(detected_at,id)>($${params.length-1}::timestamptz,$${params.length}::uuid)`);}
    params.push(limit+1);
    const rows=await this.bounded(()=>db.query<Record<string,any>>(`SELECT id,detected_at,marketplace_id,sku,asin,kind,field,before,after FROM ${db.namespace}.watch_changes_v2 WHERE ${where.join(" AND ")} ORDER BY detected_at,id LIMIT $${params.length}`,params),deadline);
    const selected=rows.slice(0,limit);
    const projectChange=(r:Record<string,any>,nodes=PAGE_NODES)=>projectWith(pr=>({...pr.pick({...r,detected_at:new Date(r.detected_at).toISOString()},{id:true,detected_at:true,marketplace_id:true,sku:true,asin:true,kind:true,field:true}),before:pr.pick(r.before,Array.isArray(r.before)?[true]:true),after:pr.pick(r.after,Array.isArray(r.after)?[true]:true)}),auth.scrub,nodes);
    const recs=selected.map(r=>projectChange(r));
    // Equal millisecond timestamps cannot prove which receipt came last.
    // Prefer the incomplete receipt conservatively, then a stable row ID.
    const runs=await this.bounded(()=>db.query<Record<string,any>>(`SELECT DISTINCT ON (marketplace_id,kind) marketplace_id,kind,started_at,finished_at,ok,listings,changes,note FROM ${db.namespace}.watch_runs_v2 WHERE scope_id=$1 AND company_id=$2 ORDER BY marketplace_id,kind,started_at DESC,finished_at DESC,ok ASC,id DESC LIMIT 20`,[auth.scope,company]),deadline);
    const recentChecks:Record<string,any>[]=runs.map(r=>{const h=runHealth(r.note,r.ok===true);return {...r,note:h.coverage?(h.complete?"Complete.":"Incomplete coverage; inspect coverage and error."):r.note,...h};});
    const health=auth.account.marketplaceIds.flatMap(marketplace_id=>(["status","content"] as const).map(kind=>({marketplace_id,kind,latest:recentChecks.find(r=>r.marketplace_id===marketplace_id&&r.kind===kind)??null})));
    const legacyHistory="Unowned 0.2.0 history retained privately; no ownership inferred.";
    const envelope=auth.scrub({health,recentChecks,through:watermark,legacyHistory});
    const budget={bytes:Math.min(PAGE_BYTES,96*1024-Buffer.byteLength(JSON.stringify(envelope))-1024),nodes:PAGE_NODES};
    if(budget.bytes<1024)fail("ERESPONSE");
    // Health accompanies every page, so reserve its actual bytes. Preserve a
    // whole change row and mark projection cuts instead of skipping that row.
    for(let nodes=PAGE_NODES;recs[0]?.bytes>budget.bytes&&nodes>=16;nodes=Math.floor(nodes/2))recs[0]={...projectChange(selected[0],nodes),truncated:true};
    const page=take(recs,0,limit,budget),last=selected[page.next-1];
    const nextCursor=last&&page.next<rows.length?this.cursors.put({binding,query:{since,until:watermark,afterTime:new Date(last.detected_at).toISOString(),afterId:last.id},index:0,expires:this.now()+CURSOR_TTL,tokenExpires:0},this.now()):null;
    await auth.ensureCurrent();
    const output=auth.scrub({changes:page.values,...envelope,nextCursor,truncated:page.truncated});
    if(Buffer.byteLength(JSON.stringify(output))>96*1024)fail("ERESPONSE");
    return output;
  }
}
