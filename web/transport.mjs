import { createClient } from "@supabase/supabase-js";

const projectUrl = CONVERSOR_SUPABASE_URL;
const publishableKey = CONVERSOR_PUBLISHABLE_KEY;
const supabase = publishableKey ? createClient(projectUrl, publishableKey, {
  auth: { autoRefreshToken: true, detectSessionInUrl: false, persistSession: false },
}) : null;
const workbookType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const maxPdfBytes = 20 * 1024 * 1024;

class HostedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireConfig() {
  if (!supabase) throw new HostedError(503, "Configura la clave publicable de Supabase en el sitio para iniciar sesión.");
}

async function sessionToken() {
  const { data, error } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (error || !token) throw new HostedError(401, "Inicia sesión para continuar.");
  return token;
}

async function execute(action, payload = {}, signal) {
  requireConfig();
  const token = await sessionToken();
  let response;
  try {
    response = await fetch(projectUrl + "/functions/v1/conversor-api", {
      method: "POST", credentials: "omit", cache: "no-store", signal,
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ ...payload, action }),
    });
  } catch (error) {
    if (signal?.aborted) throw new HostedError(400, "Procesamiento cancelado.");
    throw new HostedError(503, "No se pudo conectar con el backend del conversor.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = response.status === 404
      ? "Despliega la función conversor-api en el proyecto de Supabase."
      : "El servidor no pudo completar la solicitud.";
    const detail = typeof result?.detail === "string" ? result.detail : fallback;
    throw new HostedError(response.status, detail);
  }
  return result;
}

async function authRequest(path, data) {
  if (path === "/api/auth/login") {
    const result = await supabase.auth.signInWithPassword({ email: data.email, password: data.password });
    if (result.error) {
      const limited = result.error.status === 429;
      throw new HostedError(limited ? 429 : 401, limited
        ? "Demasiados intentos. Intenta de nuevo en unos minutos."
        : "Correo o contraseña incorrectos, o cuenta sin confirmar.");
    }
    try {
      return await execute("session");
    } catch (error) {
      await supabase.auth.signOut({ scope: "local" });
      throw error;
    }
  }
  if (path === "/api/auth/logout") {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error && error.status !== 401) throw new HostedError(error.status ?? 503, "No se pudo cerrar la sesión.");
    return null;
  }
  if (path === "/api/auth/recover") {
    const redirectTo = new URL("./", window.location.href).href;
    const { error } = await supabase.auth.resetPasswordForEmail(data.email, { redirectTo });
    if (error && ![400, 404, 422].includes(error.status)) {
      throw new HostedError(error.status ?? 503, "El servicio de recuperación no está disponible en este momento.");
    }
    return null;
  }
  if (path === "/api/auth/reset") {
    const result = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: "recovery" });
    if (result.error) throw new HostedError(422, "El enlace de recuperación ya no es válido.");
    const { error } = await supabase.auth.updateUser({ password: data.password });
    if (error) throw new HostedError(422, "Supabase rechazó el cambio de contraseña.");
    await supabase.auth.signOut({ scope: "local" });
    return null;
  }
  throw new HostedError(404, "Operación de acceso no disponible.");
}

function runWorker(action, payload, { signal, onStage } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HostedError(400, "Procesamiento cancelado."));
      return;
    }
    const workerURL = new URL("./runtime-worker.mjs", import.meta.url);
    workerURL.search = new URL(import.meta.url).search;
    const worker = new Worker(workerURL, { type: "module" });
    function finish(error, value) {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    }
    function cancel() {
      finish(new HostedError(400, "Procesamiento cancelado."));
    }
    const timeout = window.setTimeout(() => finish(new HostedError(422,
      "El procesamiento superó el tiempo permitido en este navegador.")), 60000);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.addEventListener("error", () => finish(new HostedError(503, "No se pudieron iniciar las herramientas de conversión.")));
    worker.addEventListener("message", ({ data }) => {
      if (data?.stage) onStage?.(data.stage);
      else if (data?.error) finish(new HostedError(422, data.error));
      else if (data && Object.hasOwn(data, "value")) finish(null, data.value);
      else finish(new HostedError(422, "El conversor devolvió datos inválidos."));
    });
    worker.postMessage({ action, payload }, payload instanceof ArrayBuffer ? [payload] : []);
  });
}

async function upload(file, { signal, onStage } = {}) {
  if (file.size > maxPdfBytes) throw new HostedError(413, "El PDF supera el límite de 20 MiB.");
  onStage?.("reading");
  const bytes = await file.arrayBuffer();
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new HostedError(422, "El contenido del archivo no tiene un encabezado PDF válido.");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
  const existing = await execute("lookup", { sha256 }, signal);
  if (existing) return existing;
  let extraction;
  try {
    extraction = await runWorker("extract", bytes, { signal, onStage });
  } catch (error) {
    if (!signal?.aborted && error.status === 422) {
      await execute("processing_failure", { filename: file.name, sha256, reason: error.message }, signal).catch(() => {});
    }
    throw error;
  }
  onStage?.("saving");
  return await execute("register", { filename: file.name, sha256, extraction }, signal);
}

async function request(path, { method, body } = {}) {
  requireConfig();
  if (path.startsWith("/api/auth/")) return await authRequest(path, body);
  const url = new URL(path, window.location.origin);
  if (url.pathname === "/api/session") return await execute("session");
  const lists = { "/api/conversions": "history", "/api/audit": "audit", "/api/users": "users" };
  if (url.pathname === "/api/users" && method === "POST") return await execute("create_user", body);
  if (Object.hasOwn(lists, url.pathname)) {
    return await execute(lists[url.pathname], { offset: Number(url.searchParams.get("offset") || 0) });
  }
  const conversion = /^\/api\/conversions\/([0-9a-f-]+)(?:\/(preview|export))?$/i.exec(url.pathname);
  if (conversion) {
    const [, conversion_id, action = "conversion"] = conversion;
    const result = await execute(action, { ...body, conversion_id });
    if (action !== "export") return result;
    const workbook = await runWorker("xlsx", result.preview);
    return new Blob([workbook], { type: workbookType });
  }
  const profile = /^\/api\/users\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (profile && method === "PATCH") return await execute("update_user", { ...body, user_id: profile[1] });
  throw new HostedError(404, "Operación no disponible.");
}

globalThis.conversorHosted = { request, upload };
await import("../conversor/static/app.js");
