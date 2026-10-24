from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator

from loguru import logger

logger.remove()
logger.add(sys.stderr, level=os.getenv("PIPECAT_LOG_LEVEL", "INFO"))

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from local_asr import supports_language, transcribe_local_audio


API_BASE_URL = os.getenv("SHARPERTIME_API_BASE_URL", "https://api.46.225.173.118.nip.io").rstrip("/")
SESSION_TTL_SECONDS = 180
MAX_TURNS_PER_SESSION = 40
MAX_SESSION_STARTS_PER_USER_PER_HOUR = 12
MAX_TURN_TEXT = 1600
MAX_HISTORY_TURNS = 8
MAX_ASR_AUDIO_BYTES = 20 * 1024 * 1024
TURN_END_DEBOUNCE_SECONDS = 0.9
TURN_CREDENTIAL_TTL_SECONDS = 3 * 60 * 60
TUTOR_LANGUAGE_NAMES = {
    "af": "Afrikaans",
    "nso": "Sepedi",
    "nr": "isiNdebele",
    "st": "Sesotho",
    "tn": "Setswana",
    "ve": "Tshivenda",
    "ts": "XiTsonga",
    "xh": "isiXhosa",
    "zu": "isiZulu",
    "en": "English",
}


def _allowed_origins() -> list[str]:
    configured = os.getenv("VOICE_ALLOWED_ORIGINS", "")
    defaults = [
        "https://sharperx.co.za",
        "https://www.sharperx.co.za",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ]
    values = configured.split(",") if configured.strip() else defaults
    return [value.strip().rstrip("/") for value in values if value.strip()]


ALLOWED_ORIGINS = _allowed_origins()
app = FastAPI(title="SharperTime Pipecat voice service", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)


class HistoryTurn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role: Literal["learner", "tutor"]
    text: str = Field(max_length=1200)


class VoiceSessionContext(BaseModel):
    model_config = ConfigDict(extra="ignore")
    context_type: Literal["ask", "practice"]
    response_language: str = Field(default="en-ZA", max_length=24)
    response_language_name: str | None = Field(default=None, max_length=80)
    grade: int = Field(ge=8, le=12)
    topic: str | None = Field(default=None, max_length=240)
    inspection_id: str | None = Field(default=None, max_length=120)
    question_text: str | None = Field(default=None, max_length=12000)
    question_id: str | None = Field(default=None, max_length=240)
    bank_version: str | None = Field(default=None, max_length=120)
    marks: int | None = Field(default=None, ge=0, le=1000)
    hints_used: int = Field(default=0, ge=0, le=100)
    learner_working: str = Field(default="", max_length=12000)
    question_paper_document_id: str | None = Field(default=None, max_length=80)
    question_paper_question_number: str | None = Field(default=None, max_length=20)
    conversation_history: list[HistoryTurn] = Field(default_factory=list, max_length=8)

    @field_validator("conversation_history")
    @classmethod
    def keep_recent_turns(cls, value: list[HistoryTurn]) -> list[HistoryTurn]:
        return value[-MAX_HISTORY_TURNS:]


@dataclass
class VoiceSession:
    access_token: str
    user_key: str
    context: VoiceSessionContext
    expires_at: float
    ice_servers: list[IceServer] = field(default_factory=list)
    client_ice_servers: list[dict[str, Any]] = field(default_factory=list)
    turn_count: int = 0
    history: deque[HistoryTurn] = field(default_factory=lambda: deque(maxlen=MAX_HISTORY_TURNS))
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        self.history.extend(self.context.conversation_history)


class SessionStore:
    def __init__(self) -> None:
        self._pending: dict[str, VoiceSession] = {}
        self._user_starts: dict[str, deque[float]] = defaultdict(deque)

    def _remove_expired(self) -> None:
        now = time.monotonic()
        for token in [token for token, session in self._pending.items() if session.expires_at <= now]:
            self._pending.pop(token, None)

    def create(self, session: VoiceSession) -> str:
        self._remove_expired()
        now = time.monotonic()
        starts = self._user_starts[session.user_key]
        while starts and starts[0] < now - 3600:
            starts.popleft()
        if len(starts) >= MAX_SESSION_STARTS_PER_USER_PER_HOUR:
            raise HTTPException(status_code=429, detail="Too many voice sessions were started. Try again later.")
        starts.append(now)
        token = secrets.token_urlsafe(32)
        self._pending[token] = session
        return token

    def consume(self, token: str) -> VoiceSession | None:
        self._remove_expired()
        session = self._pending.pop(token, None)
        if session and session.expires_at > time.monotonic():
            return session
        return None


def _configured_ice_servers() -> list[IceServer]:
    raw = os.getenv("PIPECAT_ICE_SERVERS", "").strip()
    if not raw:
        return [IceServer(urls=["stun:stun.l.google.com:19302"])]
    try:
        entries = json.loads(raw)
        if not isinstance(entries, list):
            raise ValueError("ICE servers must be a JSON array")
        result = []
        for entry in entries:
            if isinstance(entry, str):
                urls = [entry]
            elif isinstance(entry, dict) and entry.get("urls"):
                urls = entry["urls"] if isinstance(entry["urls"], list) else [entry["urls"]]
                if entry.get("username") or entry.get("credential"):
                    raise ValueError("Use TURN_SHARED_SECRET for TURN credentials")
            else:
                raise ValueError("Each ICE entry must be a URL or an object with urls")
            if not urls or any(not str(url).startswith(("stun:", "stuns:")) for url in urls):
                raise ValueError("PIPECAT_ICE_SERVERS accepts STUN URLs; configure TURN_SERVER_URLS with TURN_SHARED_SECRET")
            result.append(IceServer(urls=urls))
        return result
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("PIPECAT_ICE_SERVERS must be a JSON array of STUN URLs without credentials") from error


def _session_ice_servers() -> tuple[list[IceServer], list[dict[str, Any]]]:
    servers = _configured_ice_servers()
    client_servers = [{"urls": server.urls} for server in servers]
    turn_urls = [url.strip() for url in os.getenv("TURN_SERVER_URLS", "").split(",") if url.strip()]
    turn_secret = os.getenv("TURN_SHARED_SECRET", "").strip()
    if bool(turn_urls) != bool(turn_secret):
        raise RuntimeError("TURN_SERVER_URLS and TURN_SHARED_SECRET must both be configured")
    if turn_urls:
        expiry = int(time.time()) + TURN_CREDENTIAL_TTL_SECONDS
        username = f"{expiry}:{secrets.token_urlsafe(12)}"
        digest = hmac.new(turn_secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
        credential = base64.b64encode(digest).decode("ascii")
        turn_config = {"urls": turn_urls, "username": username, "credential": credential}
        servers.append(IceServer(urls=turn_urls, username=username, credential=credential))
        client_servers.append(turn_config)
    return servers, client_servers


sessions = SessionStore()
request_handler = SmallWebRTCRequestHandler(ice_servers=_configured_ice_servers())
offer_lock = asyncio.Lock()
sessions_by_pc: dict[str, VoiceSession] = {}
workers_by_pc: dict[str, asyncio.Task[None]] = {}
request_tasks: set[asyncio.Task[Any]] = set()
http_client: httpx.AsyncClient | None = None


def _check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="This website is not allowed to start a voice session.")


def _bearer_token(request: Request) -> str:
    value = request.headers.get("authorization", "")
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Sign in to SharperTime before starting live tutoring.")
    return token.strip()


async def _api_user(token: str) -> dict[str, Any]:
    if http_client is None:
        raise HTTPException(status_code=503, detail="The voice service is starting. Try again shortly.")
    try:
        response = await http_client.get(
            f"{API_BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="SharperTime could not validate your sign-in. Try again shortly.") from error
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Your SharperTime session has expired. Sign in again.")
    if response.is_error:
        raise HTTPException(status_code=503, detail="SharperTime could not validate your sign-in. Try again shortly.")
    try:
        return response.json()
    except ValueError as error:
        raise HTTPException(status_code=503, detail="SharperTime could not validate your sign-in. Try again shortly.") from error


def _user_key(user: dict[str, Any]) -> str:
    for name in ("id", "user_id", "learner_id", "email", "sub"):
        value = user.get(name)
        if value:
            return f"{name}:{str(value).lower()}"
    raise HTTPException(status_code=401, detail="The SharperTime account could not be identified.")


def _extract_text(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    for key in ("text", "transcription", "transcript", "recognized_text", "utterance"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    nested = body.get("result")
    if isinstance(nested, dict):
        return _extract_text(nested)
    return ""


class SharperTimeSTTService(SegmentedSTTService):
    def __init__(self, session: VoiceSession) -> None:
        super().__init__(
            settings=STTSettings(model=None, language=None),
            trailing_silence_secs=0.45,
            stt_ttfb_timeout=20,
            ttfs_p99_latency=1.0,
        )
        self._session = session

    async def run_stt(self, audio: bytes):
        if http_client is None:
            return
        try:
            response_language = self._session.context.response_language
            if supports_language(response_language):
                result = await transcribe_local_audio(audio, response_language)
                text = result["text"]
                if text:
                    yield TranscriptionFrame(
                        text=text[:MAX_TURN_TEXT],
                        user_id="learner",
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        finalized=True,
                    )
                return
            response = await http_client.post(
                f"{API_BASE_URL}/api/education/speech/transcribe",
                headers={"Authorization": f"Bearer {self._session.access_token}"},
                data={"language": response_language},
                files={"audio": ("speech.wav", audio, "audio/wav")},
                timeout=25,
            )
            if response.status_code == 401:
                raise RuntimeError("SharperTime sign-in expired")
            response.raise_for_status()
            text = _extract_text(response.json())
        except (httpx.HTTPError, ValueError, RuntimeError) as error:
            raise RuntimeError("Speech recognition could not process this turn") from error
        if text:
            yield TranscriptionFrame(
                text=text[:MAX_TURN_TEXT],
                user_id="learner",
                timestamp=datetime.now(timezone.utc).isoformat(),
                finalized=True,
            )


def _tutor_request(session: VoiceSession, latest_text: str) -> dict[str, Any]:
    context = session.context
    prior = list(session.history)[-MAX_HISTORY_TURNS:]
    conversation = "\n".join(f"{turn.role.title()}: {turn.text}" for turn in prior)
    language_code = context.response_language.strip().replace("_", "-").casefold().split("-", 1)[0]
    language_name = context.response_language_name or TUTOR_LANGUAGE_NAMES.get(language_code, context.response_language)
    instructions = (
        f"Continue a live mathematics tutoring conversation. Use short, clear spoken sentences in {language_name} for ordinary explanations and guide the learner one step at a time. "
        "Keep all mathematical terms, number words used in equations, operators, and spoken equations in English. For example, say ‘x squared plus 3 equals 7’ in English even inside a sentence in the learner's language. "
        "Ask one brief question when a step is unclear. This voice turn is for tutoring only: do not mark, grade, submit, or claim to have submitted the learner's work."
    )
    details = []
    if context.context_type == "practice" and context.question_text:
        details.append(f"Selected practice question:\n{context.question_text}")
        if context.learner_working.strip():
            details.append(f"Learner's current working, for coaching context only:\n{context.learner_working[:8000]}")
        if context.hints_used:
            details.append(f"Hints already shown in this practice question: {context.hints_used}.")
    elif context.context_type == "ask" and context.question_text:
        details.append(f"Selected paper question {context.question_paper_question_number or ''}:\n{context.question_text}")
    if conversation:
        details.append(f"Recent conversation:\n{conversation}")
    details.append(f"Learner's latest spoken request:\n{latest_text}")
    prompt = f"{instructions}\n\n" + "\n\n".join(details)
    request: dict[str, Any] = {
        "subject": "Mathematics",
        "grade": context.grade,
        "topic": context.topic or ("Question paper" if context.question_paper_document_id else None),
        "question": prompt[:20000],
        "learner_answer": None,
        "mode": "explain_try_mark",
        "inspection_id": context.inspection_id,
        "ai_tier": "luna",
        "allow_web_search": False,
        "confirmed_photo_transcription": None,
        "photo_reading_confirmed": False,
        "question_paper_document_id": context.question_paper_document_id,
        "question_paper_question_number": context.question_paper_question_number,
    }
    if context.context_type == "practice" and context.question_text:
        request["math_practice_context"] = {
            "question_id": context.question_id,
            "bank_version": context.bank_version or "",
            "subject": "Mathematics",
            "grade": context.grade,
            "topic": context.topic or "",
            "question_text": context.question_text,
            "marks": context.marks or 0,
            "assistance_mode": "Hints" if context.hints_used else "SolveItMyself",
            "hints_used": context.hints_used,
        }
    return request


def _tutor_text(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    final_check = body.get("ai_final_check") if isinstance(body.get("ai_final_check"), dict) else {}
    model = str(body.get("ai_model") or body.get("model") or "").strip().lower()
    effort = str(body.get("ai_reasoning_effort") or body.get("reasoning_effort") or "").strip().lower()
    status = str(body.get("ai_status") or body.get("status") or "").strip().lower()
    if (
        model != "gpt-6-luna"
        or effort != "xhigh"
        or status != "completed"
        or str(final_check.get("provider") or "").strip().lower() != "openai"
        or str(final_check.get("model") or "").strip().lower() != "gpt-6-luna"
        or str(final_check.get("reasoning_effort") or "").strip().lower() != "xhigh"
        or final_check.get("approved") is not True
    ):
        return ""
    for key in ("assistant_message", "answer", "response", "feedback", "message", "tutor_response", "text"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    nested = body.get("result")
    return nested.strip() if isinstance(nested, str) else ""


class TutorTurnProcessor(FrameProcessor):
    def __init__(self, session: VoiceSession) -> None:
        super().__init__()
        self._session = session
        self._pending_turn_text = ""
        self._pending_turn_task: asyncio.Task[Any] | None = None

    async def _send(self, message_type: str, text: str = "") -> None:
        await self.push_frame(RTVIServerMessageFrame(data={"type": message_type, "text": text}))

    async def _answer(self, user_text: str) -> None:
        async with self._session.turn_lock:
            if self._session.turn_count >= MAX_TURNS_PER_SESSION:
                await self._send("error", "This voice session has reached its turn limit. End it and start a new session to continue.")
                return
            self._session.turn_count += 1
            try:
                await self._send("thinking")
                if http_client is None:
                    raise RuntimeError("Tutor service is unavailable")
                response = await http_client.post(
                    f"{API_BASE_URL}/api/education/tutor/ask",
                    headers={"Authorization": f"Bearer {self._session.access_token}"},
                    json=_tutor_request(self._session, user_text),
                    timeout=60,
                )
                if response.status_code == 401:
                    raise RuntimeError("Your SharperTime session expired. Sign in again.")
                response.raise_for_status()
                reply = _tutor_text(response.json())
                if not reply:
                    raise RuntimeError("SharperTime could not complete this tutor turn")
                self._session.history.append(HistoryTurn(role="learner", text=user_text[:1200]))
                self._session.history.append(HistoryTurn(role="tutor", text=reply[:1200]))
                await self._send("tutor_reply", reply[:8000])
            except (httpx.HTTPError, ValueError, RuntimeError) as error:
                message = str(error) if "session expired" in str(error).lower() else "I couldn't prepare a reply just now. Please try again or type your question."
                await self._send("error", message)

    async def _answer_after_turn_end(self) -> None:
        await asyncio.sleep(TURN_END_DEBOUNCE_SECONDS)
        user_text = self._pending_turn_text.strip()
        self._pending_turn_text = ""
        if user_text:
            await self._answer(user_text[:MAX_TURN_TEXT])

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            user_text = frame.text.strip()[:MAX_TURN_TEXT]
            await self._send("transcript", user_text)
            joined_text = f"{self._pending_turn_text} {user_text}".strip()
            self._pending_turn_text = joined_text[:MAX_TURN_TEXT]
            if self._pending_turn_task and not self._pending_turn_task.done():
                self._pending_turn_task.cancel()
            self._pending_turn_task = self.create_task(
                self._answer_after_turn_end(),
                name="sharpertime-tutor-turn-end",
            )
        await self.push_frame(frame, direction)


async def run_voice_worker(connection: Any, session: VoiceSession) -> None:
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=False,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )
    pipeline = Pipeline([
        transport.input(),
        SharperTimeSTTService(session),
        TutorTurnProcessor(session),
        transport.output(),
    ])
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=False, enable_usage_metrics=False),
    )
    runner = WorkerRunner()
    await runner.add_workers(worker)
    await runner.run()


def _schedule(task: asyncio.Task[Any]) -> None:
    request_tasks.add(task)
    task.add_done_callback(request_tasks.discard)


@app.on_event("startup")
async def startup() -> None:
    global http_client
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10))


@app.on_event("shutdown")
async def shutdown() -> None:
    if request_tasks:
        for task in list(request_tasks):
            task.cancel()
        await asyncio.gather(*request_tasks, return_exceptions=True)
    await request_handler.close()
    if http_client:
        await http_client.aclose()


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe_local(request: Request, audio: UploadFile = File(...), language: str = Form("en-ZA")) -> dict[str, Any]:
    _check_origin(request)
    token = _bearer_token(request)
    await _api_user(token)
    if not supports_language(language):
        raise HTTPException(status_code=422, detail="Local speech recognition is not available for this language yet.")
    data = await audio.read(MAX_ASR_AUDIO_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")
    if len(data) > MAX_ASR_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio file is too large for local speech recognition.")
    try:
        result = await transcribe_local_audio(data, language)
    except (ImportError, FileNotFoundError, RuntimeError) as error:
        if "not installed" in str(error).lower() or isinstance(error, ImportError):
            raise HTTPException(status_code=503, detail="The selected language model is not installed on the voice server yet.") from error
        logger.exception("Local speech recognition failed")
        raise HTTPException(status_code=502, detail="Local speech recognition failed. Please try again.") from error
    except Exception as error:
        logger.exception("Local speech recognition failed")
        raise HTTPException(status_code=502, detail="Local speech recognition failed. Please try again.") from error
    transcript = result["text"]
    return {
        "file_name": audio.filename,
        "content_type": audio.content_type,
        "bytes": len(data),
        "model": result["model"],
        "language": result["language"],
        "requested_locale": language,
        "raw_transcript": transcript,
        "transcript": transcript,
        "normalisation": {"math_symbols_applied": False},
    }


@app.post("/session")
async def create_session(request: Request) -> dict[str, Any]:
    _check_origin(request)
    token = _bearer_token(request)
    try:
        payload = await request.json()
        context = VoiceSessionContext.model_validate(payload)
    except Exception as error:
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(status_code=422, detail="The tutoring context is invalid. Reload the app and try again.") from error
    user = await _api_user(token)
    session = VoiceSession(
        access_token=token,
        user_key=_user_key(user),
        context=context,
        expires_at=time.monotonic() + SESSION_TTL_SECONDS,
        ice_servers=[],
        client_ice_servers=[],
    )
    session.ice_servers, session.client_ice_servers = _session_ice_servers()
    session_token = sessions.create(session)
    return {
        "session_token": session_token,
        "expires_in": SESSION_TTL_SECONDS,
        "offer_endpoint": "offer",
        "ice_servers": session.client_ice_servers,
    }


@app.post("/offer")
async def offer(request: Request) -> dict[str, str] | None:
    _check_origin(request)
    try:
        payload = await request.json()
        webrtc_request = SmallWebRTCRequest.from_dict(payload)
    except Exception as error:
        raise HTTPException(status_code=400, detail="The WebRTC offer was invalid.") from error
    request_data = webrtc_request.request_data if isinstance(webrtc_request.request_data, dict) else {}
    session_token = str(request_data.get("session_token") or "")
    session = sessions.consume(session_token) if session_token else None
    if session is None and webrtc_request.pc_id:
        session = sessions_by_pc.get(webrtc_request.pc_id)
    if session is None:
        raise HTTPException(status_code=401, detail="The voice session expired. Start a new session and try again.")

    async def on_connection(connection: Any) -> None:
        pc_id = str(connection.pc_id)
        sessions_by_pc[pc_id] = session
        if pc_id not in workers_by_pc:
            task = asyncio.create_task(run_voice_worker(connection, session), name=f"pipecat-worker-{pc_id}")
            workers_by_pc[pc_id] = task
            request_tasks.add(task)
            task.add_done_callback(lambda finished, key=pc_id: _worker_finished(key, finished))

    async with offer_lock:
        request_handler.update_ice_servers(session.ice_servers)
        return await request_handler.handle_web_request(webrtc_request, on_connection)


def _worker_finished(pc_id: str, task: asyncio.Task[Any]) -> None:
    request_tasks.discard(task)
    workers_by_pc.pop(pc_id, None)
    sessions_by_pc.pop(pc_id, None)
    if not task.cancelled():
        try:
            task.result()
        except Exception:
            # Do not log transcripts, tokens, audio data, or upstream response bodies.
            pass


@app.patch("/offer")
async def patch_offer(request: Request) -> dict[str, str]:
    _check_origin(request)
    try:
        payload = await request.json()
        candidates = [IceCandidate(**candidate) for candidate in payload.get("candidates", [])]
        patch = SmallWebRTCPatchRequest(pc_id=str(payload["pc_id"]), candidates=candidates)
    except Exception as error:
        raise HTTPException(status_code=400, detail="The ICE candidate update was invalid.") from error
    if patch.pc_id not in sessions_by_pc:
        raise HTTPException(status_code=401, detail="The voice session expired. Start a new session and try again.")
    await request_handler.handle_patch_request(patch)
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.getenv("VOICE_HOST", "127.0.0.1"),
        port=int(os.getenv("VOICE_PORT", "7860")),
        workers=1,
        access_log=False,
    )
