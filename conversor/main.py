import asyncio
import hashlib
import json
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.datastructures import UploadFile
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .export import (
    COLUMN_LABELS,
    DEFAULT_COLUMNS,
    ReviewError,
    build_preview,
    write_excel,
)
from .session import RateLimiter, Session, Sessions
from .settings import Settings
from .supabase import BackendError, Supabase
from .web import WebBoundary

LOGGER = logging.getLogger("conversor")
ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
COOKIE = "conversor_session"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
SHA256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Number = Annotated[str, Field(pattern=r"^[0-9]{1,40}$")]
Role = Literal["admin", "operator"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmailInput(Input):
    email: Annotated[str, Field(max_length=254)]

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL.fullmatch(value):
            raise ValueError("Correo inválido.")
        return value


class LoginInput(EmailInput):
    password: Annotated[str, Field(min_length=1, max_length=1024)]


def valid_password(value: str) -> str:
    if len(value.encode("utf-8")) > 72:
        raise ValueError("La contraseña no puede exceder 72 bytes.")
    return value


class PasswordInput(Input):
    token_hash: Annotated[str, Field(min_length=12, max_length=1024)]
    password: Annotated[str, Field(min_length=12, max_length=72)]

    _validate_password = field_validator("password")(valid_password)


class NewUser(EmailInput):
    full_name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    role: Role
    password: Annotated[str, Field(min_length=12, max_length=72)]

    _validate_password = field_validator("password")(valid_password)


class EditUser(Input):
    full_name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    role: Role
    active: bool


class ReviewInput(Input):
    number: Number
    edits: Annotated[dict[str, dict[str, str | None]], Field(max_length=20000)] = Field(
        default_factory=dict
    )
    exclude_ids: Annotated[list[str], Field(max_length=20000)] = Field(
        default_factory=list
    )
    columns: Annotated[list[str], Field(min_length=1, max_length=len(COLUMN_LABELS))]


class ExportInput(ReviewInput):
    preview_hash: SHA256
    confirmed_number: Number
    accepted_reason: Annotated[str | None, Field(max_length=1000)] = None


@dataclass
class Actor:
    profile: dict
    session: Session
    token: str

    @property
    def is_admin(self) -> bool:
        return self.profile["role"] == "admin"


def http_error(error: BackendError) -> HTTPException:
    if error.code == "not_configured":
        return HTTPException(
            503, "Configura la conexión con Supabase en el archivo .env."
        )
    if error.code == "P0002" or error.status == 404:
        return HTTPException(404, "El registro no está disponible.")
    if error.code == "23505" or error.status == 409:
        return HTTPException(409, "Ya existe un registro con estos datos.")
    if error.code == "22023":
        return HTTPException(
            422, "La operación contiene datos inválidos o no permitidos."
        )
    if error.code == "42501" or error.status in {401, 403}:
        return HTTPException(403, "No tienes permiso para realizar esta operación.")
    if error.status == 429:
        return HTTPException(429, "Demasiadas solicitudes. Intenta de nuevo más tarde.")
    if 400 <= error.status < 500:
        return HTTPException(422, "Supabase rechazó los datos de la operación.")
    return HTTPException(503, "No se pudo completar la operación en Supabase.")


def limited(
    limiter: RateLimiter,
    request: Request,
    action: str,
    limit: int,
    seconds: int,
    identity: str = "",
) -> None:
    client = request.client.host if request.client else "unknown"
    wait = limiter.hit(action, identity or client, limit, seconds)
    if wait:
        raise HTTPException(
            429,
            "Demasiadas solicitudes. Intenta de nuevo en unos minutos.",
            headers={"Retry-After": str(wait)},
        )


def safe_filename(value: str) -> str:
    value = value.replace("\\", "/").rsplit("/", 1)[-1]
    return "".join(char for char in value if char.isprintable()).strip()


async def extract_in_worker(
    data: bytes, settings: Settings, slots: asyncio.Semaphore
) -> dict:
    try:
        await asyncio.wait_for(slots.acquire(), timeout=10)
    except TimeoutError as error:
        raise HTTPException(
            503, "Hay otros PDF en proceso. Intenta de nuevo en unos segundos."
        ) from error
    try:
        env = {"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
        if "SYSTEMROOT" in os.environ:
            env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        worker = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "conversor.pdf_worker",
            str(settings.max_pdf_pages),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=ROOT,
            env=env,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                worker.communicate(data), timeout=settings.pdf_timeout
            )
        except (TimeoutError, asyncio.CancelledError):
            if worker.returncode is None:
                try:
                    worker.kill()
                except ProcessLookupError:
                    pass
            await worker.wait()
            if not asyncio.current_task().cancelling():
                raise HTTPException(
                    422, "El PDF excedió el tiempo de procesamiento permitido."
                ) from None
            raise
        try:
            result = json.loads(stdout)
        except (ValueError, UnicodeError):
            raise HTTPException(
                422, "El PDF no se pudo procesar dentro de los límites permitidos."
            ) from None
        if not isinstance(result, dict):
            raise HTTPException(422, "El PDF no se pudo interpretar.")
        if worker.returncode or "error" in result:
            raise HTTPException(
                422, str(result.get("error") or "El PDF no se pudo interpretar.")[:500]
            )
        return result
    finally:
        slots.release()


def make_preview(extraction: dict, data: ReviewInput) -> tuple[dict, str]:
    for document in extraction.get("documents", []):
        if document.get("number") == data.number:
            break
    else:
        raise HTTPException(
            422, "Selecciona un número de salida identificado en el PDF."
        )
    try:
        preview = build_preview(
            document,
            edits=data.edits,
            exclude_ids=data.exclude_ids,
            columns=data.columns,
        )
    except ReviewError as error:
        raise HTTPException(422, str(error)) from error
    for issue in extraction.get("issues", []):
        if issue not in preview["issues"]:
            preview["issues"].insert(0, issue)
    content = json.dumps(
        preview, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return preview, hashlib.sha256(content.encode("utf-8")).hexdigest()


def create_app(
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    sessions = Sessions()
    limiter = RateLimiter()
    slots = asyncio.Semaphore(2)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(
            timeout=20.0, transport=transport, follow_redirects=False
        ) as client:
            app.state.backend = Supabase(settings, client)
            yield

    app = FastAPI(
        title="Conversor de salidas de producto",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(
        WebBoundary, origin=settings.origin, upload_bytes=settings.max_pdf_bytes
    )
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts, www_redirect=False
    )
    app.mount("/static", StaticFiles(directory=STATIC, check_dir=False), name="static")

    def backend(request: Request) -> Supabase:
        return request.app.state.backend

    def configured() -> None:
        if not settings.supabase_configured:
            raise HTTPException(
                503, "Configura la conexión con Supabase en el archivo .env."
            )

    async def profile_for(service: Supabase, token: str, user_id: str) -> dict:
        profiles = await service.list(
            "profiles",
            token,
            id=f"eq.{user_id}",
            select="id,email,full_name,role,active",
        )
        if (
            not profiles
            or not profiles[0]["active"]
            or profiles[0]["role"] not in {"operator", "admin"}
        ):
            raise HTTPException(403, "La cuenta no tiene acceso activo al conversor.")
        return profiles[0]

    async def require_actor(request: Request) -> Actor:
        configured()
        key = request.cookies.get(COOKIE, "")
        session = sessions.get(key)
        if session is None:
            raise HTTPException(401, "Inicia sesión para continuar.")
        if request.method not in {"GET", "HEAD"} and not session.accepts_csrf(
            request.headers.get("x-csrf-token", "")
        ):
            raise HTTPException(
                403,
                "La verificación de seguridad de la solicitud falló. Recarga la página.",
            )
        service = backend(request)
        try:
            token = await session.access(service)
            profile = await profile_for(service, token, session.user_id)
        except BackendError as error:
            if error.status in {400, 401, 403}:
                sessions.remove(key)
                raise HTTPException(
                    401, "La sesión expiró. Inicia sesión de nuevo."
                ) from error
            raise
        session.last_seen = monotonic()
        return Actor(profile, session, token)

    async def require_admin(actor: Annotated[Actor, Depends(require_actor)]) -> Actor:
        if not actor.is_admin:
            raise HTTPException(403, "Esta operación requiere el rol de administrador.")
        return actor

    def session_json(actor: Actor) -> dict:
        return {
            "user": actor.profile,
            "csrf": actor.session.csrf,
            "columns": COLUMN_LABELS,
            "default_columns": DEFAULT_COLUMNS,
        }

    async def conversion_for(
        service: Supabase, actor: Actor, conversion_id: UUID
    ) -> dict:
        result = await service.list(
            "conversions",
            actor.token,
            id=f"eq.{conversion_id}",
            select="id,filename,uploaded_at,processed_at,extraction",
        )
        if not result:
            raise HTTPException(404, "La conversión no está disponible.")
        return result[0]

    @app.exception_handler(BackendError)
    async def backend_failed(_: Request, error: BackendError) -> JSONResponse:
        response = http_error(error)
        return JSONResponse(
            {"detail": response.detail}, status_code=response.status_code
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(
        _: Request, error: RequestValidationError
    ) -> JSONResponse:
        fields = [{"loc": item["loc"], "type": item["type"]} for item in error.errors()]
        return JSONResponse(
            {"detail": "Revisa los campos de la solicitud.", "fields": fields},
            status_code=422,
        )

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "supabase_configured": settings.supabase_configured,
        }

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/session")
    async def session(actor: Annotated[Actor, Depends(require_actor)]):
        return session_json(actor)

    @app.post("/api/auth/login")
    async def login(data: LoginInput, request: Request, response: Response):
        configured()
        limited(limiter, request, "login", 10, 900)
        service = backend(request)
        try:
            signed = await service.sign_in(data.email, data.password)
        except BackendError as error:
            if error.status in {400, 401, 403, 422}:
                raise HTTPException(
                    401, "Correo o contraseña incorrectos, o cuenta sin confirmar."
                ) from error
            raise
        profile = await profile_for(
            service, signed["access_token"], signed["user"]["id"]
        )
        sessions.remove(request.cookies.get(COOKIE, ""))
        key, new_session = sessions.new(signed)
        response.set_cookie(
            COOKIE,
            key,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            max_age=8 * 3600,
        )
        return session_json(Actor(profile, new_session, signed["access_token"]))

    @app.post("/api/auth/logout", status_code=204)
    async def logout(request: Request):
        key = request.cookies.get(COOKIE, "")
        session = sessions.get(key)
        if session:
            if not session.accepts_csrf(request.headers.get("x-csrf-token", "")):
                raise HTTPException(
                    403, "La verificación de seguridad de la solicitud falló."
                )
            sessions.remove(key)
            try:
                service = backend(request)
                await service.sign_out(await session.access(service))
            except BackendError as error:
                LOGGER.info(
                    "No se pudo revocar la sesión remota. Estado %s", error.status
                )
        response = Response(status_code=204)
        response.delete_cookie(
            COOKIE, httponly=True, secure=settings.secure_cookie, samesite="strict"
        )
        return response

    @app.post("/api/auth/recover")
    async def recover(data: EmailInput, request: Request):
        configured()
        limited(limiter, request, "recover", 5, 900)
        try:
            await backend(request).recover(data.email)
        except BackendError as error:
            if error.status not in {400, 404, 422}:
                raise
        return {
            "message": "Si el correo está registrado, recibirás un enlace de recuperación."
        }

    @app.post("/api/auth/reset")
    async def reset(data: PasswordInput, request: Request, response: Response):
        configured()
        limited(limiter, request, "reset", 5, 900)
        try:
            user_id = await backend(request).reset(data.token_hash, data.password)
        except BackendError as error:
            if error.status in {400, 401, 403, 422}:
                raise HTTPException(
                    422,
                    "El enlace o la contraseña ya no son válidos. Solicita un enlace nuevo si expiró.",
                ) from error
            raise
        sessions.remove_user(user_id)
        response.delete_cookie(
            COOKIE, httponly=True, secure=settings.secure_cookie, samesite="strict"
        )
        return {
            "message": "Contraseña actualizada. Inicia sesión con tu nueva contraseña."
        }

    @app.post("/api/uploads", status_code=201)
    async def upload(request: Request, actor: Annotated[Actor, Depends(require_actor)]):
        limited(limiter, request, "upload", 12, 60, actor.profile["id"])
        async with request.form(max_files=1, max_fields=0) as form:
            uploaded_at = datetime.now(UTC).isoformat()
            file = form.get("file")
            if not isinstance(file, UploadFile):
                raise HTTPException(422, "Selecciona un archivo PDF.")
            name = safe_filename(file.filename or "")
            if not name.lower().endswith(".pdf") or len(name) > 255:
                raise HTTPException(
                    422, "Selecciona un archivo PDF con un nombre válido."
                )
            data = await file.read(settings.max_pdf_bytes + 1)
        if len(data) > settings.max_pdf_bytes:
            raise HTTPException(413, "El PDF supera el tamaño máximo configurado.")
        if not data.startswith(b"%PDF-"):
            raise HTTPException(
                422, "El contenido del archivo no tiene un encabezado PDF válido."
            )
        service = backend(request)
        sha = hashlib.sha256(data).hexdigest()
        previous = await service.list(
            "conversions",
            actor.token,
            user_id=f"eq.{actor.profile['id']}",
            sha256=f"eq.{sha}",
            select="id,filename,uploaded_at,processed_at,extraction,sha256",
            limit="1",
        )
        if previous:
            return JSONResponse({**previous[0], "duplicate": True}, status_code=200)
        try:
            extraction = await extract_in_worker(data, settings, slots)
        except HTTPException as error:
            if error.status_code == 422:
                try:
                    await service.rpc(
                        "record_processing_failure",
                        privileged=True,
                        p_actor=actor.profile["id"],
                        p_filename=name,
                        p_sha256=sha,
                        p_reason=str(error.detail),
                    )
                except BackendError as backend_error:
                    LOGGER.info(
                        "No se pudo registrar el procesamiento fallido. Estado %s",
                        backend_error.status,
                    )
            raise
        return await service.rpc(
            "register_conversion",
            privileged=True,
            p_actor=actor.profile["id"],
            p_filename=name,
            p_sha256=sha,
            p_extraction=extraction,
            p_uploaded_at=uploaded_at,
        )

    @app.get("/api/conversions")
    async def conversions(
        request: Request,
        actor: Annotated[Actor, Depends(require_actor)],
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return await backend(request).list(
            "conversions",
            actor.token,
            select="id,user_id,filename,uploaded_at,processed_at",
            order="uploaded_at.desc,id.desc",
            limit="100",
            offset=str(offset),
        )

    @app.get("/api/conversions/{conversion_id}")
    async def conversion(
        conversion_id: UUID,
        request: Request,
        actor: Annotated[Actor, Depends(require_actor)],
    ):
        return await conversion_for(backend(request), actor, conversion_id)

    @app.post("/api/conversions/{conversion_id}/preview")
    async def review(
        conversion_id: UUID,
        data: ReviewInput,
        request: Request,
        actor: Annotated[Actor, Depends(require_actor)],
    ):
        limited(limiter, request, "review", 40, 60, actor.profile["id"])
        service = backend(request)
        record = await conversion_for(service, actor, conversion_id)
        preview, digest = make_preview(record["extraction"], data)
        await service.rpc(
            "record_review",
            privileged=True,
            p_actor=actor.profile["id"],
            p_conversion_id=str(conversion_id),
            p_number=data.number,
            p_preview_hash=digest,
            p_preview=preview,
        )
        return {"preview": preview, "preview_hash": digest}

    @app.post("/api/conversions/{conversion_id}/export")
    async def export(
        conversion_id: UUID,
        data: ExportInput,
        request: Request,
        actor: Annotated[Actor, Depends(require_actor)],
    ):
        limited(limiter, request, "export", 12, 60, actor.profile["id"])
        if data.confirmed_number != data.number:
            raise HTTPException(
                422,
                "La confirmación debe coincidir exactamente con el número de salida.",
            )
        service = backend(request)
        record = await conversion_for(service, actor, conversion_id)
        preview, digest = make_preview(record["extraction"], data)
        if digest != data.preview_hash:
            raise HTTPException(
                409,
                "Los datos cambiaron. Genera una nueva vista previa antes de exportar.",
            )
        if any(issue.get("severity") == "error" for issue in preview["issues"]):
            raise HTTPException(
                422,
                "La vista previa contiene errores críticos que bloquean la exportación.",
            )
        reason = (data.accepted_reason or "").strip() or None
        if (
            any(issue.get("severity") == "warning" for issue in preview["issues"])
            and not reason
        ):
            raise HTTPException(
                422,
                "Registra el motivo de aceptación de las advertencias para continuar.",
            )
        filename = f"SALIDA {data.number}.xlsx"
        try:
            contents = await asyncio.to_thread(write_excel, preview)
        except ReviewError as error:
            raise HTTPException(422, str(error)) from error
        await service.rpc(
            "record_export",
            privileged=True,
            p_actor=actor.profile["id"],
            p_conversion_id=str(conversion_id),
            p_number=data.number,
            p_filename=filename,
            p_preview_hash=digest,
            p_preview=preview,
            p_acceptance=reason,
        )
        return Response(
            contents,
            media_type=XLSX,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/audit")
    async def audit(
        request: Request,
        actor: Annotated[Actor, Depends(require_admin)],
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return await backend(request).list(
            "audit_events",
            actor.token,
            select="id,user_id,user_name,conversion_id,event_type,details,created_at",
            order="created_at.desc,id.desc",
            limit="100",
            offset=str(offset),
        )

    @app.get("/api/users")
    async def users(
        request: Request,
        actor: Annotated[Actor, Depends(require_admin)],
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return await backend(request).list(
            "profiles",
            actor.token,
            select="id,email,full_name,role,active,created_at",
            order="created_at.desc,id.desc",
            limit="100",
            offset=str(offset),
        )

    @app.post("/api/users", status_code=201)
    async def create_user(
        data: NewUser, request: Request, actor: Annotated[Actor, Depends(require_admin)]
    ):
        limited(limiter, request, "create_user", 10, 60, actor.profile["id"])
        service = backend(request)
        created = await service.create_user(
            email=data.email,
            password=data.password,
            full_name=data.full_name.strip(),
            role=data.role,
            actor=actor.profile["id"],
        )
        return await profile_for(service, actor.token, created["id"])

    @app.patch("/api/users/{user_id}")
    async def update_user(
        user_id: UUID,
        data: EditUser,
        request: Request,
        actor: Annotated[Actor, Depends(require_admin)],
    ):
        return await backend(request).rpc(
            "update_profile",
            actor.token,
            p_target=str(user_id),
            p_full_name=data.full_name.strip(),
            p_role=data.role,
            p_active=data.active,
        )

    return app


app = create_app()
