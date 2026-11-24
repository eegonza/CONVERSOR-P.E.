"use strict";

const byId = (id) => document.getElementById(id);
const hosted = globalThis.conversorHosted;
const views = ["dashboard", "history", "users", "audit"];
const decimalFields = new Set([
  "units", "cost", "sale_price", "tax_rate", "outbound_total", "inbound_units", "inbound_total",
]);
const editableFields = [
  "code", "description", "package", "style", "descriptor", "reference", "tax_class", "tax_rate",
  "units", "cost", "sale_price", "outbound_total", "inbound_units", "inbound_total",
];
const initialLabels = {
  page: "Página", line: "Fila", code: "Código", description: "Descripción", package: "Empaque",
  style: "Estilo", descriptor: "Descriptor", reference: "Ref.", tax_class: "Clase I.V.",
  tax_rate: "Tasa I.V.", units: "Unidades", cost: "Costo", sale_price: "P/Venta",
  outbound_total: "Total salidas", inbound_units: "Unidades entradas", inbound_total: "Total entradas",
};
const state = {
  session: null, activeView: null, file: null, upload: null, uploadBusy: false,
  source: null, record: null, doc: null, columns: [], edits: Object.create(null), exclude: new Set(),
  search: "", page: "", editing: null, preview: null, previewRevision: 0, review: null,
  sort: null, listRevisions: Object.create(null), listOffsets: Object.create(null), historySelection: 0,
};

class RequestError extends Error {
  constructor(status, body) {
    const detail = body?.detail;
    const decoded = Array.isArray(detail)
      ? detail.map((item) => item.msg).filter(Boolean).join(" · ")
      : typeof detail === "string" ? detail : body?.message;
    super(decoded || `No se pudo completar la solicitud (${status}).`);
    this.status = status;
  }
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = String(value);
  if (className) node.className = className;
  return node;
}

function button(label, action, className = "button secondary") {
  const control = element("button", label, className);
  control.type = "button";
  if (action) control.addEventListener("click", action);
  return control;
}

function notice(node, message = "", kind = "") {
  node.textContent = message;
  node.classList.remove("error", "warning", "success");
  if (kind) node.classList.add(kind);
  node.hidden = !message;
}

function field(label, control) {
  const wrapper = element("label", null, "field");
  wrapper.append(element("span", label), control);
  return wrapper;
}

function input(type, name, value = "") {
  const control = element("input");
  control.type = type;
  control.name = name;
  control.value = value ?? "";
  return control;
}

function select(label, entries) {
  const control = element("select");
  control.setAttribute("aria-label", label);
  for (const [key, value] of entries) {
    const option = element("option", value);
    option.value = key;
    control.append(option);
  }
  return control;
}

function card(title, className = "card stack") {
  const panel = element("section", null, className);
  panel.append(element("h3", title));
  return panel;
}

function table(headers, description = "Tabla con desplazamiento") {
  const wrap = element("div", null, "table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", description);
  const grid = element("table", null, "data-table");
  const heading = grid.createTHead().insertRow();
  for (const label of headers) {
    const cell = element("th", label);
    cell.scope = "col";
    heading.append(cell);
  }
  wrap.append(grid);
  return { wrap, grid, body: grid.createTBody() };
}

function appendCells(row, values) {
  for (const value of values) {
    const cell = row.insertCell();
    if (value instanceof Node) cell.append(value);
    else if (value !== undefined && value !== null) cell.textContent = String(value);
  }
}

function scalar(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function labelFor(key) {
  return state.session?.columns?.[key] ?? initialLabels[key] ?? key;
}

async function request(path, { method = "GET", body, esArchivo = false, auth = true } = {}) {
  const session = state.session;
  try {
    if (hosted) return await hosted.request(path, { method, body });
    const headers = { Accept: esArchivo ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && session?.csrf && method !== "GET") headers["X-CSRF-Token"] = session.csrf;
    const response = await fetch(path, {
      method, headers, credentials: "same-origin", cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new RequestError(response.status, await response.json().catch(() => null));
    if (esArchivo) return response.blob();
    return response.status === 204 ? null : response.json();
  } catch (failure) {
    if (auth && failure.status === 401 && session && state.session === session) {
      endSession("La sesión ha vencido. Inicie sesión nuevamente.");
    }
    throw failure;
  }
}

function showAuth(mode, message = "", kind = "") {
  const copy = {
    login: ["Iniciar sesión", "Acceda con su cuenta de trabajo."],
    recover: ["Recuperar acceso", "Indique el correo asociado a su cuenta."],
    password: ["Restablecer contraseña", "Elija una nueva contraseña para su cuenta."],
  }[mode];
  for (const key of ["login", "recover", "password"]) {
    const form = byId(`${key}-form`);
    form.hidden = key !== mode;
    if (form.hidden) for (const password of form.querySelectorAll('[type="password"]')) password.value = "";
  }
  if (byId("auth-title")) byId("auth-title").textContent = copy[0];
  if (byId("auth-description")) byId("auth-description").textContent = copy[1];
  byId("loading-view").hidden = true;
  byId("app-view").hidden = true;
  byId("auth-view").hidden = false;
  notice(byId("auth-message"), message, kind);
}

const initialUrl = new URL(location.href);
const callback = new URLSearchParams(initialUrl.hash.slice(1));
let recoveryToken = callback.get("token_hash") || initialUrl.searchParams.get("token_hash");
if (recoveryToken) {
  for (const key of ["token_hash", "type"]) {
    initialUrl.searchParams.delete(key);
    callback.delete(key);
  }
  initialUrl.hash = callback.toString();
  history.replaceState(null, "", initialUrl);
}

function handleAuthForm(id, action) {
  byId(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      notice(byId("auth-message"));
      await action(new FormData(form));
      form.reset();
    } catch (error) {
      notice(byId("auth-message"), error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
}

function beginSession(session) {
  state.session = session;
  byId("session-name").textContent = session.user.full_name || session.user.email;
  byId("session-role").textContent = roleLabel(session.user.role);
  const admin = session.user.role === "admin";
  byId("nav-users").hidden = !admin;
  byId("nav-audit").hidden = !admin;
  byId("auth-view").hidden = true;
  byId("loading-view").hidden = true;
  byId("app-view").hidden = false;
  notice(byId("global-status"));
  openView("dashboard");
}

function endSession(message = "") {
  state.session = null;
  state.upload?.abort();
  state.upload = null;
  state.uploadBusy = false;
  byId("file-input").disabled = false;
  byId("pick-file").disabled = false;
  state.record = null;
  state.doc = null;
  state.preview = null;
  state.editing = null;
  state.edits = Object.create(null);
  state.exclude.clear();
  state.search = "";
  state.listOffsets = Object.create(null);
  state.previewRevision += 1;
  state.review = null;
  byId("review-content").inert = false;
  byId("upload-form").inert = false;
  clearSource();
  byId("upload-form").reset();
  setFile(null);
  setUploadProgress(false);
  notice(byId("upload-status"));
  byId("review-section").hidden = true;
  byId("session-name").textContent = "";
  byId("session-role").textContent = "";
  for (const id of ["review-content", "history-content", "users-content", "audit-content"]) {
    byId(id).replaceChildren();
  }
  showAuth("login", message, message ? "warning" : "");
}

function roleLabel(role) {
  return { admin: "Administrador", operator: "Operador" }[role] ?? scalar(role);
}

function openView(view) {
  if (!views.includes(view) || !state.session) return;
  if ((view === "audit" || view === "users") && state.session.user.role !== "admin") return;
  state.activeView = view;
  for (const key of views) byId(`${key}-view`).hidden = key !== view;
  for (const item of document.querySelectorAll("[data-view]")) {
    if (item.dataset.view === view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
    item.classList.toggle("active", item.dataset.view === view);
  }
  notice(byId("global-status"));
  if (view !== "dashboard") refreshView(view);
}

function clearSource() {
  if (state.source) URL.revokeObjectURL(state.source.url);
  state.source = null;
  byId("source-card").hidden = true;
  byId("source-frame").removeAttribute("src");
  byId("source-open").removeAttribute("href");
}

function showSource(file, id) {
  clearSource();
  const url = URL.createObjectURL(new Blob([file], { type: "application/pdf" }));
  state.source = { url, id };
  byId("source-frame").src = url;
  byId("source-open").href = url;
  byId("source-card").hidden = false;
}

function setFile(file) {
  if (file && (!/\.pdf$/i.test(file.name) || file.size === 0)) {
    setFile(null);
    byId("file-input").value = "";
    notice(byId("upload-status"), "Seleccione un archivo PDF con contenido.", "error");
    return;
  }
  state.file = file;
  byId("file-details").hidden = !file;
  byId("upload-button").disabled = state.uploadBusy || !file;
  byId("file-name").textContent = file?.name ?? "";
  byId("file-size").textContent = file ? new Intl.NumberFormat("es-PA").format(file.size) + " bytes" : "";
  notice(byId("upload-status"));
}

function setUploadProgress(show, value) {
  const progress = byId("upload-progress");
  progress.hidden = !show;
  if (value === undefined) progress.removeAttribute("value");
  else {
    progress.max = 100;
    progress.value = value;
  }
}

function uploadFile(file) {
  if (hosted) {
    const controller = new AbortController();
    state.upload = controller;
    return hosted.upload(file, {
      signal: controller.signal,
      onStage: (stage) => {
        if (controller.signal.aborted) return;
        const messages = {
          loading: "Preparando el lector de PDF…",
          reading: "Leyendo el PDF en este navegador…",
          saving: "Guardando los datos extraídos en Supabase…",
        };
        if (messages[stage]) notice(byId("upload-status"), messages[stage]);
        setUploadProgress(true, stage === "saving" ? 90 : undefined);
      },
    });
  }
  const form = new FormData();
  form.append("file", file);
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    state.upload = req;
    req.open("POST", "/api/uploads");
    req.responseType = "json";
    req.setRequestHeader("X-CSRF-Token", state.session.csrf);
    req.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) setUploadProgress(true, event.loaded / event.total * 100);
    });
    req.upload.addEventListener("load", () => {
      notice(byId("upload-status"), "Leyendo el PDF…");
      setUploadProgress(true);
    });
    req.addEventListener("load", () => {
      if (req.status >= 200 && req.status < 300 && req.response) resolve(req.response);
      else reject(new RequestError(req.status, req.response));
    });
    req.addEventListener("error", () => reject(new Error("Se interrumpió la comunicación durante la carga.")));
    req.addEventListener("abort", () => reject(new Error("Carga cancelada.")));
    req.send(form);
  });
}

function selectDocument(doc) {
  state.doc = doc;
  state.edits = Object.create(null);
  state.exclude = new Set();
  state.columns = [...state.session.default_columns];
  state.search = "";
  state.page = "";
  state.sort = null;
  state.editing = null;
  state.preview = null;
  state.previewRevision += 1;
  renderReview();
}

function loadRecord(record, file = null) {
  if (file) showSource(file, record.id);
  else if (state.source?.id !== record.id) clearSource();
  state.record = record;
  const documents = record.extraction.documents;
  selectDocument(documents.length === 1 ? documents[0] : null);
  byId("review-section").hidden = false;
}

function issueDetails(issues, title) {
  if (!issues?.length) return null;
  const container = element("details", null, "notice");
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;
  container.classList.toggle("error", errors > 0);
  container.classList.toggle("warning", errors === 0 && warnings > 0);
  container.open = errors > 0 || warnings > 0;
  container.append(element("summary", `${title} (${issues.length})`));
  const list = element("ul");
  for (const item of issues) {
    const location = [item.page == null ? "" : `página ${item.page}`, item.row == null ? "" : `fila ${item.row}`]
      .filter(Boolean).join(", ");
    const level = { error: "Error", warning: "Advertencia", info: "Información" }[item.severity] ?? "Información";
    list.append(element("li", `${level} · ${location ? location + " · " : ""}${item.message}`));
  }
  container.append(list);
  return container;
}

function documentPayload() {
  return {
    number: state.doc.number,
    columns: [...state.columns],
    edits: state.edits,
    exclude_ids: Array.from(state.exclude),
  };
}

function invalidatePreview() {
  const hadPreview = state.preview !== null || state.review.previewPending;
  state.preview = null;
  state.previewRevision += 1;
  if (hadPreview) {
    state.review.preview.replaceChildren();
    notice(state.review.previewStatus, "La selección cambió. Genere una vista previa actualizada.", "warning");
  }
  state.review.previewPending = false;
  updatePreviewControl();
}

function updatePreviewControl() {
  state.review.previewButton.disabled = !state.doc?.number || !state.columns.length ||
    state.editing !== null || state.review.previewPending;
}

function valueFor(row, key) {
  const edit = state.edits[row.id];
  return edit && Object.hasOwn(edit, key) ? edit[key] : row[key];
}

function matchingRows() {
  const search = state.search.trim().toLocaleLowerCase("es");
  return state.doc.rows.filter((row) => {
    if (state.page && String(row.page) !== state.page) return false;
    if (!search) return true;
    return ["code", "description", "reference", "descriptor", "tax_class"].some((key) =>
      String(valueFor(row, key) ?? "").toLocaleLowerCase("es").includes(search));
  });
}

function updateRowCount() {
  state.review.count.textContent = `${matchingRows().length} visibles · ${state.doc.rows.length - state.exclude.size} incluidas · ${state.exclude.size} excluidas`;
}

const rowCollator = new Intl.Collator("es-PA", { sensitivity: "base" });

function compareRows(left, right, key, direction) {
  if (key === "page") return direction * ((left.page - right.page) || (left.line - right.line));
  const a = valueFor(left, key);
  const b = valueFor(right, key);
  if (a == null || b == null) return Number(a == null) - Number(b == null);
  if (decimalFields.has(key)) {
    const difference = Number(String(a).replaceAll(",", "")) - Number(String(b).replaceAll(",", ""));
    if (Number.isFinite(difference)) return direction * difference;
  }
  return direction * rowCollator.compare(a, b);
}

function renderSourceRows() {
  const rows = matchingRows();
  if (state.sort) rows.sort((left, right) => compareRows(left, right, state.sort.key, state.sort.direction));
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = element("tr");
    const include = input("checkbox", "");
    include.checked = !state.exclude.has(row.id);
    tr.classList.toggle("is-excluded", !include.checked);
    include.setAttribute("aria-label", `Incluir página ${row.page}, fila ${row.line}`);
    include.addEventListener("change", () => {
      if (include.checked) state.exclude.delete(row.id);
      else state.exclude.add(row.id);
      tr.classList.toggle("is-excluded", !include.checked);
      updateRowCount();
      invalidatePreview();
    });
    const editButton = button(state.edits[row.id] ? "Editar cambios" : "Editar", () => editRow(row), "button secondary small");
    editButton.setAttribute("aria-label", `Editar página ${row.page}, fila ${row.line}`);
    appendCells(tr, [
      include, `${row.page} / ${row.line}`, scalar(valueFor(row, "code")), scalar(valueFor(row, "description")),
      scalar(valueFor(row, "tax_class")), scalar(valueFor(row, "units")), scalar(valueFor(row, "cost")),
      scalar(valueFor(row, "outbound_total")), editButton,
    ]);
    fragment.append(tr);
  }
  if (!rows.length) {
    const tr = element("tr");
    const empty = element("td", "No hay filas que coincidan con los filtros.", "empty-state");
    empty.colSpan = 9;
    tr.append(empty);
    fragment.append(tr);
  }
  state.review.sourceRows.replaceChildren(fragment);
  updateRowCount();
}

function editRow(row) {
  if (state.editing) {
    state.review.editor.querySelector("input")?.focus();
    return;
  }
  state.editing = row.id;
  updatePreviewControl();
  const panel = card(`Editar página ${row.page}, fila ${row.line}`);
  const form = element("form", null, "stack");
  const fields = element("div", null, "field-grid");
  for (const key of editableFields) {
    const control = input("text", key, valueFor(row, key));
    if (decimalFields.has(key)) control.inputMode = "decimal";
    const group = field(labelFor(key), control);
    group.append(element("small", `En el PDF: ${scalar(row[key])}`, "muted"));
    fields.append(group);
  }
  const actions = element("div", null, "form-actions");
  const close = () => {
    state.review.editor.replaceChildren();
    state.editing = null;
    updatePreviewControl();
  };
  const save = button("Aplicar cambios", null, "button primary");
  save.type = "submit";
  actions.append(button("Cancelar", close), save);
  form.append(fields, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const changes = Object.create(null);
    for (const [key, entered] of new FormData(form)) {
      const value = entered === "" ? null : entered;
      if (String(value ?? "") !== String(row[key] ?? "")) changes[key] = value;
    }
    if (Object.keys(changes).length) state.edits[row.id] = changes;
    else delete state.edits[row.id];
    close();
    renderSourceRows();
    invalidatePreview();
  });
  panel.append(form);
  state.review.editor.replaceChildren(panel);
  form.querySelector("input").focus();
}

function renderColumnOptions(focusKey) {
  const options = state.review.columnOptions;
  const selected = state.columns;
  const all = Object.keys(state.session.columns);
  options.replaceChildren();
  for (const key of [...selected, ...all.filter((column) => !selected.includes(column))]) {
    const option = element("div", null, "column-option");
    const index = selected.indexOf(key);
    const control = input("checkbox", key);
    control.checked = index !== -1;
    control.addEventListener("change", () => {
      if (control.checked) selected.push(key);
      else selected.splice(index, 1);
      invalidatePreview();
      renderColumnOptions(key);
    });
    const label = element("label", null, "checkbox-label");
    label.append(control, element("span", labelFor(key)));
    const reorder = element("div", null, "actions-inline");
    for (const [delta, symbol, action] of [[-1, "↑", "Subir"], [1, "↓", "Bajar"]]) {
      const adjacent = index + delta;
      const move = button(symbol, () => {
        [selected[index], selected[adjacent]] = [selected[adjacent], selected[index]];
        invalidatePreview();
        renderColumnOptions(key);
      }, "button secondary small");
      move.disabled = index === -1 || adjacent < 0 || adjacent >= selected.length;
      move.setAttribute("aria-label", `${action} ${labelFor(key)}`);
      reorder.append(move);
    }
    option.append(label, reorder);
    options.append(option);
    if (focusKey === key) control.focus();
  }
}

function renderReview() {
  const area = byId("review-content");
  area.replaceChildren();
  const { record, doc } = state;
  const extraction = record.extraction;
  const header = card("Revisión de la extracción");
  header.append(element("p", `${record.filename} · ${extraction.page_count} páginas en el PDF`, "muted"));
  if (extraction.documents.length > 1) {
    const picker = select("Número de salida", [
      ["", "Seleccione una salida"],
      ...extraction.documents.map((item, index) => [String(index), item.number || "Número sin identificar"]),
    ]);
    picker.value = doc ? String(extraction.documents.indexOf(doc)) : "";
    picker.addEventListener("change", () => selectDocument(picker.value === "" ? null : extraction.documents[Number(picker.value)]));
    header.append(field("El PDF contiene varias salidas. Elija una para validarla por separado.", picker));
  }
  const general = issueDetails(extraction.issues, "Hallazgos del PDF");
  if (general) header.append(general);
  area.append(header);
  if (!doc) {
    state.review = null;
    if (!extraction.documents.length) area.append(element("p", "No se identificó una salida en este PDF.", "notice error"));
    return;
  }
  header.append(element("p", `Salida ${doc.number || "sin identificar"} · ${doc.rows.length} filas detectadas`));
  const headerValues = [
    ["Empresa", doc.header?.company], ["Fecha de salida", doc.header?.date],
    ["Fecha superior", doc.header?.printed_date], ["Referencia", doc.header?.reference],
    ["Destino", doc.header?.destination], ["Nota del PDF", doc.header?.note],
  ].filter(([, value]) => value != null && value !== "");
  if (headerValues.length) {
    const metadata = element("dl", null, "stats-grid");
    for (const [label, value] of headerValues) {
      const stat = element("div", null, "stat");
      stat.append(element("dt", label), element("dd", value));
      metadata.append(stat);
    }
    header.append(metadata);
  }
  const docProblems = issueDetails(doc.issues, "Hallazgos de la salida");
  if (docProblems) header.append(docProblems);
  if (!doc.number) header.append(element("p", "Se necesita un número de salida identificado para generar el Excel.", "notice error"));

  const rowsCard = card("Filas detectadas");
  const filters = element("div", null, "toolbar");
  const search = input("search", "search", state.search);
  search.placeholder = "Código, descripción o referencia";
  search.addEventListener("input", () => { state.search = search.value; renderSourceRows(); });
  const pages = select("Página de origen", [["", "Todas las páginas"], ...doc.pages.map((page) => [page, page])]);
  pages.addEventListener("change", () => { state.page = pages.value; renderSourceRows(); });
  filters.append(field("Buscar filas", search), field("Página de origen", pages));
  const rowActions = element("div", null, "actions-inline");
  for (const [include, name] of [[true, "Incluir visibles"], [false, "Excluir visibles"]]) {
    rowActions.append(button(name, () => {
      for (const row of matchingRows()) {
        if (include) state.exclude.delete(row.id);
        else state.exclude.add(row.id);
      }
      renderSourceRows();
      invalidatePreview();
    }, "button secondary small"));
  }
  const count = element("p", null, "muted");
  count.setAttribute("aria-live", "polite");
  const rowHeadings = [
    [null, "Incluir"], ["page", "Página / fila"], ["code", "Código"], ["description", "Descripción"],
    ["tax_class", "I.V."], ["units", "Unidades"], ["cost", "Costo"],
    ["outbound_total", "Total salidas"], [null, "Acción"],
  ];
  const grid = table(rowHeadings.map(([, label]) => label), "Filas detectadas");
  const headings = [...grid.grid.tHead.rows[0].cells];
  rowHeadings.forEach(([key, label], index) => {
    if (!key) return;
    const sort = button(label, () => {
      const direction = state.sort?.key === key ? -state.sort.direction : 1;
      state.sort = { key, direction };
      for (const heading of headings) heading.removeAttribute("aria-sort");
      headings[index].setAttribute("aria-sort", direction === 1 ? "ascending" : "descending");
      renderSourceRows();
    }, "");
    sort.setAttribute("aria-label", `Ordenar por ${label}`);
    headings[index].replaceChildren(sort);
  });
  const editor = element("div");
  rowsCard.append(filters, rowActions, count, editor, grid.wrap);

  const columnCard = card("Columnas del Excel");
  const columnOptions = element("div", null, "column-options");
  const previewButton = button("Actualizar vista previa", createPreview, "button primary");
  const previewStatus = element("p", null, "notice");
  previewStatus.setAttribute("role", "status");
  previewStatus.hidden = true;
  columnCard.append(columnOptions, previewButton, previewStatus);
  const preview = element("div");
  state.review = { sourceRows: grid.body, count, editor, columnOptions, previewButton, previewStatus, preview, previewPending: false };
  area.append(rowsCard, columnCard, preview);
  renderSourceRows();
  renderColumnOptions();
  updatePreviewControl();
}

async function createPreview() {
  const review = state.review;
  const revision = ++state.previewRevision;
  const recordId = state.record.id;
  state.preview = null;
  review.preview.replaceChildren();
  review.previewPending = true;
  updatePreviewControl();
  notice(review.previewStatus, "Calculando la vista previa…");
  try {
    const result = await request(`/api/conversions/${encodeURIComponent(recordId)}/preview`, {
      method: "POST", body: documentPayload(),
    });
    if (revision !== state.previewRevision) return;
    state.preview = result;
    notice(review.previewStatus);
    renderPreview(result);
  } catch (error) {
    if (revision === state.previewRevision) notice(review.previewStatus, error.message, "error");
  } finally {
    if (revision === state.previewRevision) {
      review.previewPending = false;
      updatePreviewControl();
    }
  }
}

function displayBase(exact, known) {
  return exact == null && known != null ? `${known} identificado · base incompleta` : scalar(exact);
}

function renderPreview(result) {
  const { preview } = result;
  const panel = card(`Vista previa de la salida ${preview.number}`, "card stack preview-panel");
  const { summary, printed_totals: printed, issues } = preview;
  const stats = element("div", null, "stats-grid");
  const measurements = [
    ["Páginas de la salida", summary.page_count], ["Filas detectadas", summary.detected_rows],
    ["Filas por exportar", summary.export_rows], ["Filas excluidas", summary.excluded_rows],
    ["Productos distintos", summary.distinct_products], ["Total de unidades", summary.units],
  ];
  for (const [label, value] of measurements) {
    const stat = element("div", null, "stat");
    stat.append(element("span", label), element("strong", scalar(value)));
    stats.append(stat);
  }
  const amounts = table(["Concepto", "Salidas impresas", "Entradas impresas", "Filas seleccionadas"], "Totales impresos y seleccionados");
  for (const [label, key, current] of [
    ["Subtotal", "subtotal", summary.subtotal],
    ["Base gravada", "taxable_subtotal", displayBase(summary.taxable_subtotal, summary.known_taxable_subtotal)],
    ["Base exenta", "exempt_subtotal", displayBase(summary.exempt_subtotal, summary.known_exempt_subtotal)],
    ["Impuesto", "tax", summary.tax], ["Total neto", "net", summary.net],
  ]) appendCells(amounts.body.insertRow(), [label, scalar(printed?.outbound?.[key]), scalar(printed?.inbound?.[key]), scalar(current)]);
  panel.append(stats, amounts.wrap);
  const issuesBlock = issueDetails(issues, "Resultados de validación");
  if (issuesBlock) panel.append(issuesBlock);

  panel.append(element("h4", "Datos que se exportarán"));
  const actual = table(preview.columns.map(labelFor), "Datos de la vista previa del Excel");
  for (const row of preview.rows) appendCells(actual.body.insertRow(), preview.columns.map((key) => row[key]));
  panel.append(actual.wrap);
  const hasErrors = issues?.some((item) => item.severity === "error");
  const hasWarnings = issues?.some((item) => item.severity === "warning");
  if (hasErrors) panel.append(element("p", "Corrija los errores y actualice la vista previa para continuar.", "notice error"));
  else panel.append(exportForm(result, hasWarnings));
  state.review.preview.replaceChildren(panel);
}

function exportForm(result, hasWarnings) {
  const form = element("form", null, "stack");
  const number = input("text", "confirmed_number");
  number.required = true;
  number.inputMode = "numeric";
  number.autocomplete = "off";
  form.append(field(`Escriba el número de salida ${result.preview.number} para confirmar`, number));
  const reason = element("textarea");
  reason.name = "accepted_reason";
  reason.maxLength = 1000;
  if (hasWarnings) {
    reason.required = true;
    form.append(field("Motivo para aceptar las advertencias", reason));
  }
  const actions = element("div", null, "form-actions");
  const submit = button("Validar y generar Excel", null, "button primary");
  submit.type = "submit";
  const message = element("p", null, "notice");
  message.hidden = true;
  message.setAttribute("role", "status");
  actions.append(button("Cancelar", () => {
    state.preview = null;
    state.review.preview.replaceChildren();
    notice(state.review.previewStatus, "Se canceló la validación.");
    state.review.previewButton.focus();
  }), submit);
  form.append(actions, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (number.value.trim() !== result.preview.number) {
      notice(message, "El número de salida debe coincidir exactamente con la vista previa.", "error");
      number.focus();
      return;
    }
    if (hasWarnings && !reason.value.trim()) {
      notice(message, "Indique el motivo de aceptación de las advertencias.", "error");
      reason.focus();
      return;
    }
    if (result !== state.preview || state.editing) {
      notice(message, "Cierre la edición y actualice la vista previa antes de generar el Excel.", "error");
      return;
    }
    const session = state.session;
    const record = state.record;
    const reviewContent = byId("review-content");
    const uploadForm = byId("upload-form");
    reviewContent.inert = true;
    uploadForm.inert = true;
    try {
      notice(message, "Generando el Excel…");
      const excel = await request(`/api/conversions/${encodeURIComponent(record.id)}/export`, {
        method: "POST", esArchivo: true,
        body: {
          ...documentPayload(), preview_hash: result.preview_hash, confirmed_number: number.value.trim(),
          accepted_reason: reason.value.trim() || null,
        },
      });
      if (state.session !== session) return;
      const link = element("a");
      const url = URL.createObjectURL(excel);
      link.href = url;
      link.download = `SALIDA ${result.preview.number}.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notice(message, "Excel generado.", "success");
    } catch (error) {
      if (state.session !== session) return;
      if (error.status === 409 && state.preview === result) {
        invalidatePreview();
        notice(state.review.previewStatus, error.message, "warning");
      } else notice(message, error.message, "error");
    } finally {
      if (state.session === session) {
        reviewContent.inert = false;
        uploadForm.inert = false;
      }
    }
  });
  return form;
}

const dateFormatter = new Intl.DateTimeFormat("es-PA", { dateStyle: "short", timeStyle: "short", timeZone: "America/Panama" });

function displayDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
}

function validateNewPassword(password) {
  if ([...password].length < 12 || new TextEncoder().encode(password).length > 72) {
    throw new Error("La contraseña debe tener al menos 12 caracteres y un máximo de 72 bytes.");
  }
}

function renderHistory(records) {
  const container = byId("history-content");
  if (!records.length) {
    container.replaceChildren(element("p", "Todavía no hay documentos procesados.", "card empty-state"));
    return;
  }
  const admin = state.session.user.role === "admin";
  const listing = table(["Archivo PDF", "Carga", "Procesamiento", ...(admin ? ["Usuario"] : []), "Acción"], "Historial de documentos");
  for (const record of records) {
    const open = button("Abrir revisión", async () => {
      const session = state.session;
      const selection = ++state.historySelection;
      open.disabled = true;
      notice(byId("global-status"), "Abriendo el documento procesado…");
      try {
        const details = await request(`/api/conversions/${encodeURIComponent(record.id)}`);
        if (session !== state.session || selection !== state.historySelection || state.activeView !== "history") return;
        loadRecord(details);
        openView("dashboard");
        if (!state.source) notice(byId("upload-status"), "La revisión del historial contiene los datos extraídos. Puede seleccionar el PDF original para volver a verlo.");
        byId("review-section").scrollIntoView({ block: "start" });
      } catch (error) {
        if (session === state.session && selection === state.historySelection) notice(byId("global-status"), error.message, "error");
      } finally {
        open.disabled = false;
      }
    }, "button secondary small");
    const owner = admin ? [scalar(record.user_id)] : [];
    appendCells(listing.body.insertRow(), [record.filename, displayDate(record.uploaded_at), displayDate(record.processed_at), ...owner, open]);
  }
  const panel = element("section", null, "card");
  panel.append(listing.wrap);
  container.replaceChildren(panel);
}

function renderAudit(records) {
  const container = byId("audit-content");
  if (!records.length) {
    container.replaceChildren(element("p", "Todavía no hay eventos de auditoría.", "card empty-state"));
    return;
  }
  const types = {
    conversion_registered: "Documento procesado", processing_failed: "Error de procesamiento",
    review_saved: "Validación de datos", export_approved: "Exportación aprobada",
    user_created: "Usuario creado", user_profile_updated: "Usuario actualizado",
  };
  const listing = table(["Fecha", "Usuario", "Operación", "Documento o salida", "Detalles"], "Eventos de auditoría");
  for (const record of records) {
    const detail = element("details");
    detail.append(element("summary", "Ver registro"), element("pre", JSON.stringify(record.details ?? {}, null, 2)));
    const actor = element("div");
    actor.append(element("strong", record.user_name ?? "—"), element("br"), element("small", record.user_id ?? "", "muted"));
    const source = [record.details?.filename, record.details?.number].filter(Boolean).join(" · ");
    appendCells(listing.body.insertRow(), [displayDate(record.created_at), actor, types[record.event_type] ?? record.event_type,
      source || scalar(record.conversion_id), detail]);
  }
  const panel = element("section", null, "card");
  panel.append(listing.wrap);
  container.replaceChildren(panel);
}

function userForm(user = null) {
  const panel = card(user ? `Editar a ${user.full_name}` : "Crear usuario");
  const form = element("form", null, "stack");
  const fields = element("div", null, "field-grid");
  const fullName = input("text", "full_name", user?.full_name);
  fullName.required = true;
  fullName.maxLength = 120;
  const email = input("email", "email", user?.email);
  email.required = true;
  email.readOnly = Boolean(user);
  email.autocomplete = "off";
  fields.append(field("Nombre completo", fullName), field("Correo", email));

  const own = user?.id === state.session.user.id;
  const role = select("Rol", [["operator", "Operador"], ["admin", "Administrador"]]);
  role.name = "role";
  role.value = user?.role ?? "operator";
  role.disabled = own;
  fields.append(field("Rol", role));
  const active = user ? input("checkbox", "active") : null;
  if (active) {
    active.checked = user.active;
    active.disabled = own;
    const activeLabel = element("label", null, "checkbox-label");
    activeLabel.append(active, element("span", "Cuenta activa"));
    fields.append(activeLabel);
  }
  const password = user ? null : input("password", "password");
  if (password) {
    password.autocomplete = "new-password";
    password.required = true;
    password.minLength = 12;
    password.maxLength = 72;
    fields.append(field("Contraseña inicial", password));
  }
  const actions = element("div", null, "form-actions");
  if (user) actions.append(button("Cancelar", () => panel.remove()));
  const submit = button(user ? "Guardar usuario" : "Crear usuario", null, "button primary");
  submit.type = "submit";
  actions.append(submit);
  const message = element("p", null, "notice");
  message.hidden = true;
  message.setAttribute("role", "status");
  form.append(fields, actions, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = state.session;
    const common = { full_name: fullName.value.trim(), role: role.value };
    if (!common.full_name) {
      notice(message, "Introduzca el nombre completo.", "error");
      return;
    }
    submit.disabled = true;
    notice(message);
    try {
      if (user) {
        await request(`/api/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: { ...common, active: active.checked } });
      } else {
        validateNewPassword(password.value);
        await request("/api/users", { method: "POST", body: { ...common, email: email.value.trim(), password: password.value } });
        form.reset();
        state.listOffsets.users = 0;
      }
      if (state.session !== session) return;
      if (own) byId("session-name").textContent = common.full_name;
      notice(byId("global-status"), user ? "Usuario actualizado." : "Usuario creado.", "success");
      await refreshView("users");
    } catch (error) {
      if (state.session === session) notice(message, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
  panel.append(form);
  return panel;
}

function renderUsers(users) {
  const container = byId("users-content");
  const listing = table(["Nombre", "Correo", "Rol", "Estado", "Acción"], "Cuentas de usuario");
  const editor = element("div");
  for (const user of users) {
    const edit = button("Editar", () => {
      const panel = userForm(user);
      editor.replaceChildren(panel);
      panel.querySelector("input").focus();
    }, "button secondary small");
    const active = element("span", user.active ? "Activa" : "Inactiva", "badge");
    appendCells(listing.body.insertRow(), [user.full_name, user.email, roleLabel(user.role), active, edit]);
  }
  const panel = card("Cuentas registradas");
  panel.append(listing.wrap);
  container.replaceChildren(userForm(), editor, panel);
}

async function refreshView(view) {
  const session = state.session;
  const revision = (state.listRevisions[view] ?? 0) + 1;
  state.listRevisions[view] = revision;
  const refresh = byId(`${view}-refresh`);
  const offset = state.listOffsets[view] ?? 0;
  const [endpoint, render] = {
    history: ["/api/conversions", renderHistory], users: ["/api/users", renderUsers], audit: ["/api/audit", renderAudit],
  }[view];
  refresh.disabled = true;
  try {
    const records = await request(offset ? `${endpoint}?offset=${offset}` : endpoint);
    if (state.session === session && revision === state.listRevisions[view]) {
      render(records);
      if (offset || records.length === 100) renderPagination(view, offset, records.length === 100);
    }
  } catch (error) {
    if (state.session === session && revision === state.listRevisions[view] && state.activeView === view) {
      notice(byId("global-status"), error.message, "error");
    }
  } finally {
    if (revision === state.listRevisions[view]) refresh.disabled = false;
  }
}

function renderPagination(view, offset, mayHaveMore) {
  const actions = element("div", null, "section-actions");
  const controls = [["Anterior", -100, offset === 0], ["Siguiente", 100, !mayHaveMore]];
  for (const [label, delta, disabled] of controls) {
    const control = button(label, () => {
      state.listOffsets[view] = offset + delta;
      for (const peer of actions.querySelectorAll("button")) peer.disabled = true;
      refreshView(view).finally(() => {
        for (const peer of actions.querySelectorAll("button")) peer.disabled = peer.dataset.disabled === "true";
      });
    });
    control.disabled = disabled;
    control.dataset.disabled = String(disabled);
    actions.append(control);
  }
  actions.prepend(element("p", `Página ${offset / 100 + 1}`, "muted"));
  byId(`${view}-content`).append(actions);
}

for (const nav of document.querySelectorAll("[data-view]")) {
  nav.addEventListener("click", () => openView(nav.dataset.view));
}
for (const view of ["history", "users", "audit"]) {
  byId(`${view}-refresh`).addEventListener("click", () => {
    notice(byId("global-status"));
    refreshView(view);
  });
}
for (const route of document.querySelectorAll("[data-auth-view]")) {
  route.addEventListener("click", () => {
    if (route.closest("#password-form")) recoveryToken = null;
    showAuth(route.dataset.authView);
    byId(`${route.dataset.authView}-form`).querySelector("input").focus();
  });
}

handleAuthForm("login-form", async (form) => {
  const session = await request("/api/auth/login", {
    method: "POST", auth: false, body: { email: form.get("email").trim(), password: form.get("password") },
  });
  beginSession(session);
});
handleAuthForm("recover-form", async (form) => {
  await request("/api/auth/recover", { method: "POST", auth: false, body: { email: form.get("email").trim() } });
  notice(byId("auth-message"), "Si hay una cuenta asociada al correo, recibirá un enlace de recuperación.", "success");
});
handleAuthForm("password-form", async (form) => {
  const password = form.get("password");
  if (!recoveryToken) throw new Error("El enlace de recuperación no está disponible. Solicite otro enlace.");
  if (password !== form.get("password_confirmation")) throw new Error("Las contraseñas deben coincidir.");
  validateNewPassword(password);
  await request("/api/auth/reset", { method: "POST", auth: false, body: { token_hash: recoveryToken, password } });
  recoveryToken = null;
  showAuth("login", "Contraseña actualizada. Inicie sesión con la nueva contraseña.", "success");
});
byId("logout-button").addEventListener("click", async () => {
  const control = byId("logout-button");
  control.disabled = true;
  try {
    await request("/api/auth/logout", { method: "POST" });
    endSession();
  } catch (error) {
    if (state.session) notice(byId("global-status"), error.message, "error");
  } finally {
    control.disabled = false;
  }
});

byId("pick-file").addEventListener("click", () => byId("file-input").click());
byId("file-input").addEventListener("change", (event) => setFile(event.currentTarget.files[0] ?? null));
const dropZone = byId("drop-zone");
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!state.uploadBusy) dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("is-dragging");
});
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  if (state.uploadBusy) return;
  const { files } = event.dataTransfer;
  if (files.length === 1) {
    byId("file-input").value = "";
    setFile(files[0]);
  } else if (files.length > 1) notice(byId("upload-status"), "Seleccione un documento PDF por vez.", "warning");
});
byId("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.uploadBusy || !state.file || !state.session) return;
  const { session, file } = state;
  state.uploadBusy = true;
  for (const id of ["file-input", "pick-file", "upload-button"]) byId(id).disabled = true;
  notice(byId("upload-status"), hosted ? "Leyendo el PDF en este navegador…" : "Cargando el PDF…");
  setUploadProgress(true, 0);
  try {
    const record = await uploadFile(file);
    if (state.session !== session) return;
    loadRecord(record, file);
    const duplicate = record.duplicate ?? record.duplicated ?? false;
    notice(byId("upload-status"), duplicate ? "Este PDF ya se había procesado. Se abrió su revisión." : "Lectura del PDF completada.",
      duplicate ? "warning" : "success");
  } catch (error) {
    if (state.session !== session) return;
    if (error.status === 401) endSession("La sesión ha vencido. Inicie sesión nuevamente.");
    else notice(byId("upload-status"), error.message, "error");
  } finally {
    if (state.session === session) {
      state.upload = null;
      state.uploadBusy = false;
      byId("file-input").disabled = false;
      byId("pick-file").disabled = false;
      byId("upload-button").disabled = !state.file;
      setUploadProgress(false);
    }
  }
});

async function initialize() {
  if (recoveryToken) {
    showAuth("password");
    return;
  }
  try {
    beginSession(await request("/api/session"));
  } catch (error) {
    showAuth("login", error.status === 401 ? "" : error.message, error.status === 401 ? "" : "error");
  }
}

initialize();
