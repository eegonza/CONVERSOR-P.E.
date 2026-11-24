import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi } from "./api.mjs";
import { buildReview, defaultColumns, previewHash, validateExtraction } from "./review.mjs";

function document() {
  return {
    page_count: 1,
    issues: [],
    documents: [{
      number: "000458",
      pages: [1],
      header: { company: "EMPRESA DE PRUEBA" },
      rows: [
        { id: "p1-r1", page: 1, line: 1, code: "00123456", description: "Artículo de prueba",
          reference: "0090", units: "2.00", cost: "0.10", sale_price: "1.00", outbound_total: "0.20", tax_class: "G", tax_rate: "7.00" },
        { id: "p1-r2", page: 1, line: 2, code: "00987654", description: "Artículo exento",
          reference: "0012", units: "4.00", cost: "0.30", sale_price: "1.00", outbound_total: "1.20", tax_class: "E" },
      ],
      printed_totals: { outbound: { subtotal: "1.40", tax: "0.01", net: "1.41" } },
      issues: [],
    }],
  };
}

const selection = () => ({ number: "000458", columns: [...defaultColumns], edits: {}, exclude_ids: [] });

test("preserves source codes, column order, zeroes, and original tax through review", () => {
  const extraction = validateExtraction(document());
  const review = buildReview(extraction, selection());
  assert.equal(review.number, "000458");
  assert.equal(review.rows[0].code, "00123456");
  assert.equal(review.rows[0].reference, "0090");
  assert.equal(review.columns.indexOf("cost") - review.columns.indexOf("units"), 1);
  assert.equal(review.summary.units, "6.00");
  assert.equal(review.summary.subtotal, "1.40");
  assert.equal(review.summary.taxable_subtotal, "0.20");
  assert.equal(review.summary.exempt_subtotal, "1.20");
  assert.equal(review.summary.tax, "0.01");
  assert.deepEqual(review.issues, []);
});

test("edits preserve blanks and text and affect only the selected rows", () => {
  const extraction = validateExtraction(document());
  const review = buildReview(extraction, {
    ...selection(),
    columns: ["description", "code", "units", "cost", "outbound_total"],
    exclude_ids: ["p1-r2"],
    edits: { "p1-r1": { description: "=1+1", cost: ".0", outbound_total: null } },
  });
  assert.equal(review.rows[0].description, "=1+1");
  assert.equal(review.rows[0].cost, "0.0");
  assert.equal(review.rows[0].outbound_total, null);
  assert.equal(review.summary.export_rows, 1);
  assert.equal(review.summary.tax, null);
  assert.equal(review.summary.taxable_subtotal, null);
  assert.equal(review.summary.known_taxable_subtotal, "0.00");
  assert.ok(review.issues.some((entry) => entry.code === "missing_values"));
  assert.equal(extraction.documents[0].rows[0].cost, "0.10");
});

test("rejects unknown rows, columns, unsupported decimals and fake page positions", async () => {
  const extraction = validateExtraction(document());
  assert.throws(() => buildReview(extraction, { ...selection(), exclude_ids: ["p1-r5"] }), /ajenos/);
  assert.throws(() => buildReview(extraction, { ...selection(), columns: ["code", "code"] }), /repetir/);
  assert.throws(() => buildReview(extraction, { ...selection(), edits: { "p1-r1": { page: "3" } } }), /no admite/);
  assert.throws(() => buildReview(extraction, { ...selection(), edits: { "p1-r1": { cost: "1,234" } } }), /ambigua/);
  const invalid = document();
  invalid.documents[0].rows[0].id = "p1-r8";
  assert.throws(() => validateExtraction(invalid), /origen/);
  const approved = buildReview(extraction, selection());
  const other = buildReview(extraction, { ...selection(), columns: ["description"] });
  assert.notEqual(await previewHash(approved), await previewHash(other));
});

test("keeps discrepancies exact and flags unknown tax on subsets", () => {
  const source = document();
  source.documents[0].rows[0].outbound_total = "0.19";
  const preview = buildReview(validateExtraction(source), selection());
  assert.equal(preview.summary.subtotal, "1.39");
  assert.equal(preview.summary.tax, null);
  assert.ok(preview.issues.some((entry) => entry.code === "line_total_difference" && entry.message.includes("-0.01")));
  assert.ok(preview.issues.some((entry) => entry.code === "printed_subtotal_difference" && entry.message.includes("+0.01")));
});

test("requires an Auth-verified active profile and sends privileged writes with the session actor", async () => {
  const actor = "4bbb5288-f3ec-4b4c-af00-67ec9bfa6601";
  const id = "4bbb5288-f3ec-4b4c-af00-67ec9bfa6655";
  const origin = "https://example.github.io";
  const token = "header.payload.signature";
  const key = "sb_secret_server_test";
  const writes = [];
  const record = { id, extraction: validateExtraction(document()) };
  const api = createApi({
    origin, url: "https://api.example.test", publicKey: "sb_publishable_server_test", secretKey: key,
    async fetcher(url, opts) {
      if (url.pathname === "/auth/v1/user") {
        assert.equal(opts.headers.Authorization, "Bearer " + token);
        return Response.json({ id: actor });
      }
      if (url.pathname === "/rest/v1/profiles") {
        assert.equal(opts.headers.Authorization, "Bearer " + token);
        return Response.json([{ id: actor, active: true, role: "operator" }]);
      }
      if (url.pathname === "/rest/v1/conversions") {
        assert.equal(opts.headers.Authorization, "Bearer " + token);
        assert.equal(url.searchParams.get("id"), "eq." + id);
        return Response.json([record]);
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        assert.equal(opts.headers.apikey, key);
        assert.equal(opts.headers.Authorization, undefined);
        const body = JSON.parse(opts.body);
        assert.equal(body.p_actor, actor);
        writes.push([url.pathname.split("/").at(-1), body]);
        return Response.json({});
      }
      assert.fail("Unexpected upstream path");
    },
  });

  const req = (body, extra = {}) => api(new Request(origin, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: "Bearer " + token, ...extra },
    body: JSON.stringify(body),
  }));
  assert.equal((await req({ action: "session" }, { Authorization: "" })).status, 401);
  assert.equal((await req({ action: "session" }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await req({ action: "users" })).status, 403);
  const data = { ...selection(), conversion_id: id, actor: "ignored" };
  const review = await req({ ...data, action: "preview" });
  assert.equal(review.status, 200);
  const { preview_hash } = await review.json();
  assert.equal((await req({ ...data, action: "export", confirmed_number: "458", preview_hash })).status, 422);
  assert.equal((await req({ ...data, action: "export", confirmed_number: "000458", preview_hash: "stale" })).status, 409);
  const exportResult = await req({ ...data, action: "export", confirmed_number: "000458", preview_hash });
  assert.equal(exportResult.status, 200);
  assert.equal(writes.length, 2);
  assert.equal(writes[1][1].p_filename, "SALIDA 000458.xlsx");
  assert.deepEqual(writes[0][1].p_preview, writes[1][1].p_preview);
});
