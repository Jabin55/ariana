"""로컬 전용 실행: python -m app.dev (일반 실행에는 개발용 로그인 경로가 없다)."""

from __future__ import annotations

import os
import secrets
from ipaddress import ip_address

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware


LOGIN_PAGE = """<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>로컬 개발용 로그인</title>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; background: #f4f7fa; color: #172b4d; margin: 0; padding: 24px; }
    main { max-width: 420px; margin: 8vh auto; background: white; padding: 28px; border-radius: 16px; }
    h1 { font-size: 1.5rem; margin-top: 0; }
    label { display: block; margin-top: 18px; }
    input, button { box-sizing: border-box; width: 100%; font: inherit; padding: 10px 12px; border-radius: 8px; }
    input { border: 1px solid #aebdca; }
    button { margin-top: 24px; background: #244f86; border: 0; color: white; cursor: pointer; }
    #error { color: #a32121; }
  </style>
</head>
<body>
  <main>
    <h1>로컬 개발용 로그인</h1>
    <p>실행한 터미널에 표시된 인증키로 이 컴퓨터의 테스트 계정에 로그인합니다.</p>
    <form id="developer-login">
      <label for="developer-key">이번 실행의 인증키</label>
      <input id="developer-key" type="password" autocomplete="off" required>
      <label for="developer-email">테스트 계정 이메일</label>
      <input id="developer-email" type="email" value="developer@local.test" autocomplete="off" required>
      <button type="submit">테스트 계정으로 로그인</button>
    </form>
    <p id="error" role="alert"></p>
    <p><a href="/live">일반 로그인 화면으로</a></p>
  </main>
  <script>
    document.querySelector('#developer-login').addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = document.querySelector('#error');
      error.textContent = '';
      try {
        const response = await fetch('/__dev/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: document.querySelector('#developer-key').value,
            email: document.querySelector('#developer-email').value.trim(),
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '입력한 값을 확인해 주세요.');
        document.querySelector('#developer-key').value = '';
        location.replace('/live');
      } catch (err) { error.textContent = err.message; }
    });
  </script>
</body>
</html>"""


class DeveloperLogin(BaseModel):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    key: str = Field(min_length=1, max_length=200)


def create_dev_app(login_key: str) -> FastAPI:
    from app import auth, db
    from app.main import SECRET_KEY, app as site_app, lifespan

    if len(login_key) < 32:
        raise ValueError("개발용 인증키는 32자 이상이어야 합니다.")
    if db.engine.dialect.name != "sqlite":
        raise RuntimeError("개발용 로그인은 로컬 SQLite 데이터베이스에서만 사용할 수 있습니다.")

    developer = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    developer.add_middleware(
        SessionMiddleware, secret_key=SECRET_KEY, session_cookie="live_session",
        max_age=14 * 24 * 3600, same_site="lax",
    )

    @developer.get("/status")
    async def local_login_status():
        return JSONResponse({"local_development": True}, headers={"Cache-Control": "no-store"})

    @developer.get("/login", response_class=HTMLResponse)
    async def login_page():
        return HTMLResponse(LOGIN_PAGE, headers={
            "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                                       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        })

    @developer.post("/login")
    async def login(req: DeveloperLogin, request: Request):
        if not secrets.compare_digest(req.key.encode("utf-8"), login_key.encode("utf-8")):
            raise HTTPException(403, "터미널에 표시된 이번 실행의 인증키를 입력해 주세요.")
        user = await auth.login_with_identity(request, f"dev:{req.email.lower()}", req.email, "", None)
        return JSONResponse(user, headers={"Cache-Control": "no-store"})

    development = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @development.middleware("http")
    async def local_requests_only(request: Request, call_next):
        try:
            local_peer = request.client is not None and ip_address(request.client.host).is_loopback
        except ValueError:
            local_peer = False
        if not local_peer or request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        origin = request.headers.get("origin")
        if request.method == "POST" and request.url.path == "/__dev/login" and origin:
            if origin != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail": "다른 사이트에서는 개발용 로그인을 요청할 수 없습니다."}, status_code=403)
        return await call_next(request)

    development.mount("/__dev", developer)
    development.mount("/", site_app)
    return development


def main():
    import uvicorn

    os.environ.setdefault("APP_MODE", "live")
    os.environ.setdefault("ADMIN_EMAILS", "developer@local.test")
    login_key = secrets.token_urlsafe(32)
    development = create_dev_app(login_key)
    print("로컬 개발용 로그인: http://127.0.0.1:8000/__dev/login", flush=True)
    print(f"이번 실행의 인증키: {login_key}", flush=True)
    uvicorn.run(development, host="127.0.0.1", port=8000, proxy_headers=False)


if __name__ == "__main__":
    main()
