import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import { apiRoutes } from './api/routes';

import { createServer } from 'http';
import { Server } from 'socket.io';

dotenv.config({ override: true }); // Reload env configuration

import { WebSocketServer } from 'ws';
import { setupLlmWebSocket } from './api/routes/llm';

const app = express();
// Enable trust proxy for Traefik reverse proxy to accurately derive client IP from X-Forwarded-For
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;
const httpServer = createServer(app);

// Allowed origins: production domain + ElevenLabs (for voice WebSocket handshake)
const ALLOWED_ORIGINS = [
  'https://leadersperformance.ae',
  'https://www.leadersperformance.ae',
  'https://api.leadersperformance.ae',
  'https://staging.leadersperformance.ae',
  'https://unmasked.leadersperformance.ae',
  'https://srv826934.hstgr.cloud',
  'https://elevenlabs.io',
  'https://api.elevenlabs.io',
  'https://clarity.microsoft.com'
];


if (process.env.FRONTEND_URL) {
  const customFrontend = process.env.FRONTEND_URL.replace(/\/$/, '');
  if (!ALLOWED_ORIGINS.includes(customFrontend)) {
    ALLOWED_ORIGINS.push(customFrontend);
  }
}

// Allow localhost only in development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:4000', 'http://localhost:8080');
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

import { checkoutRouter } from './api/routes/checkout';
import { contactRouter } from './api/routes/contact';
import { articlesRoutes } from './api/routes/articles.routes';
import { unmaskedPrivateRouter } from './api/routes/unmaskedPrivate';
import { newsletterRouter } from './api/routes/newsletter';
import { masterclassRouter } from './api/routes/masterclass';
import { attributionRouter } from './api/routes/attribution';
import { booksRouter } from './api/routes/books';
import { handleStripeWebhook } from './api/controllers/stripeWebhookController';

// Prevent all search engine crawling / indexing on backend & staging requests
app.use((req, res, next) => {
  const host = (req.get('host') || '').toLowerCase();
  if (host.includes('staging') || host.includes('test') || host.includes('hstgr.cloud')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

// Explicit robots.txt for backend APIs
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use(cors(corsOptions));
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.text({ type: ['text/*', 'application/x-yaml', 'text/markdown'] }));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use('/api', checkoutRouter);
app.use('/api/v1', checkoutRouter);
app.use('/api', contactRouter);
app.use('/api/v1', contactRouter);
app.use('/attribution', attributionRouter);
app.use('/api/attribution', attributionRouter);
app.use('/api/v1/attribution', attributionRouter);
app.use('/api/newsletter', newsletterRouter);
app.use('/api/v1/newsletter', newsletterRouter);
app.use('/newsletter', newsletterRouter);
app.use('/api/v1', newsletterRouter);
app.use('/api', newsletterRouter);
app.use('/api/articles', articlesRoutes);
app.use('/api/v1/articles', articlesRoutes);
app.use('/unmasked-private', unmaskedPrivateRouter);
app.use('/api/unmasked-private', unmaskedPrivateRouter);
app.use('/api/v1/unmasked-private', unmaskedPrivateRouter);
app.use('/masterclass', masterclassRouter);
app.use('/api/masterclass', masterclassRouter);
app.use('/api/v1/masterclass', masterclassRouter);
app.use('/books', booksRouter);
app.use('/api/books', booksRouter);
app.use('/api/v1/books', booksRouter);

import { analyticsRoutes } from './modules/analytics/analytics.routes';
import { clarityRoutes } from './modules/analytics/clarity.routes';
import { RealtimePollingJob } from './modules/analytics/jobs/realtimePollingJob';
import contentRoutes from './modules/content/content.routes';
import linkedinRoutes from './modules/social/linkedin.routes';
import { LinkedInSchedulerJob } from './modules/content/jobs/linkedinSchedulerJob';

app.use('/api/analytics', analyticsRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/clarity', clarityRoutes);
app.use('/api/v1/clarity', clarityRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/v1/content', contentRoutes);
app.use('/api/social/linkedin', linkedinRoutes);
app.use('/api/v1/social/linkedin', linkedinRoutes);

import instagramRoutes from './modules/social/instagram.routes';
app.use('/api/social/instagram', instagramRoutes);
app.use('/api/v1/social/instagram', instagramRoutes);
app.use('/api/v1/integrations/instagram', instagramRoutes);
app.use('/api/integrations/instagram', instagramRoutes);

import tiktokRoutes from './modules/social/tiktok.routes';
app.use('/api/social/tiktok', tiktokRoutes);
app.use('/api/v1/social/tiktok', tiktokRoutes);
app.use('/api/v1/integrations/tiktok', tiktokRoutes);
app.use('/api/integrations/tiktok', tiktokRoutes);

// TikTok Developer Portal URL verification handler (supports root, /api, /api/v1, and /api/v1/social/tiktok prefixes)
const tiktokVerificationHandler = (req: express.Request, res: express.Response) => {
  const rawContent = process.env.TIKTOK_SITE_VERIFICATION?.trim();
  const verificationContent = rawContent
    ? rawContent.startsWith('tiktok-developers-site-verification=')
      ? rawContent
      : `tiktok-developers-site-verification=${rawContent}`
    : `tiktok-developers-site-verification=${req.params.token}`;
  res.type('text/plain').send(verificationContent);
};

app.get('/tiktok:token.txt', tiktokVerificationHandler);
app.get('/api/tiktok:token.txt', tiktokVerificationHandler);
app.get('/api/v1/tiktok:token.txt', tiktokVerificationHandler);
app.get('/api/social/tiktok/tiktok:token.txt', tiktokVerificationHandler);
app.get('/api/v1/social/tiktok/tiktok:token.txt', tiktokVerificationHandler);
app.get(
  [
    '/tiktokM8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV.txt',
    '/tiktok_M8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV.txt',
    '/api/tiktokM8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV.txt',
    '/api/tiktok_M8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV.txt',
    '/api/v1/tiktokM8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV.txt',
    '/api/v1/tiktok_M8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV.txt',
  ],
  (_req, res) => {
    res.type('text/plain').send('tiktok-developers-site-verification=M8l9oAyxWhM5ocXLCepRfVuqatZ1dBJV');
  }
);

// Backend-hosted Terms & Privacy routes under /api/* so verifying the /api/ URL prefix satisfies TikTok URL checks
app.get(['/api/terms', '/api/v1/terms', '/api/v1/social/tiktok/terms'], (_req, res) => {
  res.redirect(302, 'https://staging.leadersperformance.ae/terms');
});
app.get(['/api/privacy', '/api/v1/privacy', '/api/v1/social/tiktok/privacy'], (_req, res) => {
  res.redirect(302, 'https://staging.leadersperformance.ae/privacy');
});

// Stripe Webhook Endpoint (Universal)
app.post('/api/v1/webhooks/stripe', handleStripeWebhook);
app.post('/api/webhooks/stripe', handleStripeWebhook);
app.post('/webhooks/stripe', handleStripeWebhook);
app.get('/review', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, `/masterclass/review${query}`);
});
app.get('/review/:ref', (req, res) => {
  res.redirect(302, `/masterclass/review/${encodeURIComponent(req.params.ref)}`);
});
app.get('/api/review', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, `/api/masterclass/review${query}`);
});
app.get('/api/review/:ref', (req, res) => {
  res.redirect(302, `/api/masterclass/review/${encodeURIComponent(req.params.ref)}`);
});
app.use('/api/v1', apiRoutes);
app.use('/', newsletterRouter);


import { swaggerBasicAuth } from './middleware/swaggerAuth';

app.use('/api-docs', swaggerBasicAuth, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/docs', swaggerBasicAuth, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/docs', swaggerBasicAuth, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const healthCheckHandler = (_req: express.Request, res: express.Response) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend is running',
    timestamp: new Date().toISOString(),
  });
};

app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);
app.get('/api/v1/health', healthCheckHandler);

const pingHandler = (_req: express.Request, res: express.Response) => {
  res.status(200).json({ message: 'pong' });
};

app.get('/ping', pingHandler);
app.get('/api/ping', pingHandler);

import { syncDefaultReferralsToDb } from './services/masterclassReferralService';
import { ensureAudiobookFromSupabase } from './services/audiobookService';
import { initAppointmentReminderWorker } from './services/reminderService';

import { validateAnalyticsCredentials } from './modules/analytics/adapters/credentialValidator';
import { GscIngestionJob } from './modules/analytics/jobs/gscIngestionJob';
import { LinkedInAnalyticsSyncJob } from './modules/analytics/jobs/linkedinAnalyticsSyncJob';
import { InstagramAnalyticsSyncJob } from './modules/analytics/jobs/instagramAnalyticsSyncJob';

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  const creds = validateAnalyticsCredentials();
  console.log(`[Startup] Analytics credentials validated on boot: GA4 (${creds.ga4.isConfigured ? 'OK' : 'MISSING'}), GSC (${creds.gsc.isConfigured ? 'OK' : 'MISSING'}), Clarity (${creds.clarity.isConfigured ? 'OK' : 'DECOUPLED'}), GHL (${creds.ghl.isConfigured ? 'OK' : 'WEBHOOK_ONLY'})`);
  RealtimePollingJob.start();
  GscIngestionJob.start();
  LinkedInSchedulerJob.start();
  LinkedInAnalyticsSyncJob.start();
  InstagramAnalyticsSyncJob.start();
  syncDefaultReferralsToDb().catch((e) => console.warn('[Startup] Referral sync notice:', e?.message));
  ensureAudiobookFromSupabase().catch((e) => console.warn('[Startup] Audiobook sync notice:', e?.message));
  initAppointmentReminderWorker();
});
