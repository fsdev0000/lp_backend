"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_1 = require("./config/swagger");
const routes_1 = require("./api/routes");
const http_1 = require("http");
const socket_io_1 = require("socket.io");
dotenv_1.default.config();
const ws_1 = require("ws");
const llm_1 = require("./api/routes/llm");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
const httpServer = (0, http_1.createServer)(app);
// Setup Socket.IO for general purpose real-time connection
exports.io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: '*', // Adjust for production if needed
        methods: ['GET', 'POST']
    }
});
// Setup standard WebSocket for ElevenLabs Custom LLM
const wss = new ws_1.WebSocketServer({ noServer: true });
(0, llm_1.setupLlmWebSocket)(wss);
httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    if (pathname === '/api/v1/voice/llm-stream') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
    else {
        // Socket.io handles upgrades that don't match our custom path automatically 
        // when it intercepts the server. We don't need to manually route it unless disabled.
    }
});
exports.io.on('connection', (socket) => {
    console.log('A user connected via socket.io');
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});
app.set('io', exports.io);
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use('/api/v1', routes_1.apiRoutes);
app.use('/api-docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Backend is running' });
});
httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
