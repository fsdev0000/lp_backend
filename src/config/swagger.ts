import swaggerJSDoc from 'swagger-jsdoc';

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Leaders Performance API',
      version: '1.0.0',
      description: 'API documentation for Leaders Performance Backend Middleware, including Reset by Discipline English Audiobook streaming, checkout, and entitlement verification.',
    },
    tags: [
      {
        name: 'Health',
        description: 'System health and liveness checks (Monitored first)',
      },
      {
        name: 'Books / Audiobook',
        description: 'Reset by Discipline Audiobook — 60-second preview, Stripe Hosted Checkout, verified purchase entitlement, and private Range streaming',
      },
      {
        name: 'Webhooks',
        description: 'Stripe webhook receiver and automated payment verification',
      },
      {
        name: 'Unmasked Private',
        description: 'UNMASKED PRIVATE Application & Investment Routing',
      },
      {
        name: 'Consent',
        description: 'Enterprise Cookie and Privacy Consent Architecture',
      },
      {
        name: 'Contact',
        description: 'Strategic consultation and contact enquiries',
      },
      {
        name: 'Articles',
        description: 'Thought leadership articles and publications',
      },
      {
        name: 'Newsletter',
        description: 'The Founder Performance Newsletter subscription, suppression, and monthly campaign dispatch',
      },
      {
        name: 'Masterclass',
        description: 'The Founder’s Next Move — Executive Masterclass, Interactive Workbook, Stripe Enrollment & 1-on-1 Strategic Review Scheduling',
      },
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Health check endpoint',
          description: 'Returns backend server health and uptime status. Verified first for monitoring.',
          tags: ['Health'],
          responses: {
            200: {
              description: 'Backend is healthy and operational',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      message: { type: 'string', example: 'Backend is running' },
                      timestamp: { type: 'string', example: '2026-10-16T11:00:00.000Z' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/books/{bookId}/audio/preview': {
        get: {
          summary: 'Stream free 60-second audiobook preview',
          description: 'Allows visitors to listen to the first 60 seconds of the audiobook without payment. Enforces strict backend byte-level clamping. HTTP Range requests beyond the 60-second limit are rejected with 416 Range Not Satisfiable.',
          tags: ['Books / Audiobook'],
          parameters: [
            {
              name: 'bookId',
              in: 'path',
              required: true,
              schema: { type: 'string', default: 'reset-by-discipline' },
              description: 'Identifier of the book (e.g. reset-by-discipline or reset-by-discipline-en)',
            },
            {
              name: 'Range',
              in: 'header',
              required: false,
              schema: { type: 'string', example: 'bytes=0-1024' },
              description: 'Standard HTTP Range request header for media buffering/seeking',
            },
          ],
          responses: {
            200: {
              description: 'Full preview audio stream (first 60 seconds)',
              headers: {
                'Content-Type': { schema: { type: 'string', example: 'audio/mpeg' } },
                'Accept-Ranges': { schema: { type: 'string', example: 'bytes' } },
                'Content-Length': { schema: { type: 'integer', example: 960000 } },
              },
              content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } },
            },
            206: {
              description: 'Partial preview audio stream within the 60-second limit',
              headers: {
                'Content-Type': { schema: { type: 'string', example: 'audio/mpeg' } },
                'Content-Range': { schema: { type: 'string', example: 'bytes 0-1024/960000' } },
                'Content-Length': { schema: { type: 'integer', example: 1025 } },
              },
              content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } },
            },
            404: {
              description: 'Book or audio file not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { error: { type: 'string', example: 'Book not found' } },
                  },
                },
              },
            },
            416: {
              description: 'Range Not Satisfiable — Requested byte range exceeds the 60-second preview ceiling',
              headers: {
                'Content-Range': { schema: { type: 'string', example: 'bytes */960000' } },
              },
            },
          },
        },
      },

      '/books/{bookId}/checkout': {
        post: {
          summary: 'Initiate Stripe Hosted Checkout for Audiobook',
          description: 'Creates a Stripe Hosted Checkout Session on the backend using the configured Stripe Price ID for the English audiobook. Associates the checkout session with the purchase record in pending status.',
          tags: ['Books / Audiobook'],
          parameters: [
            {
              name: 'bookId',
              in: 'path',
              required: true,
              schema: { type: 'string', default: 'reset-by-discipline' },
              description: 'Identifier of the book',
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    customerEmail: { type: 'string', format: 'email', example: 'reader@example.com' },
                    customerName: { type: 'string', example: 'Alex Smith' },
                    returnPath: { type: 'string', example: '/knowledge?book-name=reset-by-discipline&product=audiobook' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Stripe Hosted Checkout URL created successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      url: { type: 'string', example: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3...' },
                      checkoutUrl: { type: 'string', example: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3...' },
                      sessionId: { type: 'string', example: 'cs_test_a1b2c3d4e5f6' },
                      bookId: { type: 'string', example: 'reset-by-discipline' },
                    },
                  },
                },
              },
            },
            400: {
              description: 'Invalid book ID or Stripe configuration error',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'string', example: 'Failed to create checkout session' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            404: {
              description: 'Book not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { error: { type: 'string', example: 'Book not found' } },
                  },
                },
              },
            },
          },
        },
      },

      '/books/{bookId}/access': {
        get: {
          summary: 'Check purchase access & retrieve entitlement',
          description: 'Allows the frontend to verify purchase access using either an existing entitlement token (via Authorization: Bearer, x-purchase-token header, or ?token= query parameter) OR a Stripe Checkout session ID (?session_id=cs_...). Returns purchase entitlement details without exposing sensitive payment info.',
          tags: ['Books / Audiobook'],
          parameters: [
            {
              name: 'bookId',
              in: 'path',
              required: true,
              schema: { type: 'string', default: 'reset-by-discipline' },
              description: 'Identifier of the book',
            },
            {
              name: 'token',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Existing purchase entitlement token',
            },
            {
              name: 'session_id',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Stripe Checkout Session ID from post-checkout redirect',
            },
            {
              name: 'x-purchase-token',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Purchase entitlement token header',
            },
            {
              name: 'Authorization',
              in: 'header',
              required: false,
              schema: { type: 'string', example: 'Bearer ab_ent_1a2b3c...' },
              description: 'Bearer token header with purchase entitlement',
            },
          ],
          responses: {
            200: {
              description: 'Access status checked',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      hasAccess: { type: 'boolean', example: true },
                      bookId: { type: 'string', example: 'reset-by-discipline' },
                      accessToken: { type: 'string', example: 'ab_ent_0123456789abcdef0123456789abcdef...' },
                      customerEmail: { type: 'string', example: 'reader@example.com' },
                      paidAt: { type: 'string', example: '2026-10-16T11:00:00.000Z' },
                      message: { type: 'string', example: 'Purchase verified' },
                    },
                  },
                },
              },
            },
            404: {
              description: 'Book not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { hasAccess: { type: 'boolean', example: false }, error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },

      '/books/{bookId}/audio': {
        get: {
          summary: 'Stream full private audiobook (Authorized purchases only)',
          description: 'Streams the complete private audiobook with full HTTP Range request support. Requires a valid, cryptographically unguessable purchase entitlement token. The full audio file is kept in private storage and never exposed via public URLs.',
          tags: ['Books / Audiobook'],
          security: [
            { purchaseTokenAuth: [] },
            { bearerAuth: [] },
          ],
          parameters: [
            {
              name: 'bookId',
              in: 'path',
              required: true,
              schema: { type: 'string', default: 'reset-by-discipline' },
              description: 'Identifier of the book',
            },
            {
              name: 'token',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Purchase entitlement token (convenient for HTML5 <audio> tag src)',
            },
            {
              name: 'x-purchase-token',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Purchase entitlement token header',
            },
            {
              name: 'Range',
              in: 'header',
              required: false,
              schema: { type: 'string', example: 'bytes=100000-500000' },
              description: 'HTTP Range header for seeking and chunked audio playback',
            },
          ],
          responses: {
            200: {
              description: 'Complete audio file stream',
              headers: {
                'Content-Type': { schema: { type: 'string', example: 'audio/mpeg' } },
                'Accept-Ranges': { schema: { type: 'string', example: 'bytes' } },
                'Content-Length': { schema: { type: 'integer', example: 2145000 } },
                'Cache-Control': { schema: { type: 'string', example: 'private, no-cache, no-store, must-revalidate' } },
              },
              content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } },
            },
            206: {
              description: 'Partial Content audio chunk',
              headers: {
                'Content-Type': { schema: { type: 'string', example: 'audio/mpeg' } },
                'Content-Range': { schema: { type: 'string', example: 'bytes 100000-500000/2145000' } },
                'Content-Length': { schema: { type: 'integer', example: 400001 } },
              },
              content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } },
            },
            401: {
              description: 'Unauthorized — Missing purchase entitlement token',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'string', example: 'Unauthorized' },
                      message: { type: 'string', example: 'Purchase entitlement token is required to access the complete audiobook' },
                    },
                  },
                },
              },
            },
            403: {
              description: 'Forbidden — Invalid, unconfirmed, or expired purchase entitlement token',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'string', example: 'Forbidden' },
                      message: { type: 'string', example: 'Access denied: invalid or unconfirmed purchase entitlement' },
                    },
                  },
                },
              },
            },
            404: {
              description: 'Book or audio file not found',
            },
            416: {
              description: 'Range Not Satisfiable',
            },
          },
        },
      },

      '/webhooks/stripe': {
        post: {
          summary: 'Universal Stripe Webhook Handler',
          description: 'Handles incoming webhook notifications from Stripe (e.g. checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired). Verifies Stripe signatures and processes events idempotently.',
          tags: ['Webhooks'],
          parameters: [
            {
              name: 'stripe-signature',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'HMAC-SHA256 signature generated by Stripe using the configured webhook signing secret',
            },
          ],
          requestBody: {
            required: true,
            description: 'Raw Stripe event JSON payload',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: {
            200: {
              description: 'Event processed successfully or acknowledged idempotently',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      received: { type: 'boolean', example: true },
                      success: { type: 'boolean', example: true },
                      message: { type: 'string', example: 'Audiobook checkout session processed' },
                    },
                  },
                },
              },
            },
            400: {
              description: 'Signature verification failure or environment livemode mismatch',
            },
            500: {
              description: 'Internal server error while processing event',
            },
          },
        },
      },
    },
    servers: [
      {
        url: '/api/v1',
        description: 'V1 API Prefix (Standard)',
      },
      {
        url: '/',
        description: 'Root URL',
      },
    ],
    components: {
      securitySchemes: {
        basicAuth: {
          type: 'http',
          scheme: 'basic',
          description: 'HTTP Basic Authentication for administrative and API documentation access.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Token',
          description: 'Bearer token for purchase entitlement or protected video access (Authorization: Bearer ab_ent_...).',
        },
        purchaseTokenAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-purchase-token',
          description: 'Cryptographically unguessable purchase entitlement token (can also be passed as Authorization: Bearer <token> or query parameter ?token=).',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API key for management and protected endpoints.',
        },
      },
    },
    security: [
      {
        basicAuth: [],
      },
    ],
  },
  apis:
    process.env.NODE_ENV === 'production'
      ? ['./dist/api/routes/*.js']
      : ['./src/api/routes/*.ts'], // Scan src in dev, dist only in production
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
