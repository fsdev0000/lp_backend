import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import { apiRoutes } from './api/routes';

import { createServer } from 'http';
import { Server } from 'socket.io';

dotenv.config();

import { WebSocketServer } from 'ws';
import { setupLlmWebSocket } from './api/routes/llm';

const app = express();
const PORT = process.env.PORT || 4000;
const httpServer = createServer(app);

// Allowed origins: production domain + ElevenLabs (for voice WebSocket handshake)
const ALLOWED_ORIGINS = [
  'https://leadersperformance.ae',
  'https://www.leadersperformance.ae',
  'https://api.leadersperformance.ae',
  'https://elevenlabs.io',
  'https://api.elevenlabs.io',
];

// Allow localhost only in development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:4000');
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
    // NOTE: Remove this if you want to block all non-browser requests
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked request from unauthorized origin: ${origin}`);
    return callback(new Error(`CORS policy: origin ${origin} is not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// Setup Socket.IO for general purpose real-time connection
export const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});

// Setup standard WebSocket for ElevenLabs Custom LLM
const wss = new WebSocketServer({ noServer: true });
setupLlmWebSocket(wss);

httpServer.on('upgrade', (request, socket, head) => {
  const pathname = request.url ? request.url.split('?')[0] : '';
  if (pathname === '/api/v1/voice/llm-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // Socket.io handles upgrades that don't match our custom path automatically 
    // when it intercepts the server. We don't need to manually route it unless disabled.
  }
});

io.on('connection', (socket) => {
  console.log('A user connected via socket.io');
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

app.set('io', io);

app.use(cors(corsOptions));
app.use(express.json());

app.use('/api/v1', apiRoutes);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend is running' });
});

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
