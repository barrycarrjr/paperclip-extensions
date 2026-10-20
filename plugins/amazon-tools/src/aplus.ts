import { createHash } from "node:crypto";
import fields from "./aplus-fields.json" with { type: "json" };
import { fail, jsonText, object, type Projector } from "./safety.js";

// Property/reference edges from Amazon's A+ 2020-11-01 model, checked
// 2026-10-18. Only follow declared schema edges and return declared text fields:
// TextComponent.value, PlainTextItem.value and StandardComparisonProductBlock.title.
// New module fields require an explicit map update; unknown objects never leak.
const maps = fields as Record<string, Record<string, string | string[]>>;
export function extractModule(value: unknown, projector: Projector, visited = { nodes: 0 }) {
  const texts: string[] = [];
  function collect(v: unknown, type: string, depth = 0) {
    if (++visited.nodes > 2000 || depth > 24 || texts.length >= 50) { projector.truncated = true; return; }
    const o = object(v);
    if (type === "TextComponent" || type === "PlainTextItem") {
      if (typeof o.value === "string") { const text = projector.pick(o.value,true); if (text !== undefined) texts.push(text); }
      return;
    }
    if (type === "StandardComparisonProductBlock" && typeof o.title === "string") {
      const title = projector.pick(o.title,true); if (title !== undefined) texts.push(title);
    }
    for (const [key,target] of Object.entries(maps[type] ?? {})) {
      if (!Object.hasOwn(o,key)) continue;
      if (Array.isArray(target)) {
        const list = o[key];
        if (Array.isArray(list)) {
          if (list.length>100) projector.truncated = true;
          for (const child of list.slice(0,100)) collect(child,target[0],depth+1);
        }
      } else collect(o[key],target,depth+1);
    }
  }
  collect(value,"ContentModule");
  return { moduleType: projector.pick(object(value).contentModuleType,true), texts };
}
export const documentFields = { name:true, contentType:true, contentSubType:true, locale:true } as const;
// Whole document with one shared budget. The tool itself projects and pages
// module by module; this form is kept for direct inspection and tests.
export function extractAplus(value: unknown, projector: Projector) {
  const doc = object(value);
  const modules = Array.isArray(doc.contentModuleList) ? doc.contentModuleList : [];
  if (modules.length>100) projector.truncated=true;
  const visited = { nodes: 0 };
  return { ...projector.pick(doc,documentFields), modules: modules.slice(0,100).map((m: unknown)=>extractModule(m,projector,visited)) };
}

// Internal watch evidence only. These additional image edges come from the
// same official model as the text map. Public tools still return text only.
const imageEdges: Record<string, Record<string, string>> = {
  PremiumImageTextModule: {"image":"ImageComponent"},
  PremiumFullBackgroundTextModule: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  PremiumFullBackgroundImageModule: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  PremiumHotspotImageModule: {"desktopImage":"ImageComponent"},
  PremiumHotspotImageTextModule: {"desktopImage":"ImageComponent"},
  BrandStoryImageWithLogoModule: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  BrandStoryMediaAssetModule: {"image":"ImageComponent"},
  BrandStoryAboutModule: {"logoImage":"ImageComponent"},
  ImageColumn: {"image":"ImageComponent"},
  ImageCarouselPanel: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  NavigationCarouselPanel: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  RegimenCarouselPanel: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  VideoImageCarouselPanel: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  ThreeColumnComparisonProduct: {"image":"ImageComponent"},
  ComparisonProduct: {"desktopImage":"ImageComponent","mobileImage":"ImageComponent"},
  ImageTextHotSpot: {"mobileImage":"ImageComponent"},
  ImageHotSpot: {"mobileImage":"ImageComponent"},
  AsinImage: {"productImage":"ImageComponent"},
  StandardCompanyLogoModule: {"companyLogo":"ImageComponent"},
  StandardSingleImageHighlightsModule: {"image":"ImageComponent"},
  StandardSingleImageSpecsDetailModule: {"image":"ImageComponent"},
  StandardComparisonProductBlock: {"image":"ImageComponent"},
  StandardImageCaptionBlock: {"image":"ImageComponent"},
  StandardImageTextBlock: {"image":"ImageComponent"},
  ImageComponent: {imageCropSpecification:"ImageCropSpecification"},
  ImageCropSpecification: {size:"ImageDimensions",offset:"ImageOffsets"},
  ImageDimensions: {width:"IntegerWithUnits",height:"IntegerWithUnits"},
  ImageOffsets: {x:"IntegerWithUnits",y:"IntegerWithUnits"},
};
const selectedScalars: Record<string, readonly string[]> = {
  ContentModule:["contentModuleType"], TextComponent:["value"],
  PlainTextItem:["value"], StandardComparisonProductBlock:["title"],
  ImageComponent:["uploadDestinationId","altText"], IntegerWithUnits:["value","units"],
};
// Hash complete selected evidence before display cuts. Never walk arbitrary
// fields, URLs or raw blobs. Reflected credentials and exceeded bounds abort
// the check, preserving its earlier snapshot instead of storing a partial hash.
export function watchModuleFingerprint(value: unknown, scrub: (value: unknown) => unknown): string {
  let nodes=0,bytes=0;
  function selected(v:unknown,type:string,depth=0):unknown {
    if(++nodes>2000||depth>24)fail("EINCOMPLETE");
    const o=object(v),out:Record<string,unknown>={};
    for(const key of selectedScalars[type]??[]) {
      if(!Object.hasOwn(o,key))continue;
      const raw=o[key];
      if(typeof raw==="string") {
        bytes+=Buffer.byteLength(raw);
        if(bytes>256*1024||scrub(raw)!==raw||jsonText(raw)!==raw)fail("EINCOMPLETE");
        out[key]=raw;
      } else if(typeof raw==="number"&&Number.isFinite(raw)||typeof raw==="boolean"||raw===null)out[key]=raw;
      else fail("ERESPONSE");
    }
    for(const [key,target] of Object.entries({...maps[type],...imageEdges[type]})) {
      if(!Object.hasOwn(o,key))continue;
      if(Array.isArray(target)) {
        if(!Array.isArray(o[key])||o[key].length>100)fail("EINCOMPLETE");
        out[key]=o[key].map((child:unknown)=>selected(child,target[0],depth+1));
      } else out[key]=selected(o[key],target,depth+1);
    }
    return out;
  }
  return createHash("sha256").update(JSON.stringify(selected(value,"ContentModule"))).digest("hex");
}
