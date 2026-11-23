# DUEL — Online Multiplayer Snake & Ladders

**Two Friends. One Battle.**

DUEL is a real-time, mobile-first two-player Snake & Ladders web game with live peer-to-peer WebRTC voice chat and room text chat. Rooms exist strictly in temporary server memory with no databases, no user accounts, and no persistent storage.

## Features

- **Private 2-Player Rooms**: 6-character random room codes, copyable invite links, max 2 players, and automatic room expiration after inactivity.
- **Authoritative Real-Time Gameplay**: Server-validated dice rolls (`1–6`), turn enforcement, exact-100 finish rule, step-by-step board movement, snakes, and ladders synchronized via Socket.IO.
- **Live Two-Way Voice Chat (WebRTC)**: Peer-to-peer audio via `getUserMedia` + `RTCPeerConnection` with Socket.IO signaling, Perfect Negotiation, STUN + configurable TURN relay support, mute/unmute, speaking activity detection, and reconnection recovery.
- **In-Room Text Chat**: Quick-tap phrases and live text messages in both the lobby and game screens.
- **Synthesized Sound Effects**: Web Audio API dice rattles, token steps, ladder chimes, snake slides, and victory fanfare with a mute toggle.

## Project Structure

- `server.ts` — Express HTTP server, `/api/ice-config`, `/api/health`, Socket.IO server, and Vite/static serving.
- `server/rooms.ts` — Ephemeral in-memory room store, unique 6-character codes, reconnection verification, and expiration cleanup.
- `server/gameLogic.ts` — Authoritative Snake & Ladders rules, dice RNG, and move history.
- `server/socketHandlers.ts` — Room creation, joining, readiness, dice rolling, chat, rematch, and disconnection handling.
- `server/voiceSignaling.ts` — Socket.IO relay for WebRTC SDP offers/answers, ICE candidates, and mic/speaking states.
- `src/shared/gameConstants.ts` — Shared board coordinates, snakes/ladders map, and TypeScript types.
- `src/socket/socketClient.ts` — Socket.IO client singleton, `VITE_SERVER_URL` resolution, and transport fallback.
- `src/voice/useWebRTCVoice.ts` — WebRTC peer connection, Perfect Negotiation, STUN/TURN, and speaking level detection.
- `src/components/` — `HomeScreen`, `LobbyScreen`, `GameScreen`, `SnakeAndLaddersBoard`, `Dice3D`, `VoiceControls`, `ChatBox`, `PlayerAvatar`, `HowToPlayModal`, `AnimatedBackground`.

## Installation & Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Optionally configure `.env` from `.env.example` (recommended to add TURN credentials for users behind strict cellular/corporate NATs):
   ```env
   STUN_URL="stun:stun.l.google.com:19302"
   TURN_URL="turn:your-turn-server.example.com:3478"
   TURN_USERNAME="your-username"
   TURN_CREDENTIAL="your-password"
   PORT="3000"
   ```
3. Start the full-stack development server:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in two browser windows or on two devices on your network.

## Deployment Guide

> **Important:** DUEL requires a running **Node.js server** (`server.ts`) for Socket.IO multiplayer rooms and WebRTC signaling. **Static-only hosts like Netlify, Vercel Static, or GitHub Pages cannot run `server.ts` by themselves.**

### Option A (Recommended): Deploy Full-Stack on Render, Railway, Fly.io, or Cloud Run
Both the React frontend and the Node.js Socket.IO backend run together in one service:

1. **Build Command**: `npm install && npm run build`
2. **Start Command**: `npm start` (runs `NODE_ENV=production node server.ts`)
3. **Node Version**: Node 22+ (uses native TypeScript execution for `server.ts`)
4. **Render Blueprint**: A `render.yaml` file is included at the repo root for instant deployment on Render.
5. **HTTPS**: All of these platforms provide HTTPS automatically, which is required by iOS Safari and Android Chrome for microphone access.

### Option B: Keep Frontend on Netlify + Host Backend on Render / Railway
If you want to keep your frontend at `https://your-site.netlify.app`:

1. Deploy this repository as a **Web Service** on **Render** or **Railway** (`npm install && npm run build`, start: `npm start`).
   - Optionally set `CLIENT_ORIGIN=https://your-site.netlify.app` on the backend service.
2. In **Netlify → Site configuration → Environment variables**, add:
   - `VITE_SERVER_URL=https://your-backend-service.onrender.com`
3. Trigger a **Clear cache and deploy site** in Netlify so Vite bundles `VITE_SERVER_URL` into the frontend.
