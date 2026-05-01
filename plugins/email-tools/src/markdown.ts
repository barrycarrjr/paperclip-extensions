import TurndownService from "turndown";

const service = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
  linkStyle: "inlined",
});

service.addRule("strikethrough", {
  filter: ["del", "s"],
  replacement: (content) => `~~${content}~~`,
});

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  try {
    return service.turndown(html).trim();
  } catch {
    return "";
  }
}
