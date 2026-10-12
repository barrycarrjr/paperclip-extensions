import test from "node:test";
import assert from "node:assert/strict";
import { openPluginDb } from "./pglite-db.js";
import {
  listContacts,
  searchContactsAcrossCompanies,
  upsertContact,
  deleteContact,
  normalizeEmail,
  isValidEmail,
} from "./contacts.js";

test("email validation and normalization", () => {
  assert.equal(normalizeEmail("  TEST@Example.COM  "), "test@example.com");
  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("user+tag@domain.co.uk"), true);
  assert.equal(isValidEmail("invalid-email"), false);
  assert.equal(isValidEmail("@domain.com"), false);
  assert.equal(isValidEmail("user@"), false);
});

test("contacts CRUD with database", async () => {
  const { db } = await openPluginDb();
  const companyA = "00000000-0000-0000-0000-000000000001";
  const companyB = "00000000-0000-0000-0000-000000000002";

  // Initially empty
  const initial = await listContacts(db, companyA);
  assert.equal(initial.length, 0);

  // Upsert contact in company A
  const c1 = await upsertContact(db, {
    companyId: companyA,
    email: "Alice@Example.com",
    name: "Alice Smith",
    notes: "CEO",
  });
  assert.equal(c1.email, "alice@example.com");
  assert.equal(c1.name, "Alice Smith");
  assert.equal(c1.notes, "CEO");

  // Upsert second contact in company A
  const c2 = await upsertContact(db, {
    companyId: companyA,
    email: "bob@example.com",
    name: "Bob Jones",
  });
  assert.equal(c2.email, "bob@example.com");
  assert.equal(c2.name, "Bob Jones");

  // Upsert contact in company B
  const c3 = await upsertContact(db, {
    companyId: companyB,
    email: "carol@example.com",
    name: "Carol White",
  });
  assert.equal(c3.email, "carol@example.com");

  // List company A
  const listA = await listContacts(db, companyA);
  assert.equal(listA.length, 2);
  assert.equal(listA[0].email, "alice@example.com");
  assert.equal(listA[1].email, "bob@example.com");

  // Search by query in company A
  const searchName = await listContacts(db, companyA, { query: "jones" });
  assert.equal(searchName.length, 1);
  assert.equal(searchName[0].email, "bob@example.com");

  const searchEmail = await listContacts(db, companyA, { query: "alice@" });
  assert.equal(searchEmail.length, 1);
  assert.equal(searchEmail[0].name, "Alice Smith");

  // Search across companies
  const across = await searchContactsAcrossCompanies(db, [companyA, companyB], { query: "example" });
  assert.equal(across.length, 3);

  // Update existing contact via upsert
  const updated = await upsertContact(db, {
    companyId: companyA,
    email: "alice@example.com",
    name: "Alice Johnson",
    notes: "Updated role",
  });
  assert.equal(updated.name, "Alice Johnson");
  assert.equal(updated.notes, "Updated role");

  const afterUpdate = await listContacts(db, companyA);
  assert.equal(afterUpdate.length, 2);
  assert.equal(afterUpdate.find((c) => c.email === "alice@example.com")?.name, "Alice Johnson");

  // Delete contact
  const deleted = await deleteContact(db, { companyId: companyA, id: c2.id });
  assert.equal(deleted, true);

  const finalList = await listContacts(db, companyA);
  assert.equal(finalList.length, 1);
  assert.equal(finalList[0].email, "alice@example.com");
});
