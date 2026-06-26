# RoboEyes — Animated Robot Eyes PWA

A quirky animated robot-eyes web app built for **iPhone Standby mode** (landscape, on charger). Add it to your home screen and it runs full-screen and offline.

**Live:** https://robot-eyes.vercel.app

## Features
- **Expressive eyes** — 18 moods (happy, angry, tired, curious, dizzy, scared…), smooth blinking, gaze tracking, micro-saccades.
- **Glitch effects** — RGB split, static noise, shake, invert, position jumps.
- **Swipe pages** — eyes (center) · swipe right → **Bangkok clock (GMT+7)** · swipe left → **music** page.
- **Music** — load a local audio file; eyes pulse/bounce to the beat (Web Audio `AnalyserNode`).
- **Color themes** — tap 🎨 to switch the glow color (white, cyan, blue, green, yellow, orange, pink, purple).
- **Sound** — procedural Web Audio SFX with a mute toggle.
- **PWA** — installable, offline via service worker, landscape-locked, dark, no zoom.

## Tech
Pure static HTML/CSS/JS — no build step, no dependencies.

## Run locally
```bash
python -m http.server 8000
# open http://localhost:8000
```

## Deploy
Auto-deploys to Vercel on every push to `main`.
