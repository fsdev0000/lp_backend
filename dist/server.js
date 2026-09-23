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
dotenv_1.default.config(); // Reload env configuration
const ws_1 = require("ws");
const llm_1 = require("./api/routes/llm");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
const httpServer = (0, http_1.createServer)(app);
// Allowed origins: production domain + ElevenLabs (for voice WebSocket handshake)
const ALLOWED_ORIGINS = [
    'https://leadersperformance.ae',
    'https://www.leadersperformance.ae',
    'https://api.leadersperformance.ae',
    'https://srv826934.hstgr.cloud',
    'https://elevenlabs.io',
    'https://api.elevenlabs.io',
];
if (process.env.FRONTEND_URL) {
    const customFrontend = process.env.FRONTEND_URL.replace(/\/$/, '');
    if (!ALLOWED_ORIGINS.includes(customFrontend)) {
        ALLOWED_ORIGINS.push(customFrontend);
    }
}
// Allow localhost only in development
if (process.env.NODE_ENV !== 'production') {
    ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:4000', 'http://localhost:8080');
}
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
        // NOTE: Remove this if you want to block all non-browser requests
        if (!origin)
            return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        console.warn(`[CORS] Blocked request from unauthorized origin: ${origin}`);
        return callback(new Error(`CORS policy: origin ${origin} is not allowed`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-api-key',
        'apikey',
        'x-client-info',
        'x-slug',
        'x-title',
        'x-excerpt',
        'x-pillar',
        'x-meta-title',
        'x-meta-description',
        'x-pillar-color',
        'x-keywords',
        'x-publish-date',
        'x-reading-time',
        'x-author',
        'x-published',
    ],
    credentials: true,
};
// Setup Socket.IO for general purpose real-time connection
exports.io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST']
    }
});
// Setup standard WebSocket for ElevenLabs Custom LLM
const wss = new ws_1.WebSocketServer({ noServer: true });
(0, llm_1.setupLlmWebSocket)(wss);
httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url ? request.url.split('?')[0] : '';
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
const checkout_1 = require("./api/routes/checkout");
const contact_1 = require("./api/routes/contact");
const articles_routes_1 = require("./api/routes/articles.routes");
app.use((0, cors_1.default)(corsOptions));
app.use(express_1.default.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    },
}));
app.use(express_1.default.text({ type: ['text/*', 'application/x-yaml', 'text/markdown'] }));
app.use('/api', checkout_1.checkoutRouter);
app.use('/api/v1', checkout_1.checkoutRouter);
app.use('/api', contact_1.contactRouter);
app.use('/api/v1', contact_1.contactRouter);
app.use('/api/articles', articles_routes_1.articlesRoutes);
app.use('/api/v1/articles', articles_routes_1.articlesRoutes);
app.use('/api/v1', routes_1.apiRoutes);
app.use('/api-docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Backend is running' });
});
httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
