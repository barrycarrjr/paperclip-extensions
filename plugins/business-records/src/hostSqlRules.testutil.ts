/**
 * Test-only copy of the host's plugin SQL rules, so the builders and the
 * migration are checked against what the host will actually accept.
 *
 * Copied from paperclip server/src/services/plugin-database.ts
 * (derivePluginDatabaseNamespace, splitSqlStatements, the validators). If the
 * host tightens its rules, update this copy.
 */
import { createHash } from "node:crypto";

export function derivePluginDatabaseNamespace(pluginKey: string, namespaceSlug?: string): string {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug =
    (namespaceSlug ?? pluginKey)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 36) || "plugin";
  return `plugin_${slug}_${hash}`.slice(0, 63);
}

export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = input.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlForKeywordScan(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""')
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

type SqlRef = { schema: string; table: string; keyword: string };

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const patterns = [
    /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
    /\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
    /\bcreate\s+(?:unique\s+)?(?:concurrently\s+)?index\s+(?:if\s+not\s+exists\s+)?[A-Za-z_][A-Za-z0-9_]*\s+(on)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of statement.matchAll(pattern)) {
      refs.push({ keyword: match[1]!.toLowerCase(), schema: match[2]!, table: match[3]! });
    }
  }
  return refs;
}

function assertNoBannedSql(statement: string): void {
  const normalized = normaliseSql(statement);
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) throw new Error(`disallowed clause: ${matched.source}`);
}

export function validateMigrationStatement(statement: string, namespace: string, coreReadTables: string[] = []): void {
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (/^\s*(drop|truncate)\b/.test(normalized)) throw new Error("destructive migration");
  if (!/^(create|alter|comment)\b/.test(normalized)) throw new Error("migrations may contain DDL statements only");
  const refs = extractQualifiedRefs(statement);
  if (refs.length === 0 && !normalized.startsWith("comment ")) {
    throw new Error("migration objects must use fully qualified schema names");
  }
  for (const ref of refs) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public" && coreReadTables.includes(ref.table) && ["from", "join", "references"].includes(ref.keyword)) continue;
    throw new Error(`references schema ${ref.schema} outside namespace`);
  }
}

export function validateRuntimeQuery(query: string, namespace: string, coreReadTables: string[] = []): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) throw new Error("must contain exactly one statement");
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) throw new Error("query only allows SELECT");
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("query cannot contain mutation or DDL keywords");
  }
  for (const ref of extractQualifiedRefs(statement)) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public" && coreReadTables.includes(ref.table)) continue;
    throw new Error(`query cannot read schema ${ref.schema}`);
  }
}

export function validateRuntimeExecute(query: string, namespace: string): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) throw new Error("must contain exactly one statement");
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) throw new Error("execute only allows INSERT, UPDATE, DELETE");
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) throw new Error("execute cannot contain DDL keywords");
  const refs = extractQualifiedRefs(statement);
  const target = refs.find((ref) => ["into", "update", "from"].includes(ref.keyword));
  if (!target || target.schema !== namespace) throw new Error("execute target must be inside the plugin namespace");
  for (const ref of refs) {
    if (ref.schema !== namespace) throw new Error("execute cannot reference other schemas");
  }
}

/** The host binds $n placeholders and requires every parameter to be referenced. */
export function assertPlaceholdersMatch(text: string, params: unknown[]): void {
  const seen = new Set<number>();
  for (const m of text.matchAll(/\$(\d+)/g)) {
    const index = Number(m[1]);
    if (index < 1 || index > params.length) throw new Error(`placeholder $${index} has no parameter`);
    seen.add(index);
  }
  if (seen.size !== params.length) throw new Error("every parameter must be referenced by a placeholder");
}
