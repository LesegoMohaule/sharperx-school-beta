# Plan: rich tutoring with live voice

**Goal:** Extend the SharperTime web app into a responsive tutoring experience where a learner can talk naturally with a maths tutor, hear clear spoken explanations, see matching captions and equations, and move between voice, text, questions, hints, and written work without losing context.

## What the app already has

- The app is an installable, device-agnostic PWA in `app/`, with Ask, Practice, exam preparation, lesson videos, a structured maths editor, handwriting/photo input, and a shared writing canvas. See [the app entry point](../app/index.html) and [app overview](../README.md).
- The browser authenticates to the existing SharperTime API using a bearer token in [app/api.js](../app/api.js). The API itself is not in this repository.
- Ask posts to `/api/education/tutor/ask` and renders the completed JSON response. Practice already has question IDs, attempts, hints used, and marking endpoints in [app/app.js](../app/app.js).
- Voice input today is a recorded note that is transcribed and then reviewed or sent. Live audio should be a new interaction mode, with that existing path kept as a fallback.

## Recommended architecture

1. **Keep the web app as the learner interface.** Add a live tutor control to Ask first, then offer the same control inside a selected Practice question. Reuse the existing app styling, login state, selected grade, question, canvas, and transcript UI.
2. **Run a separate, authenticated Pipecat voice service.** The GitHub Pages app is static, so the Pipecat Python process runs server-side on the existing Ubuntu infrastructure. The new `voice-service/` implements short-lived session authorization and SmallWebRTC signaling. It uses the existing API for speech transcription and tutor turns. The browser never receives an AI provider key.
3. **Start with Pipecat `SmallWebRTCTransport`.** It is open source, supports bidirectional real-time audio and data, and avoids requiring a hosted media provider. The service still needs HTTPS signaling and suitable STUN/TURN configuration for learners on different mobile and school networks. Test those paths early; if self-hosted WebRTC cannot meet reliability needs, compare managed transports as a deployment trade-off. Pipecat’s client and server transports must match. [Pipecat transport guidance](https://docs.pipecat.ai/client/concepts/choosing-a-transport) · [SmallWebRTC server transport](https://github.com/pipecat-ai/docs/blob/main/api-reference/server/services/transport/small-webrtc.mdx) · [Pipecat project](https://github.com/pipecat-ai/pipecat)
4. **Use the Pipecat web client from the app’s existing build.** Add `@pipecat-ai/client-js` and the SmallWebRTC client transport to `app/package.json`. Build a bundled modern module and the existing compatibility bundle. Keep the call UI as app-owned HTML/CSS rather than replacing the PWA shell.
5. **Preserve the existing tutor as the source of truth.** The voice service validates the learner and passes grade, topic/question, paper selection, Practice working, hint state, and inspection context to the existing tutor endpoint. It does not call the marking endpoint. The current tutor API is request/response, so each tutor turn is spoken after its complete response arrives; token-level streaming requires a future change to the API.

### Voice turn flow

```text
SharperTime PWA ── short-lived session ──> Pipecat voice service
     │                                      ├─ VAD / turn handling
     │                                      ├─ existing API transcription + tutor logic
     │                                      └─ captions and replies over WebRTC data
     └──────────── WebRTC microphone audio ──> browser device voice reads the math-normalized reply
```

The current implementation uses the learner's local browser/device voice for output. SmallWebRTC carries the live microphone; Pipecat is the open-source orchestration layer and does not include speech models. Replies are turn-based because the existing tutor API does not stream.

The app should obtain a short-lived session credential from an authenticated backend endpoint, then establish the WebRTC call. Validate the existing account token before issuing it, bind it to the learner and session, expire it quickly, and rate-limit session creation. Do not trust grade, question IDs, or learner identity merely because they arrive over the media connection.

## Learner experience

### Ask: conversational help

- Add **Talk to tutor** next to the current Ask composer. Explain microphone use before requesting access; show clear connecting, listening, thinking, speaking, muted, reconnecting, and ended states.
- Support natural back-and-forth and interruption: learners can stop the tutor mid-sentence, correct a misheard number, repeat the last explanation, mute, or end the session.
- Show recognized speech and tutor replies as captions in the Ask conversation. Tutor replies are spoken with the learner's selected local device voice after the existing tutor API returns. Keep typed input, photos, selected paper questions, and canvas work available.
- Make the tutor pedagogical by default: ask what the learner has tried, give one manageable hint at a time, check understanding, and reveal a worked solution only when appropriate or requested.

### Practice: coach around the current problem

- Add **Talk through this question** after a Practice question is selected. Provide Pipecat with the selected question, grade/topic, current attempt, and hints already used.
- Let the learner explain a step verbally, ask for a hint, and continue writing in the current math editor or canvas. The tutor should refer to the learner’s actual line or answer, not restart as a generic chatbot.
- Keep marking an explicit action. When the learner asks to submit, show the recognized working and let them confirm before calling the existing mark endpoint. Voice recognition alone must not submit or overwrite an answer.
- After a session, retain a readable transcript and any confirmed tutor feedback in the existing report/conversation flow. Do not store raw audio by default.

## Mathematical speech design

Use two representations of each response:

- **Display form:** the normal written response with LaTeX/MathJax where useful.
- **Speech form:** an intentionally written spoken explanation, such as “x squared plus four equals y,” segmented so audio can begin before the full response is complete.

Keep these forms aligned, and show the display form in captions when notation matters. The tutor should introduce symbols aloud (“Let x represent…”) and explain fractions, powers, roots, negative signs, inequalities, intervals, trig functions, derivatives, integrals, vectors, and graphs in words appropriate to the learner’s grade. For ambiguous expressions, ask a short clarification instead of guessing.

Pipecat’s `VoiceFormatter` supports Markdown cleanup and configurable replacements before TTS; `MarkdownTextFilter` removes formatting while preserving some structure. Neither is a mathematical parser. The example replacements in the supplied note that use `\b` around `+`, `-`, or `=` will generally miss those symbols because they are not word characters; replacing every `x` would also confuse the variable with a multiplication sign. Use the model’s separate speech form plus targeted, tested normalization for a pilot, and add LaTeX/MathML-aware speech rendering for complex notation. [VoiceFormatter reference](https://reference-server.pipecat.ai/en/latest/api/pipecat.utils.text.transforms.html) · [MarkdownTextFilter reference](https://reference-server.pipecat.ai/en/latest/api/pipecat.utils.text.markdown_text_filter.html)

Smallest AI’s `math_notation` option is a provider-specific TTS feature for digit-flanked operators such as `2 + 2`; it is not a Pipecat core capability and does not cover full calculus notation. Treat it as one candidate in a pronunciation evaluation, not as the math strategy. Compare spoken clarity, latency, English (South African) pronunciation, supported local languages, reliability, data terms, and cost for the chosen STT/TTS services. The Pipecat framework is open source; individual model and voice services can be hosted or metered separately. [Smallest AI Pipecat integration](https://docs.smallest.ai/integrations/agent-framework/pipecat)

## Implementation status

- Added Pipecat SmallWebRTC browser dependencies and bundled modern and compatibility PWA builds.
- Added live tutoring controls to Ask and selected Practice questions, with captions, mute, stop speaking, repeat, and end-session controls.
- Added a Pipecat FastAPI service that validates existing SharperTime sign-in, creates expiring one-use call tokens, forwards audio to the existing transcription API, and sends tutoring-only requests to the existing Ask endpoint.
- Added local browser speech with math-aware formatting and installed voice selection. Voice input is not sent to marking, and raw audio is not retained.
- Deployed the voice service on Ubuntu as a restricted, single-worker systemd service. HTTPS /voice/ proxying, UFW rules, short-lived TURN credentials, coturn UDP/TCP/TLS listeners, and certificate renewal are configured.
- GitHub Pages is disabled. The app is served locally by local_intranet_server.py at port 5501 on the A013G hotspot; the host PC can use localhost for microphone access. Other hotspot devices need trusted HTTPS for browser microphone access.
- The public voice health endpoint returns HTTP 200; an unauthenticated session request returns HTTP 401. A full signed-in browser call still needs learner acceptance on supported desktop/mobile browsers and school networks.

## Remaining delivery phases

### 1. Validate the hosted learner flow

- Run the signed-in call from the locally served app on the hotspot and verify the current client bundle.
- Try Ask and Practice on desktop Chrome/Edge, Android Chrome, and iPhone/iPad Safari; check microphone denial, reconnect, mute, interruption, device voices, common notation, and the explicit **Send for marking** action.
- Confirm direct ICE and TURN fallback from the A013G hotspot and other target networks, including any separate cloud firewall.
- Verify transcription and tutor usage are charged through the learner's existing account limits.

### 2. Improve mathematical speech

- Evaluate a curated pronunciation set covering Grade 12 algebra, functions, trigonometry, analytical geometry, probability, and calculus.
- Expand LaTeX/Unicode normalization from real tutor responses and learner/teacher feedback.
- Consider a separate display/speech response contract if math normalization cannot preserve complex notation reliably.
- Evaluate transcripts and audio with learners/teachers, including South African English, noisy rooms, different devices, and common speech-recognition confusions (`x` vs “times”, minus vs negative, decimal points, and variable names).

### 3. Harden and expand

- Test HTTPS microphone permissions, mobile PWA behavior, network handover, packet loss, browser sleep/wake, TURN fallback, concurrency, rate limits, and session cleanup.
- Add privacy-conscious operational metrics: connection success, time to first audio, interruption success, transcript correction rate, task completion, tutor quality, and cost per session. Do not log full transcripts or audio by default; define retention and access controls before enabling stored conversations.
- Roll out behind a feature flag to a small learner group. Compare completion and learning indicators with the existing text/voice-note flow before expanding to exam prep, paper/photo context, and additional grades or languages.

## Acceptance criteria for the first learner pilot

- A signed-in learner can speak to the tutor and hear its spoken reply on a supported desktop and mobile browser; denied microphone access and network failure have clear recovery paths.
- Learner speech and tutor speech are both available as readable captions, and the learner can interrupt audio and return to typing without losing the active question.
- The tutor receives the correct grade and selected question, gives stepwise help, speaks common algebra and calculus notation intelligibly, and preserves the existing tutor policy and usage limits.
- Marking happens only after the learner explicitly submits or confirms; the voice service does not retain raw audio; all provider credentials remain server-side.
- The written Ask and Practice flows remain usable when voice is unavailable or disabled.

## Decisions before broader rollout

1. Deploy `voice-service/` behind HTTPS at `/voice/` on the Ubuntu host and confirm that the server's firewall permits WebRTC UDP traffic.
2. Confirm that the existing API accounts for each transcription and tutor turn under the learner's current usage limits.
3. Configure short-lived TURN credentials for restricted mobile and school networks before a broad rollout. The current browser/device speech output requires no TTS provider.
4. Decide whether to add explicit transcript saving later. The current voice transcript remains in the active app conversation and is not stored as audio by the voice service.

## References

- [Pipecat open-source repository](https://github.com/pipecat-ai/pipecat)
- [Pipecat transport selection](https://docs.pipecat.ai/client/concepts/choosing-a-transport)
- [Pipecat SmallWebRTC server transport](https://github.com/pipecat-ai/docs/blob/main/api-reference/server/services/transport/small-webrtc.mdx)
- [Pipecat VoiceFormatter](https://reference-server.pipecat.ai/en/latest/api/pipecat.utils.text.transforms.html)
- [Pipecat MarkdownTextFilter](https://reference-server.pipecat.ai/en/latest/api/pipecat.utils.text.markdown_text_filter.html)
- [Smallest AI’s Pipecat integration and `math_notation`](https://docs.smallest.ai/integrations/agent-framework/pipecat)
