/**
 * Who a message actually goes to.
 *
 * The customer record is an identity, found by matching either email or
 * phone; the event carries the details the payment itself came in with. When
 * a second order arrives from the same phone under a different email, both
 * exist and they disagree - and the board has always displayed the event's
 * version. These tests pin the send path to that same answer, because the
 * failure they exist to prevent is a payment reminder, with one customer's
 * amount and pay link, arriving in another customer's inbox.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { caseContacts, contactFor, type Customer } from "../src/lib/types";

const record: Customer = {
  id: "cus_1",
  merchant_id: "m_1",
  name: "Asha",
  email: "first@example.com",
  phone: "+919000000001",
  opted_out: false,
  opted_out_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
};

const event = (metadata: Record<string, unknown>) => ({ metadata });

describe("the contact details a case came in with", () => {
  test("reads the three fields stamped at ingest", () => {
    assert.deepEqual(
      caseContacts(event({
        customer_name: "Naik",
        customer_email: "second@example.com",
        customer_phone: "+919000000002",
      })),
      { name: "Naik", email: "second@example.com", phone: "+919000000002" },
    );
  });

  test("a blank is an absence, not an address", () => {
    assert.deepEqual(
      caseContacts(event({ customer_name: "  ", customer_email: "", customer_phone: null })),
      { name: null, email: null, phone: null },
    );
  });

  test("surrounding whitespace never reaches a To: header", () => {
    assert.equal(caseContacts(event({ customer_email: " a@b.com " })).email, "a@b.com");
  });

  test("an event with no metadata at all is not a crash", () => {
    assert.deepEqual(caseContacts({ metadata: {} }), {
      name: null, email: null, phone: null,
    });
  });
});

describe("resolving who to contact", () => {
  test("the case's own address wins over the record's", () => {
    const to = contactFor({ email: "second@example.com" }, record);
    assert.equal(to?.email, "second@example.com");
  });

  test("the case's own name wins too, so the greeting matches the recipient", () => {
    const to = contactFor({ name: "Naik", email: "second@example.com" }, record);
    assert.equal(to?.name, "Naik");
  });

  test("a field the case does not carry falls back to the record", () => {
    const to = contactFor({ email: "second@example.com" }, record);
    assert.equal(to?.phone, record.phone);
  });

  test("a case carrying nothing is the record, untouched", () => {
    assert.equal(contactFor({}, record), record);
    assert.equal(contactFor({ name: null, email: "", phone: undefined }, record), record);
  });

  test("identity is never overlaid - an opt-out cannot be routed around", () => {
    const optedOut = { ...record, opted_out: true };
    const to = contactFor({ email: "second@example.com" }, optedOut);
    assert.equal(to?.opted_out, true);
    assert.equal(to?.id, optedOut.id);
    assert.equal(to?.merchant_id, optedOut.merchant_id);
  });

  test("no record means no recipient, whatever the case claims", () => {
    assert.equal(contactFor({ email: "second@example.com" }, null), null);
  });

  test("the record is not mutated - a sibling case must not inherit this one", () => {
    contactFor({ name: "Naik", email: "second@example.com" }, record);
    assert.equal(record.name, "Asha");
    assert.equal(record.email, "first@example.com");
  });

  test("the real case: two orders, one phone, two addresses", () => {
    const babu = contactFor(caseContacts(event({
      customer_name: "Babu", customer_email: "babu@example.com",
    })), record);
    const naik = contactFor(caseContacts(event({
      customer_name: "Naik", customer_email: "naik@example.com",
    })), record);

    assert.equal(babu?.email, "babu@example.com");
    assert.equal(naik?.email, "naik@example.com");
    // Same person, one thread, one opt-out - but two different inboxes.
    assert.equal(babu?.id, naik?.id);
  });
});
