# SharperTime website

SharperTime is a focused AI-powered Grade 12 Mathematics learning platform for African learners. The public website presents the working product, a sample lesson and the application case for the Google Africa Applied AI Lab.

## Live website

GitHub Pages: https://lesegomohaule.github.io/sharperx-school-beta/

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

The account flow retains the PayFast checkout integration for Grade 12 Mathematics tutor access and lesson-video access. Server secrets such as the PayFast passphrase, SMTP password, API keys and reCAPTCHA secret must never be placed in this static repository.

## Local preview

```powershell
python -m http.server 8080
```

Then open http://localhost:8080.
