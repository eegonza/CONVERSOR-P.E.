import logging
from typing import Any

import httpx

from .settings import Settings

LOGGER = logging.getLogger("conversor")


class BackendError(Exception):
    def __init__(self, status: int, code: str = ""):
        self.status = status
        self.code = code
        super().__init__(f"Supabase request failed ({status})")


class Supabase:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings = settings
        self.client = client

    async def request(
        self,
        method: str,
        path: str,
        *,
        token: str = "",
        params: dict | None = None,
        data: dict | None = None,
        admin: bool = False,
    ) -> Any:
        key = self.settings.secret_key if admin else self.settings.publishable_key
        if not (self.settings.supabase_url and key):
            raise BackendError(503, "not_configured")
        headers = {"apikey": key, "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        elif admin and not key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {key}"
        try:
            response = await self.client.request(
                method,
                self.settings.supabase_url + path,
                json=data,
                params=params,
                headers=headers,
            )
        except httpx.RequestError as error:
            raise BackendError(503, "unreachable") from error
        if response.is_error:
            try:
                payload = response.json()
                code = (
                    str(payload.get("code") or payload.get("error_code") or "")
                    if isinstance(payload, dict)
                    else ""
                )
            except ValueError:
                code = ""
            raise BackendError(response.status_code, code)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise BackendError(502, "invalid_response") from error

    async def sign_in(self, email: str, password: str) -> dict:
        return await self.request(
            "POST",
            "/auth/v1/token",
            params={"grant_type": "password"},
            data={"email": email, "password": password},
        )

    async def refresh(self, refresh_token: str) -> dict:
        return await self.request(
            "POST",
            "/auth/v1/token",
            params={"grant_type": "refresh_token"},
            data={"refresh_token": refresh_token},
        )

    async def sign_out(self, token: str) -> None:
        await self.request(
            "POST", "/auth/v1/logout", token=token, params={"scope": "local"}
        )

    async def recover(self, email: str) -> None:
        await self.request(
            "POST",
            "/auth/v1/recover",
            params={"redirect_to": self.settings.origin + "/"},
            data={"email": email},
        )

    async def reset(self, token_hash: str, password: str) -> str:
        recovery = await self.request(
            "POST",
            "/auth/v1/verify",
            data={"token_hash": token_hash, "type": "recovery"},
        )
        token = recovery["access_token"]
        user = await self.request(
            "PUT",
            "/auth/v1/user",
            token=token,
            data={"password": password},
        )
        try:
            await self.request("POST", "/auth/v1/logout", token=token)
        except BackendError as error:
            LOGGER.info(
                "No se pudo cerrar la sesión de recuperación. Estado %s", error.status
            )
        return user["id"]

    async def list(self, table: str, token: str, **params: str) -> list[dict]:
        result = await self.request(
            "GET", f"/rest/v1/{table}", token=token, params=params
        )
        if not isinstance(result, list):
            raise BackendError(502, "invalid_response")
        return result

    async def rpc(
        self, name: str, token: str = "", *, privileged: bool = False, **data: Any
    ) -> dict:
        result = await self.request(
            "POST", f"/rest/v1/rpc/{name}", token=token, data=data, admin=privileged
        )
        if isinstance(result, list) and len(result) == 1:
            result = result[0]
        if not isinstance(result, dict):
            raise BackendError(502, "invalid_response")
        return result

    async def create_user(
        self, *, email: str, password: str, full_name: str, role: str, actor: str
    ) -> dict:
        user = await self.request(
            "POST",
            "/auth/v1/admin/users",
            admin=True,
            data={
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"full_name": full_name},
                "app_metadata": {"provisioned_by": actor, "provisioned_role": role},
            },
        )
        return user.get("user", user)
