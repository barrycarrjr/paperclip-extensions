export function validJobRoot(root: string) {
  return /^[a-z]:\\[^<>:"|?*\[\]\x00-\x1f]+$/i.test(root) && !root.endsWith("\\") && root.slice(3).split("\\").every(part => part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function validJobTemplate(template: string) {
  return template.length <= 100 && ["date","customer","sequence"].every(token => template.split(`{${token}}`).length === 2) && /^[._ -]*$/.test(template.replace(/\{(date|customer|sequence)\}/g,""));
}
export function validJobComponent(name: string) {
  return /^[a-z0-9][a-z0-9 ._-]{0,99}$/i.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && !name.includes("..");
}
