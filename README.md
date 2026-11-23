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

DUEL automatically runs in **two modes** depending on how you deploy it:

1. **Zero-Backend Static Hosting (Netlify, Vercel Static, Cloudflare Pages, GitHub Pages)**
   - Simply deploy with build command `npm run build` and publish directory `dist`.
   - When no Node.js backend is detected on `/api/health`, DUEL automatically switches to **P2P Serverless Mode** using WebRTC DataChannels + PeerJS signaling (`0.peerjs.com`) for rooms, gameplay, text chat, and live voice chat—**no backend server required**.

2. **Full-Stack Node.js Hosting (Render, Railway, Fly.io, Cloud Run)**
   - Build command: `npm install && npm run build`
   - Start command: `npm start` (runs `NODE_ENV=production node server.ts`)
   - Runs the authoritative Socket.IO server (`server.ts`) and serves `/api/ice-config` with optional `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` credentials.
   - A `render.yaml` file is included at the repo root for one-click deployment on Render.
