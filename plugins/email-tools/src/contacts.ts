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
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
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
  options?: { query?: string; limit?: number },
): Promise<EmailContact[]> {
  if (companyIds.length === 0) return [];
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
  const q = options?.query?.trim();

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
  input: {
    companyId: string;
    email: string;
    name?: string | null;
    notes?: string | null;
  },
): Promise<EmailContact> {
  const normEmail = normalizeEmail(input.email);
  if (!isValidEmail(normEmail)) {
    throw new Error(`Invalid email address: "${input.email}"`);
  }
  const name = input.name?.trim() || null;
  const notes = input.notes?.trim() || null;

  await db.execute(
    `INSERT INTO ${CONTACTS_TABLE}
       (company_id, email, name, notes, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, email)
     DO UPDATE SET
       name = EXCLUDED.name,
       notes = EXCLUDED.notes,
       updated_at = now()`,
    [input.companyId, normEmail, name, notes],
  );

  const rows = await db.query<RawContactRow>(
    `SELECT id, company_id, email, name, notes, created_at, updated_at
     FROM ${CONTACTS_TABLE}
     WHERE company_id = $1 AND email = $2`,
    [input.companyId, normEmail],
  );
  if (!rows[0]) throw new Error("Failed to retrieve upserted contact");
  return mapRow(rows[0]);
}

export async function deleteContact(
  db: PluginDatabaseClient,
  input: {
    companyId: string;
    id: string;
  },
): Promise<boolean> {
  const result = await db.execute(
    `DELETE FROM ${CONTACTS_TABLE}
     WHERE id = $1 AND company_id = $2`,
    [input.id, input.companyId],
  );
  return result.rowCount > 0;
}
