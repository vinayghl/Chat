import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { cleanupExpiredRooms, getActiveRoomCount } from './server/rooms.ts';
import { registerSocketHandlers } from './server/socketHandlers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function bootstrap() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io/',
    transports: ['polling', 'websocket'],
    allowEIO3: true,
    cors: {
      origin: true,
      credentials: true,
    },
    pingInterval: 15000,
    pingTimeout: 20000,
  });

  registerSocketHandlers(io);

  // Periodic sweep of inactive / expired temporary rooms (every 60s)
  const sweepTimer = setInterval(() => {
    cleanupExpiredRooms();
  }, 60_000);
  sweepTimer.unref();

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      activeRooms: getActiveRoomCount(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // Serves STUN and optional TURN server credentials from environment variables
  app.get('/api/ice-config', (_req, res) => {
    const iceServers: RTCIceServer[] = [
      {
        urls: process.env.STUN_URL
          ? process.env.STUN_URL.split(',').map((u) => u.trim()).filter(Boolean)
          : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
      },
    ];

    const turnUrl = process.env.TURN_URL?.trim();
    const turnUsername = process.env.TURN_USERNAME?.trim();
    const turnCredential = process.env.TURN_CREDENTIAL?.trim();

    let hasTurn = false;
    if (turnUrl) {
      const turnEntry: RTCIceServer = {
        urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
      };
      if (turnUsername) turnEntry.username = turnUsername;
      if (turnCredential) turnEntry.credential = turnCredential;
      iceServers.push(turnEntry);
      hasTurn = true;
    }

    res.json({ iceServers, hasTurn });
  });

  const distPath = path.resolve(__dirname, 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isDevMode =
    process.env.NODE_ENV === 'development' ||
    (!hasDist && process.env.NODE_ENV !== 'production');

  if (isDevMode) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true' ? { server: httpServer } : false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.warn(
        'Warning: dist/index.html not found. Run "npm run build" before starting in production.'
      );
    }
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(
      `DUEL multiplayer server (${isDevMode ? 'dev' : 'production'}) listening on http://0.0.0.0:${port}`
    );
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start DUEL server:', err);
  process.exit(1);
});
