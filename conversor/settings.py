from dataclasses import dataclass
from os import environ
from urllib.parse import urlsplit

from dotenv import load_dotenv

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def checked_url(value: str, *, origin_only: bool) -> str:
    url = urlsplit(value)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username:
        raise ValueError("La dirección debe ser una URL HTTP(S) válida.")
    if url.scheme == "http" and url.hostname not in LOOPBACK:
        raise ValueError("HTTP solo se permite en la interfaz local.")
    if url.query or url.fragment or (origin_only and url.path not in {"", "/"}):
        raise ValueError(
            "La dirección no puede contener una ruta, consulta o fragmento adicional."
        )
    url.port  # Validate malformed port values at startup.
    return value.rstrip("/")


def limit(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(environ.get(name, default))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} debe estar entre {minimum} y {maximum}.")
    return value


@dataclass(frozen=True)
class Settings:
    origin: str = "http://127.0.0.1:8000"
    supabase_url: str = ""
    publishable_key: str = ""
    secret_key: str = ""
    max_pdf_bytes: int = 20 * 1024 * 1024
    max_pdf_pages: int = 100
    pdf_timeout: int = 40

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        supabase_url = environ.get("SUPABASE_URL", "").strip()
        return cls(
            origin=checked_url(
                environ.get("APP_ORIGIN", cls.origin).strip(), origin_only=True
            ),
            supabase_url=checked_url(supabase_url, origin_only=True)
            if supabase_url
            else "",
            publishable_key=(
                environ.get("SUPABASE_PUBLISHABLE_KEY")
                or environ.get("SUPABASE_ANON_KEY", "")
            ).strip(),
            secret_key=(
                environ.get("SUPABASE_SECRET_KEY")
                or environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
            ).strip(),
            max_pdf_bytes=limit(
                "PDF_MAX_BYTES", cls.max_pdf_bytes, 1024, 32 * 1024 * 1024
            ),
            max_pdf_pages=limit("PDF_MAX_PAGES", cls.max_pdf_pages, 1, 300),
            pdf_timeout=limit("PDF_TIMEOUT", cls.pdf_timeout, 1, 120),
        )

    @property
    def secure_cookie(self) -> bool:
        return self.origin.startswith("https://")

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.publishable_key and self.secret_key)

    @property
    def allowed_hosts(self) -> list[str]:
        host = urlsplit(self.origin).hostname
        return sorted(LOOPBACK | {host}) if host in LOOPBACK else [host]
