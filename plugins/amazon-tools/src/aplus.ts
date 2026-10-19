import fields from "./aplus-fields.json" with { type: "json" };
import { object, type Projector } from "./safety.js";

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
