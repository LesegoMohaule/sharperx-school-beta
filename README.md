# SharperTime website and web app

SharperTime is a focused AI-powered Grade 12 Mathematics learning platform for African learners. The public website presents the working product, a sample lesson and the application case for the Google Africa Applied AI Lab.

## Public website

The repository contains the SharperTime public website and the installable mathematics workspace in app/.

The platform is launching soon. Registration and paid access are currently closed; the public site is available for product, lesson and application review.

## Device-agnostic web app

Open https://sharperx.co.za/app/ after the website is deployed. The responsive Progressive Web App supports desktop browsers, Android phones and tablets, and iPhone/iPad browsers. Learners can sign in with their existing SharperTime account, use Ask, load question-bank practice for Grades 8–12, generate guided or strict test/exam sessions, browse available lesson videos, upload a paper and select a question, write on the canvas, and save PDF reports on the current device.

The question bank, marking, paper OCR/snapshots, lesson catalog, speech transcription and tutor requests stay on the existing SharperTime API. The browser contains no AI key. Offline mode caches the app shell only; authenticated learning features need a network connection. From any writing canvas, choose **Use phone** to pair a signed-in phone with a short-lived code or QR scan; phone strokes appear on the computer canvas live, and **Submit canvas** attaches the work to the current answer. Phone pairing uses the authenticated `/api/canvas-pairing` service and requires the updated backend to be deployed.

Ask and Practice now include Pipecat SmallWebRTC live tutoring. Pipecat runs on the Ubuntu server behind `/voice/` on the existing API hostname; the static app contains the browser client. The service forwards audio segments and tutor turns through SharperTime's authenticated API. Tutor replies use the voice installed on each learner's device and remain visible as captions. Math notation is converted to spoken wording. The service does not store audio recordings, add an AI provider key, or mark a spoken Practice answer. Replies are turn-based because the existing tutor API returns complete responses. The deployment guide configures self-hosted coturn with short-lived credentials for networks that block direct WebRTC.

The API CORS policy must allow https://sharperx.co.za and https://www.sharperx.co.za before the custom-domain app can call it. GitHub Pages hosting must also be enabled for this repository before the updated site is publicly served.

## Public evidence pages

- `demo.html` - five-minute product demonstration with native browser playback
- `calculus.html` - Grade 12 Differential Calculus lesson with native playback and subtitles
- `pitch-deck.html` - in-browser PDF viewer, PowerPoint browser preview and downloads

## Local assets

- `assets/media/sharpertime-google-africa-applied-ai-lab-demo-5min.mp4`
- `assets/media/sharpertime-grade12-differential-calculus-5min-lesson.mp4`
- `assets/media/sharpertime-google-africa-applied-ai-lab-pitch-deck.pptx`
- `assets/media/sharpertime-google-africa-applied-ai-lab-pitch-deck.pdf`

## Account and payments

The account flow retains the PayFast checkout integration for Grade 12 Mathematics tutor access and lesson-video access for existing account holders. New registration is currently closed. Server secrets such as the PayFast passphrase, SMTP password and API keys must never be placed in this static repository.

## Local preview

```powershell
cd app
npm install
npm run build
cd ..
python -m http.server 5500 --bind 127.0.0.1
```

Then open http://127.0.0.1:5500/app/.
