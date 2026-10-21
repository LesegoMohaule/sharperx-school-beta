from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState


ROOT = Path(__file__).resolve().parent
PAIR_CODE_TTL_SECONDS = 5 * 60
ACTIVE_SESSION_TTL_SECONDS = 2 * 60 * 60
JOIN_RATE_WINDOW_SECONDS = 10 * 60
JOIN_RATE_LIMIT = 30
MAX_REMOTE_MESSAGE_CHARS = 10_000
MAX_CANVAS_MESSAGE_CHARS = 180_000
PAIRING_KINDS = {"device-remote", "canvas-pairing"}


@dataclass
class PairingSession:
    kind: str
    session_id: str
    code: str
    host_secret_hash: str
    phone_secret: str
    expires_at: float
    host: WebSocket | None = None
    phone: WebSocket | None = None
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


app = FastAPI(title="SharperTime local intranet")
sessions: dict[str, PairingSession] = {}
codes: dict[tuple[str, str], str] = {}
join_attempts: dict[str, deque[float]] = defaultdict(deque)
session_lock = asyncio.Lock()


def secret_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def remove_session(session: PairingSession) -> None:
    sessions.pop(session.session_id, None)
    code_key = (session.kind, session.code)
    if codes.get(code_key) == session.session_id:
        codes.pop(code_key, None)


def prune_expired(now: float) -> None:
    for session in list(sessions.values()):
        if session.expires_at <= now:
            remove_session(session)


def allowed_message_types(kind: str, role: str) -> set[str]:
    if kind == "device-remote":
        return {"pointer", "text", "key"} if role == "phone" else {"focus", "canvas_link", "canvas_unavailable", "cancel"}
    return {"stroke_start", "stroke_points", "stroke_end", "undo", "clear", "submit"} if role == "phone" else {"setup", "submitted", "submission_error", "cancel"}


def origin_matches_request_host(origin: str, host: str) -> bool:
    try:
        parsed = urlsplit(origin)
        return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == host.lower() and not parsed.path and not parsed.query and not parsed.fragment
    except ValueError:
        return False


async def send_message(session: PairingSession, socket: WebSocket | None, payload: dict) -> None:
    if socket is None or socket.client_state != WebSocketState.CONNECTED:
        return
    try:
        async with session.send_lock:
            if socket.client_state == WebSocketState.CONNECTED:
                await socket.send_json(payload)
    except (RuntimeError, WebSocketDisconnect):
        pass


@app.get("/")
async def app_home() -> RedirectResponse:
    return RedirectResponse(url="/app/", status_code=307)


@app.post("/api/{kind}/sessions")
async def create_session(kind: str) -> dict:
    if kind not in PAIRING_KINDS:
        raise HTTPException(status_code=404, detail="Phone connection is unavailable.")
    now = time.time()
    async with session_lock:
        prune_expired(now)
        if len(sessions) >= 500:
            raise HTTPException(status_code=503, detail="Phone connection is busy. Try again shortly.")
        code = f"{secrets.randbelow(1_000_000):06d}"
        while (kind, code) in codes:
            code = f"{secrets.randbelow(1_000_000):06d}"
        session_id = secrets.token_urlsafe(24)
        host_secret = secrets.token_urlsafe(32)
        session = PairingSession(
            kind=kind,
            session_id=session_id,
            code=code,
            host_secret_hash=secret_hash(host_secret),
            phone_secret=secrets.token_urlsafe(32),
            expires_at=now + PAIR_CODE_TTL_SECONDS,
        )
        sessions[session_id] = session
        codes[(kind, code)] = session_id
    return {
        "session_id": session_id,
        "pairing_code": code,
        "host_token": host_secret,
        "expires_in": PAIR_CODE_TTL_SECONDS,
    }


@app.post("/api/{kind}/join")
async def join_session(kind: str, request: Request) -> dict:
    if kind not in PAIRING_KINDS:
        raise HTTPException(status_code=404, detail="Phone connection is unavailable.")
    try:
        payload = await request.json()
    except (ValueError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Enter the six-digit pairing code.")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Enter the six-digit pairing code.")
    code = str(payload.get("code", ""))
    if len(code) != 6 or not code.isascii() or not code.isdigit():
        raise HTTPException(status_code=422, detail="Enter the six-digit pairing code.")
    requested_id = str(payload.get("session_id", ""))[:80]
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    async with session_lock:
        for known_ip, bucket in list(join_attempts.items()):
            while bucket and bucket[0] <= now - JOIN_RATE_WINDOW_SECONDS:
                bucket.popleft()
            if not bucket:
                join_attempts.pop(known_ip, None)
        attempts = join_attempts[client_ip]
        if len(attempts) >= JOIN_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many connection attempts. Wait a few minutes and try again.")
        attempts.append(now)

        prune_expired(now)
        session_id = requested_id or codes.get((kind, code), "")
        session = sessions.get(session_id)
        if session is None or session.kind != kind or session.code != code or session.expires_at <= now:
            raise HTTPException(status_code=404, detail="That connection code is invalid or has expired.")
        session.expires_at = now + ACTIVE_SESSION_TTL_SECONDS
        return {
            "session_id": session.session_id,
            "phone_token": session.phone_secret,
            "expires_in": ACTIVE_SESSION_TTL_SECONDS,
        }


@app.websocket("/api/{kind}/ws/{session_id}")
async def pairing_socket(websocket: WebSocket, kind: str, session_id: str) -> None:
    role = websocket.query_params.get("role", "")
    origin = websocket.headers.get("origin", "")
    host = websocket.headers.get("host", "")
    if kind not in PAIRING_KINDS or role not in {"host", "phone"} or not origin_matches_request_host(origin, host):
        await websocket.close(code=1008, reason="Connection is not allowed")
        return

    async with session_lock:
        prune_expired(time.time())
        session = sessions.get(session_id)
        if session is None or session.kind != kind:
            await websocket.close(code=1008, reason="Connection has expired")
            return

    await websocket.accept()
    try:
        raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        auth = json.loads(raw_auth) if len(raw_auth) <= 1024 else {}
        token = str(auth.get("token", "")) if isinstance(auth, dict) and auth.get("type") == "authenticate" else ""
    except (asyncio.TimeoutError, WebSocketDisconnect, json.JSONDecodeError):
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close(code=1008, reason="Authentication required")
        return

    async with session_lock:
        if sessions.get(session_id) is not session or session.expires_at <= time.time():
            await websocket.close(code=1008, reason="Connection has expired")
            return
        if role == "host":
            authorized = secrets.compare_digest(secret_hash(token), session.host_secret_hash)
        else:
            authorized = secrets.compare_digest(token, session.phone_secret)
        if not authorized:
            await websocket.close(code=1008, reason="Connection is not authorized")
            return
        previous = session.host if role == "host" else session.phone
        if role == "host":
            session.host = websocket
        else:
            session.phone = websocket
            session.expires_at = time.time() + ACTIVE_SESSION_TTL_SECONDS

    if previous and previous is not websocket:
        try:
            await previous.close(code=4001, reason="Connection replaced")
        except RuntimeError:
            pass
    peer = session.phone if role == "host" else session.host
    await send_message(session, websocket, {"type": "authenticated"})
    if peer is not None:
        await send_message(session, peer, {"type": "phone_connected" if role == "phone" else "host_connected"})
        await send_message(session, websocket, {"type": "host_connected" if role == "phone" else "phone_connected"})

    session_removed = False
    max_chars = MAX_REMOTE_MESSAGE_CHARS if kind == "device-remote" else MAX_CANVAS_MESSAGE_CHARS
    allowed_types = allowed_message_types(kind, role)
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > max_chars:
                await websocket.close(code=1009, reason="Connection message is too large")
                break
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            message_type = str(message.get("type", ""))
            if message_type == "ping":
                async with session_lock:
                    if sessions.get(session_id) is session and session.phone is not None:
                        session.expires_at = time.time() + ACTIVE_SESSION_TTL_SECONDS
                    expired = sessions.get(session_id) is not session or session.expires_at <= time.time()
                    if expired:
                        remove_session(session)
                if expired:
                    await send_message(session, session.host, {"type": "session_closed"})
                    await send_message(session, session.phone, {"type": "session_closed"})
                    if websocket.client_state == WebSocketState.CONNECTED:
                        await websocket.close(code=4002, reason="Connection has expired")
                    break
                await send_message(session, websocket, {"type": "pong"})
                continue
            if message_type not in allowed_types:
                continue
            peer = session.host if role == "phone" else session.phone
            if message_type == "cancel" and role == "host":
                await send_message(session, peer, {"type": "session_closed"})
                async with session_lock:
                    remove_session(session)
                session_removed = True
                break
            await send_message(session, peer, message)
    except WebSocketDisconnect:
        pass
    finally:
        async with session_lock:
            notify_peer = False
            if role == "host" and session.host is websocket:
                session.host = None
                notify_peer = True
            elif role == "phone" and session.phone is websocket:
                session.phone = None
                notify_peer = True
            peer = session.phone if role == "host" else session.host
        if notify_peer and not session_removed:
            await send_message(session, peer, {"type": "host_disconnected" if role == "host" else "phone_disconnected"})
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close()


app.mount("/app", StaticFiles(directory=ROOT / "app", html=True), name="sharpertime-app")
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="sharpertime-assets")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5501, log_level="info")
