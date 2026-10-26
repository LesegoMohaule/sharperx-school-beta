from __future__ import annotations

import asyncio
import gc
import io
import os
import threading
from pathlib import Path
from typing import Any


ASR_MODEL_DIR = Path(os.getenv("SHARPERTIME_ASR_MODEL_DIR", str(Path(__file__).parent / "models")))
ASR_LANGUAGES = {
    "af": "fluister",
    "nso": "omnilingual",
    "nr": "dsfsi",
    "st": "dsfsi",
    "tn": "dsfsi",
    "ts": "dsfsi",
    "ve": "dsfsi",
    "xh": "dsfsi",
    "zu": "dsfsi",
}
MAX_OMNI_AUDIO_SECONDS = 30
WHISPER_REPOSITORIES = {
    "dsfsi": ("digiphyte/swivuriso-turbo", "078ab5ce8bc1666d658680e61893f76d94c0dec7"),
    "fluister": ("digiphyte/fluister-turbo", "2210b90080c71d204843b242731f7de40db93c4c"),
}

_runtime_lock = threading.RLock()
_runtime_name: str | None = None
_runtime: Any = None


def supports_language(language: str | None) -> bool:
    return _language_code(language) in ASR_LANGUAGES


def model_for_language(language: str | None) -> str | None:
    return ASR_LANGUAGES.get(_language_code(language))


def _language_code(language: str | None) -> str:
    return str(language or "").strip().replace("_", "-").casefold().split("-", 1)[0]


def _release_runtime() -> None:
    global _runtime, _runtime_name
    _runtime = None
    _runtime_name = None
    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (AttributeError, OSError):
        pass


def _load_runtime(model_name: str) -> Any:
    global _runtime, _runtime_name
    if _runtime_name == model_name and _runtime is not None:
        return _runtime

    _release_runtime()
    if model_name in {"dsfsi", "fluister"}:
        from faster_whisper import WhisperModel
        from huggingface_hub import snapshot_download

        repository, revision = WHISPER_REPOSITORIES[model_name]
        model_path = ASR_MODEL_DIR / ("swivuriso-turbo" if model_name == "dsfsi" else "fluister-turbo")
        if not (model_path / "model.bin").is_file():
            snapshot_download(repo_id=repository, revision=revision, local_dir=str(model_path))
        _runtime = WhisperModel(
            str(model_path),
            device="cpu",
            compute_type="int8",
            cpu_threads=max(1, int(os.getenv("SHARPERTIME_ASR_CPU_THREADS", "2"))),
            num_workers=1,
        )
    elif model_name == "omnilingual":
        import sherpa_onnx

        model_dir = ASR_MODEL_DIR / "omnilingual-300m-ctc-int8"
        model_path = model_dir / "model.int8.onnx"
        tokens_path = model_dir / "tokens.txt"
        if not model_path.is_file() or not tokens_path.is_file():
            raise RuntimeError("The Sepedi speech model is not installed on the voice server.")
        _runtime = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
            model=str(model_path),
            tokens=str(tokens_path),
            num_threads=max(1, int(os.getenv("SHARPERTIME_ASR_CPU_THREADS", "2"))),
            provider="cpu",
        )
    else:
        raise ValueError("Unknown local speech model")

    _runtime_name = model_name
    return _runtime


def _transcribe_whisper(audio: bytes, model_name: str, language_code: str) -> dict[str, str]:
    model = _load_runtime(model_name)
    segments, info = model.transcribe(
        io.BytesIO(audio),
        language=None if model_name == "dsfsi" else "af",
        beam_size=3,
        condition_on_previous_text=False,
        vad_filter=True,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    language = str(getattr(info, "language", "") or language_code)
    return {"text": text, "language": language}


def _transcribe_omnilingual(audio: bytes) -> dict[str, str]:
    import numpy as np
    import soundfile as sf

    recognizer = _load_runtime("omnilingual")
    with sf.SoundFile(io.BytesIO(audio)) as source:
        sample_rate = source.samplerate
        waveform = source.read(dtype="float32", always_2d=True)
    mono = np.ascontiguousarray(waveform.mean(axis=1), dtype=np.float32)
    if not len(mono):
        return {"text": "", "language": "nso"}

    chunk_size = sample_rate * MAX_OMNI_AUDIO_SECONDS
    transcriptions: list[str] = []
    for start in range(0, len(mono), chunk_size):
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, mono[start : start + chunk_size])
        recognizer.decode_stream(stream)
        text = str(stream.result.text or "").replace("⁇", " ").strip()
        if text:
            transcriptions.append(text)
    return {"text": " ".join(transcriptions).strip(), "language": "nso"}


def _transcribe_sync(audio: bytes, language: str) -> dict[str, str]:
    model_name = model_for_language(language)
    if model_name is None:
        raise ValueError("No local speech model is configured for this language")

    with _runtime_lock:
        if model_name == "omnilingual":
            result = _transcribe_omnilingual(audio)
        else:
            result = _transcribe_whisper(audio, model_name, _language_code(language))
    return {
        "text": " ".join(result["text"].split()),
        "language": result["language"],
        "model": model_name,
    }


async def transcribe_local_audio(audio: bytes, language: str) -> dict[str, str]:
    if not supports_language(language):
        raise ValueError("No local speech model is configured for this language")
    return await asyncio.to_thread(_transcribe_sync, audio, language)
