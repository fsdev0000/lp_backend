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

// Setup Socket.IO for general purpose real-time connection
export const io = new Server(httpServer, {
  cors: {
    origin: '*', // Adjust for production if needed
    methods: ['GET', 'POST']
  }
});

// Setup standard WebSocket for ElevenLabs Custom LLM
const wss = new WebSocketServer({ noServer: true });
setupLlmWebSocket(wss);

httpServer.on('upgrade', (request, socket, head) => {
  const pathname = request.url;
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

app.use(cors());
app.use(express.json());

app.use('/api/v1', apiRoutes);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend is running' });
});

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
