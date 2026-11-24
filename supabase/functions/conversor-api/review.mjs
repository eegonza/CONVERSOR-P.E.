// The server builds the approved selection from stored rows. Use fixed-point
// arithmetic so a cent of difference cannot disappear through binary rounding.
export const columns = {
  code: "Código",
  description: "Descripción",
  package: "Empaque",
  style: "Estilo",
  descriptor: "Descriptor",
  reference: "Ref.",
  tax_class: "Clase I.V.",
  tax_rate: "I.V. (%)",
  units: "Salidas · Unidades",
  cost: "Costo unitario",
  sale_price: "P/Venta",
  outbound_total: "Salidas · Total",
  inbound_units: "Entradas · Unidades",
  inbound_total: "Entradas · Total",
  page: "Página de origen",
  line: "Renglón de origen",
};

export const defaultColumns = [
  "code", "description", "reference", "tax_class", "tax_rate", "units",
  "cost", "sale_price", "outbound_total", "page", "line",
];

const originFields = new Set(["page", "line"]);
const editable = Object.keys(columns).filter((field) => !originFields.has(field));
const amounts = new Set([
  "tax_rate", "units", "cost", "sale_price", "outbound_total", "inbound_units", "inbound_total",
]);
const financial = new Set([...amounts, "tax_class"]);
financial.delete("sale_price");
const footerFields = ["subtotal", "tax", "net"];
const sides = ["outbound", "inbound"];
const scale = 16;
const factor = 10n ** BigInt(scale);

export class ReviewError extends Error {}
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isNumber = (value) => typeof value === "string" && /^[0-9]{1,40}$/.test(value);

function requireValue(condition, message) {
  if (!condition) throw new ReviewError(message);
}

function textValue(value, label, max = 32767) {
  if (value == null) return null;
  requireValue(
    typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\ufffe\uffff]/u.test(value),
    `${label} contiene texto inválido.`,
  );
  requireValue(value === value.toWellFormed(), `${label} contiene texto inválido.`);
  return value;
}

function plainDecimal(value, label) {
  requireValue(
    typeof value === "string" && value.length <= 32 && /^[+-]?\d+(?:\.\d+)?$/.test(value),
    `${label} requiere un decimal válido.`,
  );
  const unsigned = value.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const significant = (whole + fraction).replace(/^0+|0+$/g, "");
  requireValue(fraction.length <= 8 && significant.length <= 15,
    `${label} admite hasta 15 dígitos significativos y ocho decimales.`);
  return value;
}

function editedDecimal(value, label) {
  const input = value.trim();
  requireValue(!/^[+-]?[1-9][0-9]{0,2},[0-9]{3}$/.test(input),
    `${label} tiene una coma ambigua. Usa un punto decimal y escribe los miles sin separador.`);
  let normalized = input;
  if (/^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/.test(input)) normalized = input.replaceAll(",", "");
  else if (/^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/.test(input)) normalized = input.replaceAll(".", "").replace(",", ".");
  else if (/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(input)) normalized = input.replace(",", ".");
  normalized = normalized.replace(/^([+-]?)\./, (_, sign) => sign + "0.");
  plainDecimal(normalized, label);
  const [whole, fraction] = normalized.replace(/^[+-]/, "").split(".");
  const numeric = (whole.replace(/^0+(?=\d)/, "") || "0") + (fraction ? "." + fraction : "");
  return normalized.startsWith("-") && /[1-9]/.test(numeric) ? "-" + numeric : numeric;
}

function unitsOf(value) {
  if (value == null) return null;
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const absolute = BigInt(whole + fraction.padEnd(scale, "0"));
  return value.startsWith("-") ? -absolute : absolute;
}

function amountText(amount) {
  if (amount == null) return null;
  const sign = amount < 0n ? "-" : "";
  const digits = (amount < 0n ? -amount : amount).toString().padStart(scale + 1, "0");
  const fractional = digits.slice(-scale).replace(/0+$/, "").padEnd(2, "0");
  return sign + digits.slice(0, -scale) + "." + fractional;
}

function signedAmount(amount) {
  return (amount >= 0n ? "+" : "") + amountText(amount);
}

function issue(code, severity, message, row) {
  return row ? { code, severity, message, page: row.page, row: row.line } : { code, severity, message };
}

function validateIssues(list, pageCount) {
  requireValue(Array.isArray(list) && list.length <= 20000, "El diagnóstico del PDF no es válido.");
  return list.map((item) => {
    requireValue(isObject(item) && ["error", "warning", "info"].includes(item.severity)
      && typeof item.code === "string" && /^[a-z0-9_]{1,80}$/.test(item.code)
      && typeof item.message === "string" && item.message.trim(), "El diagnóstico del PDF no es válido.");
    const result = { code: item.code, severity: item.severity, message: textValue(item.message, "Diagnóstico", 2000) };
    if (item.page != null) {
      requireValue(Number.isInteger(item.page) && item.page >= 1 && item.page <= pageCount, "La página de diagnóstico no es válida.");
      result.page = item.page;
    }
    if (item.row != null) {
      requireValue(Number.isInteger(item.row) && item.row >= 1 && item.row <= 12000, "El renglón de diagnóstico no es válido.");
      result.row = item.row;
    }
    return result;
  });
}

const headerFields = ["company", "title", "reference", "destination", "date", "printed_date", "note"];

export function validateExtraction(extraction) {
  requireValue(isObject(extraction) && Number.isInteger(extraction.page_count) && extraction.page_count > 0
    && extraction.page_count <= 100, "El PDF debe contener de 1 a 100 páginas.");
  const pageCount = extraction.page_count;
  const pageList = new Set();
  const numbers = new Set();
  let rowsCount = 0;
  requireValue(Array.isArray(extraction.documents) && extraction.documents.length <= pageCount,
    "La extracción no tiene una lista de salidas válida.");
  const documents = extraction.documents.map((doc) => {
    requireValue(isObject(doc) && isNumber(doc.number) && !numbers.has(doc.number),
      "La extracción contiene un número de salida inválido o repetido.");
    numbers.add(doc.number);
    requireValue(Array.isArray(doc.pages) && doc.pages.length > 0 && doc.pages.every((page, i) =>
      Number.isInteger(page) && page >= 1 && page <= pageCount && (i === 0 || page > doc.pages[i - 1])
      && !pageList.has(page)), "La extracción contiene páginas fuera de orden o repetidas.");
    for (const page of doc.pages) pageList.add(page);
    requireValue(isObject(doc.header) && Array.isArray(doc.rows), "La salida contiene datos incompletos.");
    rowsCount += doc.rows.length;
    requireValue(rowsCount <= 12000, "El PDF supera el límite de 12 000 renglones.");
    const header = Object.fromEntries(headerFields.map((field) => [field, textValue(doc.header[field], "Encabezado", 4000)]));
    const nextRow = new Map(doc.pages.map((page) => [page, 1]));
    let previousPage = 0;
    const rows = doc.rows.map((row) => {
      requireValue(isObject(row) && nextRow.has(row.page) && row.page >= previousPage
        && row.line === nextRow.get(row.page) && row.id === `p${row.page}-r${row.line}`,
      "La extracción contiene renglones fuera de orden o con origen inválido.");
      previousPage = row.page;
      nextRow.set(row.page, row.line + 1);
      const values = { id: row.id, page: row.page, line: row.line };
      for (const field of editable) {
        const value = row[field];
        values[field] = value == null ? null : amounts.has(field)
          ? plainDecimal(value, columns[field]) : textValue(value, columns[field], 4000);
      }
      return values;
    });
    const printed_totals = Object.fromEntries(sides.map((side) => [side, Object.fromEntries(footerFields.map((field) => {
      const value = doc.printed_totals?.[side]?.[field];
      return [field, value == null ? null : plainDecimal(value, "El pie del PDF")];
    }))]));
    return { number: doc.number, pages: doc.pages, header, rows, printed_totals, issues: validateIssues(doc.issues, pageCount) };
  });
  const issues = validateIssues(extraction.issues, pageCount);
  for (let page = 1; page <= pageCount; page++) {
    requireValue(pageList.has(page) || issues.some((item) => item.severity === "error" && item.page === page),
      "Falta una página del PDF en la extracción.");
  }
  return { page_count: pageCount, documents, issues };
}

const inbound = (row) => row.inbound_units != null || row.inbound_total != null;
const outbound = (row) => row.units != null || row.outbound_total != null || !inbound(row);
const sum = (entries) => entries.reduce((total, value) => total + (value ?? 0n), 0n);

function correction(field, value) {
  if (value === null) return null;
  requireValue(typeof value === "string", `${columns[field]} requiere texto o un campo vacío.`);
  if (!value.trim()) return null;
  if (amounts.has(field)) {
    const normalized = editedDecimal(value, columns[field]);
    if (field === "tax_rate") {
      const tax = unitsOf(normalized);
      requireValue(tax >= 0n && tax <= 100n * factor, "La tasa I.V. debe estar entre 0 y 100.");
    }
    return normalized;
  }
  if (field === "tax_class") {
    const result = new Map([["G", "G"], ["GRAVADO", "G"], ["E", "E"], ["EXENTO", "E"]]).get(value.trim().toUpperCase());
    requireValue(result, "La clase I.V. debe ser G, E o quedar vacía.");
    return result;
  }
  return textValue(value, columns[field]);
}

function reviewRows(rows, issues) {
  const occurrences = new Map();
  for (const row of rows) {
    if (!row.code) issues.push(issue("missing_code", "error", "Falta el código del producto.", row));
    else {
      if (!occurrences.has(row.code)) occurrences.set(row.code, []);
      occurrences.get(row.code).push(row);
    }
    if (!row.description) issues.push(issue("missing_description", "warning", "Falta la descripción del producto.", row));
    const expected = ["cost", "sale_price"];
    if (outbound(row)) expected.push("units", "outbound_total");
    if (inbound(row)) expected.push("inbound_units", "inbound_total");
    const missing = expected.filter((field) => row[field] == null);
    if (missing.length) issues.push(issue("missing_values", "warning", "Campos vacíos: " + missing.map((field) => columns[field]).join(", ") + ".", row));
    const taxRate = unitsOf(row.tax_rate);
    if (outbound(row) && !["G", "E"].includes(row.tax_class)) {
      issues.push(issue("unknown_tax_class", "warning", "No se pudo clasificar el I.V. de la salida.", row));
    } else if (outbound(row) && row.tax_class === "G" && taxRate == null) {
      issues.push(issue("missing_tax_rate", "warning", "El renglón gravado no indica una tasa I.V.", row));
    } else if (row.tax_class === "E" && taxRate != null && taxRate !== 0n) {
      issues.push(issue("exempt_tax_rate", "warning", "El renglón exento indica una tasa distinta de cero.", row));
    }
    const cost = unitsOf(row.cost);
    for (const [label, quantityField, totalField] of [
      ["Salidas", "units", "outbound_total"], ["Entradas", "inbound_units", "inbound_total"],
    ]) {
      const quantity = unitsOf(row[quantityField]);
      const total = unitsOf(row[totalField]);
      if (cost == null || quantity == null || total == null) continue;
      const expectedTotal = cost * quantity / factor;
      if (total !== expectedTotal) issues.push(issue("line_total_difference", "warning",
        `${label}. ${row[quantityField]} × ${row.cost} = ${amountText(expectedTotal)}. El total es ${row[totalField]} (diferencia ${signedAmount(total - expectedTotal)}).`, row));
    }
  }
  for (const [code, matches] of occurrences) {
    if (matches.length < 2) continue;
    const locations = matches.slice(0, 12).map((row) => `pág. ${row.page}, renglón ${row.line}`).join(", ");
    issues.push(issue("repeated_code", "warning", `El código ${code} figura en ${matches.length} renglones (${locations}${matches.length > 12 ? ", …" : ""}). Se conservaron las apariciones seleccionadas.`, matches[0]));
  }
}

function reviewFooters(doc, issues) {
  for (const [side, label, totalField, movement] of [
    ["outbound", "Salidas", "outbound_total", outbound], ["inbound", "Entradas", "inbound_total", inbound],
  ]) {
    const footer = doc.printed_totals[side];
    const [subtotal, tax, net] = footerFields.map((field) => unitsOf(footer[field]));
    const totals = doc.rows.filter(movement).map((row) => unitsOf(row[totalField]));
    if ((side === "outbound" || totals.length || [subtotal, tax, net].some((value) => value != null))
        && [subtotal, tax, net].includes(null)) {
      issues.push(issue("missing_printed_totals", "warning", `${label}. El pie del PDF tiene importes vacíos.`));
    }
    const known = sum(totals);
    if (subtotal != null && subtotal !== known) issues.push(issue("printed_subtotal_difference", "warning",
      `${label}. Los totales visibles suman ${amountText(known)} y el subtotal impreso es ${footer.subtotal} (diferencia ${signedAmount(subtotal - known)}). Renglones sin total: ${totals.filter((v) => v == null).length}.`));
    if (subtotal != null && tax != null && net != null && subtotal + tax !== net) {
      issues.push(issue("printed_net_difference", "warning",
        `${label}. El subtotal más el impuesto es ${amountText(subtotal + tax)} y el neto impreso es ${footer.net} (diferencia ${signedAmount(net - subtotal - tax)}).`));
    }
  }
}

function summary(doc, selected, changes, issues) {
  const moves = selected.filter(outbound);
  const quantities = moves.map((row) => unitsOf(row.units));
  const subtotals = moves.map((row) => unitsOf(row.outbound_total));
  const classes = Object.fromEntries(["G", "E"].map((key) => [
    key, moves.filter((row) => row.tax_class === key).map((row) => unitsOf(row.outbound_total)),
  ]));
  const known = { G: sum(classes.G), E: sum(classes.E) };
  const allClasses = moves.every((row) => ["G", "E"].includes(row.tax_class));
  const taxable = allClasses && !classes.G.includes(null) ? known.G : null;
  const exempt = allClasses && !classes.E.includes(null) ? known.E : null;
  const units = quantities.includes(null) ? null : sum(quantities);
  const [printedSubtotal, printedTax, printedNet] = footerFields.map((field) => unitsOf(doc.printed_totals.outbound[field]));
  const complete = selected.length > 0 && selected.length === doc.rows.length && units != null && taxable != null
    && exempt != null && taxable + exempt === printedSubtotal
    && changes.every((change) => !financial.has(change.field));
  const tax = complete ? printedTax : null;
  const net = tax != null && printedSubtotal + tax === printedNet ? printedNet : null;
  if (selected.length && (tax == null || net == null)) {
    issues.push(issue("selection_tax_unverified", "info",
      "El impuesto o el neto de la selección quedan sin determinar cuando el pie original no se puede conciliar con la selección íntegra."));
  }
  if (selected.length && (taxable == null || exempt == null)) {
    issues.push(issue("selection_subtotal_incomplete", "info", "Los subtotales por clase requieren importes y clases I.V. completos."));
  }
  const forSelection = (amount) => selected.length ? amountText(amount) : null;
  return {
    page_count: doc.pages.length,
    detected_rows: doc.rows.length,
    export_rows: selected.length,
    excluded_rows: doc.rows.length - selected.length,
    distinct_products: new Set(selected.map((row) => row.code).filter(Boolean)).size,
    units: forSelection(units),
    subtotal: forSelection(subtotals.includes(null) ? null : sum(subtotals)),
    taxable_subtotal: forSelection(taxable),
    exempt_subtotal: forSelection(exempt),
    known_taxable_subtotal: forSelection(known.G),
    known_exempt_subtotal: forSelection(known.E),
    tax: amountText(tax),
    net: amountText(net),
    tax_origin: tax == null ? null : "printed",
    net_origin: net == null ? null : "printed",
  };
}

export function buildReview(extraction, data) {
  const doc = extraction.documents.find((candidate) => candidate.number === data.number);
  requireValue(doc, "Selecciona un número de salida identificado en el PDF.");
  const requested = data.columns;
  requireValue(Array.isArray(requested) && requested.length > 0 && requested.every((field) =>
    typeof field === "string" && Object.hasOwn(columns, field)) && new Set(requested).size === requested.length,
  "Selecciona una o más columnas válidas sin repetirlas.");
  const edits = data.edits ?? {};
  const excludes = data.exclude_ids ?? [];
  requireValue(isObject(edits) && Array.isArray(excludes) && new Set(excludes).size === excludes.length,
    "La revisión debe identificar cada renglón una sola vez.");
  const known = new Set(doc.rows.map((row) => row.id));
  requireValue([...Object.keys(edits), ...excludes].every((id) => known.has(id)), "La revisión contiene renglones ajenos al documento.");
  const ignored = new Set(excludes);
  const changes = [];
  const selected = [];
  for (const original of doc.rows) {
    const row = { ...original };
    const rowEdits = Object.hasOwn(edits, row.id) ? edits[row.id] : {};
    requireValue(isObject(rowEdits), `Las correcciones de ${row.id} deben indicar campo y valor.`);
    for (const field of Object.keys(rowEdits).sort()) {
      requireValue(editable.includes(field), "La revisión contiene un campo que no admite correcciones.");
      let revised;
      try {
        revised = correction(field, rowEdits[field]);
      } catch (error) {
        throw new ReviewError(`Página ${row.page}, renglón ${row.line}. ${error.message}`);
      }
      if (revised !== row[field]) {
        changes.push({ row_id: row.id, field, original: row[field] ?? null, value: revised });
        row[field] = revised;
      }
    }
    if (!ignored.has(row.id)) selected.push(row);
  }
  const issues = [...extraction.issues, ...doc.issues];
  if (!selected.length) issues.push(issue("no_export_rows", "error", "Selecciona al menos un renglón para exportar."));
  reviewRows(selected, issues);
  reviewFooters(doc, issues);
  const totals = summary(doc, selected, changes, issues);
  return {
    number: doc.number,
    columns: requested,
    rows: selected.map((row) => ({ id: row.id, ...Object.fromEntries(requested.map((field) => [field, row[field] ?? null])) })),
    summary: totals,
    issues,
    changes,
    printed_totals: doc.printed_totals,
    excluded_ids: doc.rows.filter((row) => ignored.has(row.id)).map((row) => row.id),
  };
}

export async function previewHash(preview) {
  const bytes = new TextEncoder().encode(JSON.stringify(preview));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
}
