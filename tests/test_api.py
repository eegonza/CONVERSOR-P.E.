import asyncio
import json
from io import BytesIO
from uuid import UUID

import httpx
from openpyxl import load_workbook

from conversor import main
from conversor.settings import Settings

ORIGIN = "http://127.0.0.1:8000"
OPERATOR = str(UUID(int=1))
OTHER_OPERATOR = str(UUID(int=2))
ADMIN = str(UUID(int=3))
CONVERSION = str(UUID(int=10))
SETTINGS = Settings(
    origin=ORIGIN,
    supabase_url="https://supabase.invalid",
    publishable_key="public-test-key",
    secret_key="server-test-key",
)


def source_document():
    return {
        "page_count": 1,
        "documents": [
            {
                "number": "000458",
                "pages": [1],
                "header": {},
                "rows": [
                    {
                        "id": "p1-r1",
                        "page": 1,
                        "line": 1,
                        "code": "00123456",
                        "description": "ARTÍCULO DEMO",
                        "package": None,
                        "style": None,
                        "descriptor": None,
                        "reference": "0090",
                        "tax_class": "E",
                        "tax_rate": None,
                        "units": "2.00",
                        "cost": "0.00",
                        "sale_price": "7.00",
                        "outbound_total": None,
                        "inbound_units": None,
                        "inbound_total": None,
                    }
                ],
                "printed_totals": {
                    "outbound": {"subtotal": "0.00", "tax": "0.00", "net": "0.00"},
                    "inbound": {"subtotal": "0.00", "tax": "0.00", "net": "0.00"},
                },
                "issues": [],
            }
        ],
        "issues": [],
    }


class FakeSupabase:
    def __init__(self):
        self.profiles = {
            uid: {
                "id": uid,
                "email": email,
                "full_name": name,
                "role": role,
                "active": True,
            }
            for uid, email, name, role in [
                (OPERATOR, "operator@example.test", "Operador", "operator"),
                (OTHER_OPERATOR, "other@example.test", "Otro", "operator"),
                (ADMIN, "admin@example.test", "Administrador", "admin"),
            ]
        }
        self.registered = None
        self.events = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["apikey"] in {"public-test-key", "server-test-key"}
        path, query = request.url.path, request.url.params
        data = json.loads(request.content) if request.content else {}
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if path == "/auth/v1/token":
            profile = next(
                (
                    value
                    for value in self.profiles.values()
                    if value["email"] == data.get("email")
                ),
                None,
            )
            if profile is None or data.get("password") != "password-for-testing":
                return httpx.Response(400, json={"error_code": "invalid_credentials"})
            return httpx.Response(
                200,
                json={
                    "access_token": profile["id"],
                    "refresh_token": "stub",
                    "expires_in": 3600,
                    "user": profile,
                },
            )
        if path == "/auth/v1/logout":
            return httpx.Response(204)
        if path == "/auth/v1/recover":
            assert query["redirect_to"] == ORIGIN + "/"
            assert data["email"] == self.profiles[OPERATOR]["email"]
            return httpx.Response(200, json={})
        if path == "/auth/v1/verify":
            assert data["type"] == "recovery"
            if data["token_hash"] != "recovery-token-fixture":
                return httpx.Response(403, json={"error_code": "otp_expired"})
            return httpx.Response(200, json={"access_token": OPERATOR})
        if path == "/auth/v1/user" and request.method == "PUT":
            assert token == OPERATOR
            assert data["password"] == "changed-password-fixture"
            return httpx.Response(200, json=self.profiles[OPERATOR])
        if path == "/rest/v1/profiles":
            assert token in self.profiles
            selected = query.get("id", "").removeprefix("eq.")
            is_admin = self.profiles[token]["role"] == "admin"
            allowed = [
                value
                for uid, value in self.profiles.items()
                if (not selected or selected == uid) and (is_admin or token == uid)
            ]
            return httpx.Response(200, json=allowed)
        if path == "/rest/v1/conversions":
            allowed = self.registered and (
                self.registered["user_id"] == token
                or self.profiles[token]["role"] == "admin"
            )
            return httpx.Response(200, json=[self.registered] if allowed else [])
        if path == "/rest/v1/rpc/register_conversion":
            assert token == "server-test-key"
            assert data["p_actor"] == OPERATOR
            assert data["p_uploaded_at"].endswith("+00:00")
            self.registered = {
                "id": CONVERSION,
                "user_id": data["p_actor"],
                "filename": data["p_filename"],
                "sha256": data["p_sha256"],
                "extraction": data["p_extraction"],
            }
            return httpx.Response(200, json=self.registered)
        if path in {"/rest/v1/rpc/record_review", "/rest/v1/rpc/record_export"}:
            assert token == "server-test-key"
            assert data["p_actor"] == OPERATOR
            self.events.append(data)
            return httpx.Response(200, json={"id": len(self.events)})
        if path == "/rest/v1/audit_events":
            assert token == ADMIN
            return httpx.Response(200, json=[])
        raise AssertionError(f"Unexpected Supabase route {path}")


async def sign_in(browser, email="operator@example.test"):
    result = await browser.post(
        "/api/auth/login", json={"email": email, "password": "password-for-testing"}
    )
    assert result.status_code == 200, result.text
    assert "httponly" in result.headers["set-cookie"].lower()
    assert "samesite=strict" in result.headers["set-cookie"].lower()
    assert "access_token" not in result.json()
    return result.json()


def test_operator_upload_review_export_and_access(monkeypatch):
    fake = FakeSupabase()
    count = 0

    async def parse(_data, _settings, _slots):
        nonlocal count
        count += 1
        return source_document()

    monkeypatch.setattr(main, "extract_in_worker", parse)
    app = main.create_app(SETTINGS, transport=httpx.MockTransport(fake))

    async def flow():
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url=ORIGIN
            ) as browser,
        ):
            assert (
                await browser.post("/api/uploads", content=b"malformado")
            ).status_code == 401
            session = await sign_in(browser)
            defaults = session["default_columns"]
            assert defaults.index("units") + 1 == defaults.index("cost")
            files = {"file": ("demo.pdf", b"%PDF-1.4\nfixture", "application/pdf")}
            assert (await browser.post("/api/uploads", files=files)).status_code == 403
            csrf = {"X-CSRF-Token": session["csrf"]}
            upload = await browser.post("/api/uploads", files=files, headers=csrf)
            assert upload.status_code == 201, upload.text
            assert upload.json()["id"] == CONVERSION
            duplicate = await browser.post("/api/uploads", files=files, headers=csrf)
            assert duplicate.status_code == 200
            assert duplicate.json()["duplicate"] is True
            assert count == 1
            assert (await browser.get("/api/audit")).status_code == 403
            assert (await browser.get("/api/users")).status_code == 403

            endpoint = f"/api/conversions/{CONVERSION}"
            selection = {
                "number": "000458",
                "columns": ["code", "reference", "units", "cost", "outbound_total"],
                "edits": {"p1-r1": {"reference": "0012"}},
            }
            review = await browser.post(
                endpoint + "/preview", json=selection, headers=csrf
            )
            assert review.status_code == 200, review.text
            result = review.json()
            approval = {
                **selection,
                "preview_hash": result["preview_hash"],
                "confirmed_number": "000458",
            }
            wrong = await browser.post(
                endpoint + "/export",
                json={**approval, "confirmed_number": "458"},
                headers=csrf,
            )
            assert wrong.status_code == 422
            warning = await browser.post(
                endpoint + "/export", json=approval, headers=csrf
            )
            assert warning.status_code == 422
            changed = {
                **approval,
                "columns": selection["columns"][::-1],
                "accepted_reason": "Total vacío tal como figura en el documento.",
            }
            assert (
                await browser.post(endpoint + "/export", json=changed, headers=csrf)
            ).status_code == 409
            export = await browser.post(
                endpoint + "/export",
                json={**approval, "accepted_reason": changed["accepted_reason"]},
                headers=csrf,
            )
            assert export.status_code == 200, export.text[:1000]
            assert (
                export.headers["content-disposition"]
                == 'attachment; filename="SALIDA 000458.xlsx"'
            )
            workbook = load_workbook(BytesIO(export.content))
            sheet = workbook.active
            assert [c.value for c in sheet[1]] == [
                session["columns"][k] for k in selection["columns"]
            ]
            assert [c.value for c in sheet[2]] == ["00123456", "0012", 2, 0, None]
            assert sheet["A2"].data_type == sheet["B2"].data_type == "s"
            assert len(sheet.tables) == 1
            assert fake.events[0]["p_preview"] == fake.events[1]["p_preview"]
            assert fake.events[1]["p_acceptance"] == changed["accepted_reason"]

            assert (
                await browser.post("/api/auth/logout", headers=csrf)
            ).status_code == 204
            assert (await browser.get("/api/session")).status_code == 401
            await sign_in(browser, "other@example.test")
            assert (await browser.get(endpoint)).status_code == 404
            await sign_in(browser, "admin@example.test")
            assert (await browser.get(endpoint)).status_code == 200
            assert (await browser.get("/api/audit")).status_code == 200

    asyncio.run(flow())


def test_request_boundary_rejects_cross_origin_and_hides_credentials():
    app = main.create_app(SETTINGS, transport=httpx.MockTransport(FakeSupabase()))

    async def flow():
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url=ORIGIN
            ) as browser,
        ):
            health = await browser.get("/health")
            assert health.json() == {"status": "ok", "supabase_configured": True}
            assert health.headers["cache-control"] == "no-store"
            assert "object-src 'none'" in health.headers["content-security-policy"]
            assert (await browser.get("/")).status_code == 200
            cross_origin = await browser.post(
                "/api/auth/login", headers={"Origin": "https://example.test"}, json={}
            )
            assert cross_origin.status_code == 403
            password = "DO-NOT-REFLECT-THIS-SECRET"
            invalid = await browser.post(
                "/api/auth/login",
                json={
                    "email": "operator@example.test",
                    "password": {"secret": password},
                },
            )
            assert invalid.status_code == 422
            assert password not in invalid.text
            large = await browser.post(
                "/api/auth/login", content=b"x" * (2 * 1024 * 1024 + 1)
            )
            assert large.status_code == 413

            async def stream():
                yield b" " * (2 * 1024 * 1024)
                yield b" "

            streamed = await browser.post(
                "/api/auth/login",
                content=stream(),
                headers={"Content-Type": "application/json"},
            )
            assert streamed.status_code == 413

    asyncio.run(flow())


def test_password_reset_revokes_previous_local_sessions():
    app = main.create_app(SETTINGS, transport=httpx.MockTransport(FakeSupabase()))

    async def flow():
        transport = httpx.ASGITransport(app=app)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=transport, base_url=ORIGIN) as logged_in,
            httpx.AsyncClient(transport=transport, base_url=ORIGIN) as recovery,
        ):
            await sign_in(logged_in)
            assert (await logged_in.get("/api/session")).status_code == 200
            reply = await recovery.post(
                "/api/auth/recover", json={"email": "Operator@Example.Test"}
            )
            assert reply.status_code == 200
            password = {"password": "changed-password-fixture"}
            expired = await recovery.post(
                "/api/auth/reset",
                json={**password, "token_hash": "expired-token-fixture"},
            )
            assert expired.status_code == 422
            result = await recovery.post(
                "/api/auth/reset",
                json={**password, "token_hash": "recovery-token-fixture"},
            )
            assert result.status_code == 200
            assert (await logged_in.get("/api/session")).status_code == 401

    asyncio.run(flow())
