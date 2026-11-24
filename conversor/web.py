from collections.abc import Awaitable, Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class WebBoundary:
    def __init__(self, app: ASGIApp, *, origin: str, upload_bytes: int):
        self.app = app
        self.origin = origin
        self.upload_bytes = upload_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        protect = self._secure(send, self.origin.startswith("https://"))
        if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = headers.get(b"origin")
            if origin is not None and origin != self.origin.encode("ascii"):
                await JSONResponse(
                    {"detail": "Origen de la solicitud rechazado."}, status_code=403
                )(scope, receive, protect)
                return
            upload = scope["path"] == "/api/uploads"
            limit = self.upload_bytes + 64 * 1024 if upload else 2 * 1024 * 1024
            try:
                length = int(headers.get(b"content-length", b"0"))
            except ValueError:
                await JSONResponse(
                    {"detail": "Tamaño de solicitud inválido."}, status_code=400
                )(scope, receive, protect)
                return
            if length > limit:
                await self._too_large(scope, receive, protect)
                return
            received = 0
            overflow = False

            async def bounded_receive() -> Message:
                nonlocal received, overflow
                chunk = await receive()
                received += len(chunk.get("body", b""))
                if received > limit:
                    overflow = True
                    return {"type": "http.disconnect"}
                return chunk

            response_started = False

            async def safe_send(message: Message) -> None:
                nonlocal response_started
                if overflow:
                    if not response_started:
                        response_started = True
                        await self._too_large(scope, receive, protect)
                    return
                if message["type"] == "http.response.start":
                    response_started = True
                await protect(message)

            await self.app(scope, bounded_receive, safe_send)
            return
        await self.app(scope, receive, protect)

    @staticmethod
    async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse(
            {"detail": "El archivo o la solicitud excede el tamaño permitido."},
            status_code=413,
        )(scope, receive, send)

    @staticmethod
    def _secure(
        send: Send, secure_cookie: bool
    ) -> Callable[[Message], Awaitable[None]]:
        async def secure_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(
                    [
                        (b"cache-control", b"no-store"),
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"x-frame-options", b"SAMEORIGIN"),
                        (
                            b"permissions-policy",
                            b"camera=(), microphone=(), geolocation=()",
                        ),
                        (
                            b"content-security-policy",
                            b"default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; frame-src 'self' blob:; img-src 'self' blob: data:",
                        ),
                    ]
                )
                if secure_cookie:
                    headers.append((b"strict-transport-security", b"max-age=31536000"))
                message = {**message, "headers": headers}
            await send(message)

        return secure_send
