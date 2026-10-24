# SharperTime live tutoring voice service

This FastAPI service runs beside SharperTime's existing API on the Ubuntu server. It keeps Pipecat's SmallWebRTC transport and VAD, sends short in-memory audio segments to language-selected speech recognition, and sends recognized turns to the existing tutor endpoint. English and additional languages supplied by the device continue to use SharperTime's existing transcription endpoint. The nine South African languages listed below use local, open-source recognition models.

The web app keeps its current device voice selector and adds a tutor-language selector. The language selector contains the existing device voice languages plus the nine local-model languages. Tutor instructions request ordinary explanations in the selected language while keeping mathematical terms, number words inside equations, operators, and spoken equations in English. The browser uses an installed device voice matching the selected language when one is available.

The browser reads tutor replies with the voice installed on the learner's phone or computer. Pipecat sends reply text and captions over its WebRTC data channel; browser SpeechSynthesis speaks the math-normalized text. The voice service combines consecutive VAD transcript segments and waits for 0.9 seconds without another segment before sending the learner's turn to the tutor, so short thinking pauses do not trigger an early reply. The tutor API returns a completed turn, so the learner hears each reply after that response completes. It is a live, turn-based conversation, not token-by-token streamed speech.

## South African language speech recognition

The local routes are selected by the requested locale:

- Afrikaans uses `digiphyte/fluister-turbo` (MIT), an int8 faster-whisper model.
- isiZulu, isiXhosa, Sesotho, Setswana, isiNdebele, Tshivenda, and XiTsonga use `digiphyte/swivuriso-turbo` (MIT), an int8 CTranslate2 conversion of DSFSI's MIT `za-anv-multilingual-whisper-v3-turbo` weights. The model uses language auto-detection for this seven-language set.
- Sepedi uses Meta's `omniASR_CTC_300M` in the int8 Sherpa-ONNX export (Apache-2.0). The CTC model does not take a language hint.

The two Whisper checkpoints are pinned to repository revisions in `local_asr.py`. The Sepedi model is downloaded into `/opt/sharpertime-voice/models/omnilingual-300m-ctc-int8`. The service loads one local recognizer at a time to limit RAM use; its model cache persists on disk. Install dependencies and model files before restarting the service:

```bash
sudo /opt/sharpertime-voice/.venv/bin/pip install -r /path/to/sharperx-school-beta/voice-service/requirements.txt
sudo /path/to/sharperx-school-beta/voice-service/download-asr-models.sh
sudo systemctl restart sharpertime-voice.service
```

The selected routes cover nine South African official languages beyond English. The selector only offers languages covered by these routes or by an installed device voice.

Raw audio and full transcripts are not written to disk or logged by this service. A learner's bearer token is validated before a short-lived, single-use WebRTC session token is issued. The verified learner bearer remains in memory only for the active session and is used when forwarding transcription and tutor requests.

## Deploy on Ubuntu

Use Python 3.11 or newer. The service is configured for one Uvicorn worker because session tokens and active peer connections are held in process memory.

```bash
cd /path/to/sharperx-school-beta/voice-service
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
cp .env.example .env
```

Set `VOICE_ALLOWED_ORIGINS` and `SHARPERTIME_API_BASE_URL` in `.env`. Keep `.env` on the server; never commit credentials. Run the service bound to localhost:

```bash
set -a
source .env
set +a
uvicorn server:app --host 127.0.0.1 --port 7860 --workers 1 --no-access-log
```

Add an HTTPS reverse-proxy location on the existing API hostname. The app defaults to `https://api.46.225.173.118.nip.io/voice`, and this configuration strips `/voice/` before forwarding to FastAPI:

```nginx
location /voice/ {
    proxy_pass http://127.0.0.1:7860/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
}
```

Confirm `https://api.46.225.173.118.nip.io/voice/healthz` returns `{"status":"ok"}`. CORS allows only the configured SharperTime app origins. Clients that explicitly use this optional service can set `window.SHARPERTIME_VOICE_BASE_URL` before their app bundle loads, for example to `https://voice.sharperx.co.za`.

## WebRTC and TURN

The browser and Pipecat service receive the same ICE configuration from `/session`. STUN is configured in `PIPECAT_ICE_SERVERS`; TURN is configured with `TURN_SERVER_URLS` and `TURN_SHARED_SECRET`. The voice service signs three-hour TURN credentials for each session, so the shared secret stays on the server.

The Ubuntu deployment uses the configuration templates checked into this directory. Install coturn and use a relay range outside Asterisk's existing 10000-20000 UDP range:

    sudo apt-get update
    sudo apt-get install -y coturn
    TURN_SECRET="$(openssl rand -hex 32)"
    sudo install -d -o root -g turnserver -m 0750 /etc/turnserver/tls
    sudo install -o root -g turnserver -m 0640 /etc/letsencrypt/live/api.46.225.173.118.nip.io/fullchain.pem /etc/turnserver/tls/fullchain.pem
    sudo install -o root -g turnserver -m 0640 /etc/letsencrypt/live/api.46.225.173.118.nip.io/privkey.pem /etc/turnserver/tls/privkey.pem
    sed "s/REPLACE_WITH_64_HEX_CHAR_SECRET/$TURN_SECRET/" coturn.conf.example | sudo tee /etc/turnserver.conf >/dev/null
    sudo chmod 600 /etc/turnserver.conf
    sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
    sudo ufw allow 3478/udp
    sudo ufw allow 3478/tcp
    sudo ufw allow 5349/tcp
    sudo ufw allow 21000:21999/udp
    sudo systemctl enable --now coturn

Put the same generated secret in the voice service environment file as TURN_SHARED_SECRET, and set TURN_SERVER_URLS to the URLs shown in .env.example. Keep coturn's relay ports disjoint from the Asterisk media range. If the cloud provider has a separate firewall, allow those same TURN ports there. Keep text and recorded-voice fallbacks for networks that block all TURN routes.

Install renew-coturn-cert.sh as /etc/letsencrypt/renewal-hooks/deploy/20-coturn-cert.sh with owner root:root and mode 0750. It copies the renewed certificate and private key into the coturn-readable directory and restarts coturn. The TLS private key remains unreadable to the turnserver user outside that copied file.

The deployed voice unit is sharpertime-voice.service; the HTTPS proxy block is in nginx-voice.conf. Install the unit at /etc/systemd/system/sharpertime-voice.service, reload systemd, and enable it. Merge the Nginx location into the existing TLS server block, run nginx -t, and reload Nginx.

The voice service runs with Pipecat logging at `INFO` and LLM context logging disabled so routine debug output does not include frame details.

## Runtime behavior and limits

- Microphone access requires the hosted app to use HTTPS and the learner to grant permission.
- The service forwards speech to `/api/education/speech/transcribe` and tutor turns to `/api/education/tutor/ask` with the learner's existing bearer token.
- It never calls the marking endpoint. In Practice, recognized speech and typed working are coaching context only; the learner must still press **Send for marking**.
- Tutor responses are accepted only when the existing API reports the expected completed Luna/xhigh result.
- Server memory holds the session token for up to three minutes before connection and keeps the verified session context while the call is active. Restarting the single process ends active sessions.
- No Pipecat, TTS, or STT provider key is needed. Existing SharperTime transcription and tutor usage rules still apply.
- Add TURN and shared session storage before widening the pilot or scaling horizontally.
