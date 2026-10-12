import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

export const CONTACTS_TABLE = "plugin_email_tools_7cbee3fdf3.email_contacts";

export interface EmailContact {
  id: string;
  companyId: string;
  email: string;
  name: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportContactItem {
  email: string;
  name?: string | null;
  notes?: string | null;
}

export interface ImportContactsResult {
  total: number;
  imported: number;
  failed: number;
  errors: Array<{ email?: string; error: string }>;
}

interface RawContactRow {
  id: string;
  company_id: string;
  email: string;
  name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const norm = normalizeEmail(email);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm);
}

function mapRow(r: RawContactRow): EmailContact {
  return {
    id: r.id,
    companyId: r.company_id,
    email: r.email,
    name: r.name,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listContacts(
  db: PluginDatabaseClient,
  companyId: string,
  options?: { query?: string; limit?: number },
): Promise<EmailContact[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
  const q = options?.query?.trim();

  if (q) {
    const pattern = `%${q}%`;
    const rows = await db.query<RawContactRow>(
      `SELECT id, company_id, email, name, notes, created_at, updated_at
       FROM ${CONTACTS_TABLE}
       WHERE company_id = $1 AND (email ILIKE $2 OR name ILIKE $2)
       ORDER BY name ASC NULLS LAST, email ASC
       LIMIT $3`,
      [companyId, pattern, limit],
    );
    return rows.map(mapRow);
  }

  const rows = await db.query<RawContactRow>(
    `SELECT id, company_id, email, name, notes, created_at, updated_at
     FROM ${CONTACTS_TABLE}
     WHERE company_id = $1
     ORDER BY name ASC NULLS LAST, email ASC
     LIMIT $2`,
    [companyId, limit],
  );
  return rows.map(mapRow);
}

export async function searchContactsAcrossCompanies(
  db: PluginDatabaseClient,
  companyIds: string[],
  optionsOrQuery?: { query?: string; limit?: number } | string,
  maybeLimit?: number,
): Promise<EmailContact[]> {
  if (companyIds.length === 0) return [];
  const q = typeof optionsOrQuery === "string" ? optionsOrQuery.trim() : optionsOrQuery?.query?.trim();
  const rawLimit = typeof optionsOrQuery === "string" ? maybeLimit : optionsOrQuery?.limit;
  const limit = Math.max(1, Math.min(rawLimit ?? 50, 500));

  const inPlaceholders = companyIds.map((_, i) => `$${i + 1}`).join(", ");
  const params: unknown[] = [...companyIds];

  if (q) {
    const queryIdx = params.length + 1;
    const limitIdx = params.length + 2;
    params.push(`%${q}%`, limit);
    const rows = await db.query<RawContactRow>(
      `SELECT id, company_id, email, name, notes, created_at, updated_at
       FROM ${CONTACTS_TABLE}
       WHERE company_id IN (${inPlaceholders}) AND (email ILIKE $${queryIdx} OR name ILIKE $${queryIdx})
       ORDER BY name ASC NULLS LAST, email ASC
       LIMIT $${limitIdx}`,
      params,
    );
    return rows.map(mapRow);
  }

  const limitIdx = params.length + 1;
  params.push(limit);
  const rows = await db.query<RawContactRow>(
    `SELECT id, company_id, email, name, notes, created_at, updated_at
     FROM ${CONTACTS_TABLE}
     WHERE company_id IN (${inPlaceholders})
     ORDER BY name ASC NULLS LAST, email ASC
     LIMIT $${limitIdx}`,
    params,
  );
  return rows.map(mapRow);
}

export async function upsertContact(
  db: PluginDatabaseClient,
  companyIdOrInput: string | { companyId: string; email: string; name?: string | null; notes?: string | null },
  maybeInput?: { email: string; name?: string | null; notes?: string | null },
): Promise<EmailContact> {
  const companyId = typeof companyIdOrInput === "string" ? companyIdOrInput : companyIdOrInput.companyId;
  const rawInput = typeof companyIdOrInput === "string" ? maybeInput! : companyIdOrInput;

  const normEmail = normalizeEmail(rawInput.email);
  if (!isValidEmail(normEmail)) {
    throw new Error(`Invalid email address: "${rawInput.email}"`);
  }
  const name = rawInput.name?.trim() || null;
  const notes = rawInput.notes?.trim() || null;

  await db.execute(
    `INSERT INTO ${CONTACTS_TABLE}
       (company_id, email, name, notes, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, email)
     DO UPDATE SET
       name = EXCLUDED.name,
       notes = EXCLUDED.notes,
       updated_at = now()`,
    [companyId, normEmail, name, notes],
  );

  const rows = await db.query<RawContactRow>(
    `SELECT id, company_id, email, name, notes, created_at, updated_at
     FROM ${CONTACTS_TABLE}
     WHERE company_id = $1 AND email = $2`,
    [companyId, normEmail],
  );
  if (!rows[0]) throw new Error("Failed to retrieve upserted contact");
  return mapRow(rows[0]);
}

export async function deleteContact(
  db: PluginDatabaseClient,
  companyIdOrInput: string | { companyId: string; id: string },
  maybeId?: string,
): Promise<boolean> {
  const companyId = typeof companyIdOrInput === "string" ? companyIdOrInput : companyIdOrInput.companyId;
  const id = typeof companyIdOrInput === "string" ? maybeId! : companyIdOrInput.id;

  const result = await db.execute(
    `DELETE FROM ${CONTACTS_TABLE}
     WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return result.rowCount > 0;
}

export async function importContacts(
  db: PluginDatabaseClient,
  companyId: string,
  contacts: ImportContactItem[],
): Promise<ImportContactsResult> {
  const result: ImportContactsResult = {
    total: contacts.length,
    imported: 0,
    failed: 0,
    errors: [],
  };

  for (const item of contacts) {
    if (!item || typeof item.email !== "string") {
      result.failed++;
      result.errors.push({ email: undefined, error: "Missing email address" });
      continue;
    }
    const norm = normalizeEmail(item.email);
    if (!isValidEmail(norm)) {
      result.failed++;
      result.errors.push({ email: item.email, error: `Invalid email address: "${item.email}"` });
      continue;
    }

    try {
      await upsertContact(db, companyId, {
        email: norm,
        name: item.name,
        notes: item.notes,
      });
      result.imported++;
    } catch (err: any) {
      result.failed++;
      result.errors.push({ email: item.email, error: err?.message || "Failed to save contact" });
    }
  }

  return result;
}
