# SharperTime website and web app

SharperTime is a focused AI-powered Grade 12 Mathematics learning platform for African learners. The public website presents the working product, a sample lesson and the application case for the Google Africa Applied AI Lab.

## Public website

The repository contains the SharperTime public website and the installable mathematics workspace in app/.

The platform is launching soon. Registration and paid access are currently closed; the public site is available for product, lesson and application review.

## Device-agnostic web app

Open https://sharperx.co.za/app/ after the website is deployed. The responsive Progressive Web App supports desktop browsers, Android phones and tablets, and iPhone/iPad browsers. Learners can sign in with their existing SharperTime account, use Ask, load question-bank practice for Grades 8–12, generate guided or strict test/exam sessions, browse available lesson videos, upload a paper and select a question, write on the canvas, and save PDF reports on the current device.

The question bank, marking, paper OCR/snapshots, lesson catalog and AI requests stay on the existing SharperTime API. The browser contains no AI key. Offline mode caches the app shell only; authenticated learning features need a network connection.

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
python -m http.server 8080
```

Then open http://localhost:8080.
