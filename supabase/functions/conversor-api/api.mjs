import { buildReview, columns, defaultColumns, isNumber, isObject, previewHash, ReviewError, validateExtraction } from "./review.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const maxBody = 8 * 1024 * 1024;
const recordFields = "id,user_id,filename,sha256,uploaded_at,processed_at,extraction";
const profileFields = "id,email,full_name,role,active,created_at";

class ApiError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function check(condition, detail, status = 422) {
  if (!condition) throw new ApiError(status, detail);
}

async function jsonBody(request) {
  check(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json",
    "La solicitud debe enviar datos JSON.", 415);
  check(Number(request.headers.get("content-length")) <= maxBody, "Los datos superan el tamaño permitido.", 413);
  const reader = request.body?.getReader();
  check(reader, "Faltan los datos de la solicitud.");
  let total = 0;
  let source = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) {
        await reader.cancel();
        throw new ApiError(413, "Los datos superan el tamaño permitido.");
      }
      source += decoder.decode(value, { stream: true });
    }
    const data = JSON.parse(source + decoder.decode());
    check(isObject(data) && typeof data.action === "string", "La solicitud no indica una operación válida.");
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "La solicitud contiene JSON inválido.");
  } finally {
    reader.releaseLock();
  }
}

function upstreamError(status, code) {
  if (code === "P0002" || status === 404) return new ApiError(404, "El registro no está disponible.");
  if (code === "23505" || status === 409) return new ApiError(409, "Ya existe un registro con esos datos.");
  if (code === "42501" || status === 401 || status === 403) return new ApiError(403, "No tienes permiso para esta operación.");
  if (status === 429) return new ApiError(429, "Demasiadas solicitudes. Intenta de nuevo en unos minutos.");
  if (status >= 500) return new ApiError(503, "Supabase no pudo completar la solicitud.");
  return new ApiError(422, "Supabase rechazó los datos de la operación.");
}

function backend({ url, publicKey, secretKey, fetcher }) {
  return async (path, { token = "", service = false, query, method = "GET", body, authCheck = false } = {}) => {
    const key = service ? secretKey : publicKey;
    check(url && key, "La función necesita la configuración de Supabase.", 503);
    const target = new URL(path, url);
    if (query) target.search = new URLSearchParams(query).toString();
    const headers = { apikey: key, Accept: "application/json" };
    if (token || (service && !key.startsWith("sb_secret_"))) headers.Authorization = "Bearer " + (token || key);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetcher(target, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ApiError(503, "La conexión con Supabase no está disponible.");
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (authCheck && [400, 401, 403].includes(response.status)) throw new ApiError(401, "Inicia sesión para continuar.");
      throw upstreamError(response.status, payload?.code || payload?.error_code);
    }
    return payload;
  };
}

function fileInfo(input) {
  const filename = typeof input.filename === "string"
    ? input.filename.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  check(filename.length <= 255 && /.+\.pdf$/iu.test(filename), "Selecciona un archivo PDF con un nombre válido.");
  check(typeof input.sha256 === "string" && hash.test(input.sha256), "La huella del PDF no es válida.");
  return { filename, sha: input.sha256 };
}

function validateProfile(input) {
  const name = typeof input.full_name === "string" ? input.full_name.trim() : "";
  check(name.length > 0 && name.length <= 120 && ["admin", "operator"].includes(input.role), "Revisa el nombre y el rol de la cuenta.");
  return name;
}

function onlyAdmin(actor) {
  check(actor.role === "admin", "Esta operación requiere el rol de administrador.", 403);
}

const listTables = {
  history: ["conversions", "id,user_id,filename,uploaded_at,processed_at", "uploaded_at.desc,id.desc"],
  users: ["profiles", profileFields, "created_at.desc,id.desc"],
  audit: ["audit_events", "id,user_id,user_name,conversion_id,event_type,details,created_at", "created_at.desc,id.desc"],
};

export function createApi({ url, publicKey, secretKey, origin, fetcher = fetch }) {
  const upstream = backend({ url, publicKey, secretKey, fetcher });
  const requests = new Map();

  function rateLimit(id) {
    const now = Date.now();
    if (requests.size >= 4096 && !requests.has(id)) {
      for (const [key, entry] of requests) if (now >= entry.until) requests.delete(key);
      check(requests.size < 4096, "El servidor está ocupado. Intenta de nuevo en unos minutos.", 429);
    }
    const entry = requests.get(id);
    if (!entry || now >= entry.until) requests.set(id, { count: 1, until: now + 60000 });
    else {
      check(entry.count < 120, "Demasiadas solicitudes. Intenta de nuevo en unos minutos.", 429);
      entry.count++;
    }
  }

  async function rpc(name, options) {
    const result = await upstream("/rest/v1/rpc/" + name, { ...options, method: "POST" });
    return Array.isArray(result) ? result[0] : result;
  }

  async function route(data, actor, token) {
    const asUser = (table, query) => upstream("/rest/v1/" + table, { token, query });
    const asServer = (name, args) => rpc(name, { service: true, body: { ...args, p_actor: actor.id } });
    const ownUpload = (sha) => asUser("conversions", {
      select: recordFields, user_id: "eq." + actor.id, sha256: "eq." + sha, limit: "1",
    });
    const conversion = async (id) => {
      check(typeof id === "string" && uuid.test(id), "La conversión no está disponible.", 404);
      const [record] = await asUser("conversions", { id: "eq." + id, select: recordFields, limit: "1" });
      check(record, "La conversión no está disponible.", 404);
      return record;
    };

    if (data.action === "session") return { user: actor, columns, default_columns: defaultColumns };
    if (Object.hasOwn(listTables, data.action)) {
      if (data.action !== "history") onlyAdmin(actor);
      const offset = data.offset ?? 0;
      check(Number.isInteger(offset) && offset >= 0 && offset <= 1000000, "La página de resultados no es válida.");
      const [table, select, order] = listTables[data.action];
      return await asUser(table, { select, order, limit: "100", offset: String(offset) });
    }
    if (data.action === "conversion") return await conversion(data.conversion_id);
    if (data.action === "lookup") {
      check(typeof data.sha256 === "string" && hash.test(data.sha256), "La huella del PDF no es válida.");
      const [existing] = await ownUpload(data.sha256);
      return existing ? { ...existing, duplicate: true } : null;
    }
    if (data.action === "register") {
      const { filename, sha } = fileInfo(data);
      const [existing] = await ownUpload(sha);
      if (existing) return { ...existing, duplicate: true };
      return await asServer("register_conversion", {
        p_filename: filename, p_sha256: sha, p_extraction: validateExtraction(data.extraction),
      });
    }
    if (data.action === "processing_failure") {
      const { filename, sha } = fileInfo(data);
      check(typeof data.reason === "string" && data.reason.trim().length > 0 && data.reason.length <= 500,
        "El diagnóstico de procesamiento no es válido.");
      await asServer("record_processing_failure", { p_filename: filename, p_sha256: sha, p_reason: data.reason });
      return null;
    }
    if (data.action === "preview" || data.action === "export") {
      check(isNumber(data.number), "Selecciona un número de salida identificado en el PDF.");
      const record = await conversion(data.conversion_id);
      const preview = buildReview(record.extraction, data);
      const digest = await previewHash(preview);
      const snapshot = {
        p_conversion_id: record.id, p_number: preview.number, p_preview_hash: digest, p_preview: preview,
      };
      if (data.action === "preview") {
        await asServer("record_review", snapshot);
      } else {
        check(data.confirmed_number === preview.number, "La confirmación debe coincidir exactamente con el número de salida.");
        check(data.preview_hash === digest, "Los datos cambiaron. Actualiza la vista previa antes de exportar.", 409);
        check(!preview.issues.some((item) => item.severity === "error"), "Corrige los errores antes de exportar.");
        check(data.accepted_reason == null || (typeof data.accepted_reason === "string" && data.accepted_reason.length <= 1000),
          "Revisa el motivo de aceptación de las advertencias.");
        const acceptance = data.accepted_reason?.trim() || null;
        check(acceptance || !preview.issues.some((item) => item.severity === "warning"),
          "Registra el motivo de aceptación de las advertencias.");
        await asServer("record_export", { ...snapshot, p_filename: `SALIDA ${preview.number}.xlsx`, p_acceptance: acceptance });
      }
      return { preview, preview_hash: digest };
    }
    if (data.action === "create_user") {
      onlyAdmin(actor);
      const name = validateProfile(data);
      const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
      check(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Correo electrónico inválido.");
      check(typeof data.password === "string" && data.password.length >= 12 && new TextEncoder().encode(data.password).length <= 72,
        "Usa una contraseña de al menos doce caracteres y como máximo 72 bytes.");
      const output = await upstream("/auth/v1/admin/users", {
        service: true, method: "POST", body: {
          email, password: data.password, email_confirm: true, user_metadata: { full_name: name },
          app_metadata: { provisioned_by: actor.id, provisioned_role: data.role },
        },
      });
      const id = output?.user?.id ?? output?.id;
      check(typeof id === "string" && uuid.test(id), "Supabase no devolvió un identificador de usuario válido.", 502);
      const [profile] = await asUser("profiles", { id: "eq." + id, select: profileFields, limit: "1" });
      return profile;
    }
    if (data.action === "update_user") {
      onlyAdmin(actor);
      check(typeof data.user_id === "string" && uuid.test(data.user_id) && typeof data.active === "boolean",
        "El perfil indicado no es válido.");
      const name = validateProfile(data);
      return await rpc("update_profile", { token, body: {
        p_target: data.user_id, p_full_name: name, p_role: data.role, p_active: data.active,
      } });
    }
    throw new ApiError(404, "Operación no disponible.");
  }

  return async (request) => {
    const suppliedOrigin = request.headers.get("Origin");
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    if (suppliedOrigin === origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    }
    const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    try {
      check(!suppliedOrigin || suppliedOrigin === origin, "Origen rechazado.", 403);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      check(request.method === "POST", "Método no permitido.", 405);
      const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        request.headers.get("Authorization") ?? "",
      )?.[1];
      check(token && token.length <= 8000, "Inicia sesión para continuar.", 401);
      const user = await upstream("/auth/v1/user", { token, authCheck: true });
      check(user?.id && uuid.test(user.id) && !user.is_anonymous, "Inicia sesión para continuar.", 401);
      rateLimit(user.id);
      const [actor] = await upstream("/rest/v1/profiles", {
        token, query: { id: "eq." + user.id, select: profileFields, limit: "1" },
      });
      check(actor?.id === user.id && actor.active && ["admin", "operator"].includes(actor.role),
        "La cuenta no tiene acceso activo al conversor.", 403);
      const data = await jsonBody(request);
      return respond(await route(data, actor, token) ?? null);
    } catch (error) {
      if (error instanceof ApiError) return respond({ detail: error.message }, error.status);
      if (error instanceof ReviewError) return respond({ detail: error.message }, 422);
      // Avoid logging request bodies, identifiers, credentials or document data.
      console.error("Error interno de conversor-api", error?.constructor?.name);
      return respond({ detail: "El servidor no pudo completar la operación." }, 500);
    }
  };
}
