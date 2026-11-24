import { createApi } from "./api.mjs";

function projectKey(dictionary: string, legacy: string): string {
  const encoded = Deno.env.get(dictionary);
  if (encoded) {
    try {
      const keys = JSON.parse(encoded);
      if (typeof keys.default === "string" && keys.default) return keys.default;
    } catch {
      // Local or older runtimes can use the injected legacy credentials.
    }
  }
  return Deno.env.get(legacy) ?? "";
}

Deno.serve(createApi({
  url: Deno.env.get("SUPABASE_URL") ?? "",
  publicKey: projectKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
  secretKey: projectKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
  origin: Deno.env.get("CONVERSOR_WEB_ORIGIN") ?? "https://eegonza.github.io",
}));
