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
      {
        name: 'Analytics & Performance',
        description: 'Decoupled Business Intelligence, GA4/GSC/Clarity telemetry cache, multi-channel social matrix, and SSE realtime streaming',
      },
      {
        name: 'Microsoft Clarity UX & Telemetry',
        description: 'Multi-website Microsoft Clarity UX telemetry, session recordings with validated playback URLs for Social CRM embed, live metric cache, and rage-click anomaly detection',
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

      '/analytics/overview': {
        get: {
          summary: 'Consolidated Business Intelligence & Web Vitals Overview',
          description: 'Returns top executive KPIs, 30-day session trend lines from GA4, UTM campaign yield table, and recent qualified founder inbound leads with sub-150ms cached response SLA.',
          tags: ['Analytics & Performance'],
          parameters: [
            {
              name: 'range',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['7d', '30d', '90d', 'all'], default: '30d' },
              description: 'Historical date filter range',
            },
          ],
          responses: {
            200: {
              description: 'Aggregated analytics metrics, traffic history, and campaign yield',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          metrics: {
                            type: 'object',
                            properties: {
                              totalAudience: { type: 'number', example: 148520 },
                              audienceGrowth: { type: 'number', example: 18.4 },
                              highIntentLeads: { type: 'number', example: 342 },
                              leadsGrowth: { type: 'number', example: 26.2 },
                              avgConversionRate: { type: 'number', example: 8.42 },
                              conversionGrowth: { type: 'number', example: 2.1 },
                              pipelineValueEur: { type: 'number', example: 4250000 },
                              pipelineGrowth: { type: 'number', example: 34.0 },
                              realtimeActiveVisitors: { type: 'number', example: 128 },
                              ingestionLatencyMs: { type: 'number', example: 24 },
                            },
                          },
                          trafficHistory: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                date: { type: 'string', example: '10/01' },
                                visitors: { type: 'number', example: 1120 },
                                leads: { type: 'number', example: 9 },
                                pageviews: { type: 'number', example: 3410 },
                              },
                            },
                          },
                          topCampaigns: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                campaign: { type: 'string', example: 'q4_founder_scaling_masterclass' },
                                source: { type: 'string', example: 'linkedin_direct' },
                                impressions: { type: 'number', example: 48200 },
                                clicks: { type: 'number', example: 3280 },
                                leads: { type: 'number', example: 142 },
                                convRate: { type: 'string', example: '4.3%' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            502: {
              description: 'Upstream telemetry or database communication failure',
            },
          },
        },
      },

      '/analytics/channels': {
        get: {
          summary: 'Cross-Platform Social Intelligence Matrix',
          description: 'Returns audience, engagement ratios, leads captured, and pipeline yield across LinkedIn, YouTube, Instagram, and TikTok.',
          tags: ['Analytics & Performance'],
          responses: {
            200: {
              description: 'Array of platform metrics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string', example: 'linkedin' },
                            name: { type: 'string', example: 'LinkedIn (Executive)' },
                            followers: { type: 'number', example: 48920 },
                            engagementRate: { type: 'number', example: 6.84 },
                            postsMonth: { type: 'number', example: 24 },
                            leadsGenerated: { type: 'number', example: 184 },
                            pipelineValueEur: { type: 'number', example: 2840000 },
                            color: { type: 'string', example: '#0A66C2' },
                            trend: { type: 'string', example: '+24.5%' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/analytics/keywords': {
        get: {
          summary: 'Google Search Console Top Organic Queries & Real Totals',
          description: 'Retrieves top organic search queries alongside real aggregate site totals (including hidden and anonymized queries). Supports multi-domain filtering (`leadersperformance.ae`, `lioneleersteling.com`) and flexible date ranges (`7d`, `30d`, `90d` or explicit `startDate` / `endDate`).',
          tags: ['Analytics & Performance'],
          parameters: [
            {
              name: 'domain',
              in: 'query',
              required: false,
              schema: { type: 'string', default: 'leadersperformance.ae' },
              description: 'Target website domain (e.g. leadersperformance.ae or lioneleersteling.com)',
            },
            {
              name: 'range',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['7d', '14d', '28d', '30d', '90d', 'all'], default: '30d' },
              description: 'Date range filter. Standardizes against GSC finalized 2-day reporting lag.',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 100 },
              description: 'Maximum number of keyword rows to return',
            },
            {
              name: 'startDate',
              in: 'query',
              required: false,
              schema: { type: 'string', example: '2026-10-21' },
              description: 'Optional explicit start date (YYYY-MM-DD)',
            },
            {
              name: 'endDate',
              in: 'query',
              required: false,
              schema: { type: 'string', example: '2026-10-27' },
              description: 'Optional explicit end date (YYYY-MM-DD)',
            },
          ],
          responses: {
            200: {
              description: 'GSC queries and genuine site totals',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          totals: {
                            type: 'object',
                            properties: {
                              clicks: { type: 'number', example: 9 },
                              impressions: { type: 'number', example: 147 },
                              ctr: { type: 'string', example: '6.1%' },
                              position: { type: 'number', example: 26.8 },
                            },
                          },
                          queries: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                query: { type: 'string', example: 'leaders performance' },
                                impressions: { type: 'number', example: 17 },
                                clicks: { type: 'number', example: 7 },
                                ctr: { type: 'string', example: '41.2%' },
                                position: { type: 'number', example: 1.6 },
                              },
                            },
                          },
                          range: { type: 'string', example: '7d' },
                          domain: { type: 'string', example: 'https://leadersperformance.ae/' },
                          startDate: { type: 'string', example: '2026-10-21' },
                          endDate: { type: 'string', example: '2026-10-27' },
                          totalQueries: { type: 'number', example: 22 },
                        },
                      },
                      totals: {
                        type: 'object',
                        description: 'Top-level duplicate of totals for direct CRM accessibility',
                      },
                      queries: {
                        type: 'array',
                        description: 'Top-level duplicate of query list for direct CRM accessibility',
                      },
                    },
                  },
                },
              },
            },
            502: {
              description: 'Search Console API communication failure',
            },
          },
        },
      },

      '/analytics/telemetry': {
        get: {
          summary: 'Microsoft Clarity UX & Session Signals',
          description: 'Returns executive dwell time, rage click ratio, dead clicks, and active telemetry streams.',
          tags: ['Analytics & Performance'],
          responses: {
            200: {
              description: 'Clarity UX telemetry signals',
            },
          },
        },
      },

      '/analytics/integrations/status': {
        get: {
          summary: 'External Integrations Health Check',
          description: 'Evaluates live connectivity, round-trip latency, and sync status for GA4, Google Search Console, Microsoft Clarity, and GoHighLevel.',
          tags: ['Analytics & Performance'],
          responses: {
            200: {
              description: 'Array of provider health statuses',
            },
          },
        },
      },

      '/analytics/integrations/ping/{id}': {
        post: {
          summary: 'Immediate Provider Health Probe',
          description: 'Executes an immediate live probe against a specified provider (ga4, gsc, clarity, ghl) and returns round-trip latency in milliseconds.',
          tags: ['Analytics & Performance'],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['ga4', 'gsc', 'clarity', 'ghl'] },
              description: 'Provider identifier',
            },
          ],
          responses: {
            200: {
              description: 'Ping latency and status',
            },
          },
        },
      },

      '/analytics/realtime/stream': {
        get: {
          summary: 'Server-Sent Events (SSE) Live Telemetry Stream',
          description: 'Unidirectional persistent HTTP/2 event stream transmitting realtime active visitor counts and inbound lead alerts with automatic 15s heartbeat.',
          tags: ['Analytics & Performance'],
          responses: {
            200: {
              description: 'text/event-stream active stream',
            },
          },
        },
      },

      '/analytics/reports-snapshot': {
        get: {
          summary: 'Google Analytics 4 Reports Snapshot',
          description: 'Retrieves Google Analytics 4 executive reports snapshot including active users, new users, average engagement duration, top pages with bounce rates, traffic sources, session sources, and breakdowns by both countries and cities.',
          tags: ['Analytics & Performance'],
          parameters: [
            {
              name: 'startDate',
              in: 'query',
              required: false,
              schema: { type: 'string', default: '30daysAgo' },
              description: 'Start date in YYYY-MM-DD or relative format (e.g. 30daysAgo, 7daysAgo)',
            },
            {
              name: 'endDate',
              in: 'query',
              required: false,
              schema: { type: 'string', default: 'today' },
              description: 'End date in YYYY-MM-DD or relative format (e.g. today)',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 10 },
              description: 'Maximum number of items per dimension list',
            },
          ],
          responses: {
            200: {
              description: 'Live GA4 snapshot with country and city metrics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          summary: {
                            type: 'object',
                            properties: {
                              activeUsers: { type: 'number', example: 209 },
                              newUsers: { type: 'number', example: 192 },
                              averageEngagementTimeSeconds: { type: 'number', example: 45 },
                              averageEngagementTimeFormatted: { type: 'string', example: '45s' },
                              eventCount: { type: 'number', example: 2500 },
                            },
                          },
                          topPages: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                pageTitle: { type: 'string', example: 'Escape the Founder Identity Trap: Reclaim Your Business' },
                                views: { type: 'number', example: 545 },
                                activeUsers: { type: 'number', example: 8 },
                                eventCount: { type: 'number', example: 645 },
                                bounceRate: { type: 'string', example: '41.7%' },
                              },
                            },
                          },
                          usersBySourceMedium: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: '(direct) / (none)' },
                                value: { type: 'number', example: 170 },
                              },
                            },
                          },
                          sessionsBySourceMedium: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: '(direct) / (none)' },
                                value: { type: 'number', example: 212 },
                              },
                            },
                          },
                          usersByCountry: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: 'United Arab Emirates' },
                                value: { type: 'number', example: 88 },
                              },
                            },
                          },
                          usersByCity: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: 'Dubai' },
                                value: { type: 'number', example: 82 },
                              },
                            },
                          },
                          geographicHierarchy: {
                            type: 'array',
                            description: 'Nested location hierarchy (Country -> Cities) with active user breakdowns',
                            items: {
                              type: 'object',
                              properties: {
                                country: { type: 'string', example: 'Pakistan' },
                                activeUsers: { type: 'number', example: 67 },
                                cities: {
                                  type: 'array',
                                  items: {
                                    type: 'object',
                                    properties: {
                                      city: { type: 'string', example: 'Lahore' },
                                      activeUsers: { type: 'number', example: 63 },
                                    },
                                  },
                                },
                              },
                            },
                          },
                          reportingPeriod: {
                            type: 'object',
                            properties: {
                              startDate: { type: 'string', example: '30daysAgo' },
                              endDate: { type: 'string', example: 'today' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/analytics/social/youtube': {
        get: {
          summary: 'Live YouTube Channel & Video Analytics',
          description: 'Fetches live YouTube channel telemetry (subscribers, views, video count), calculates engagement rate, and retrieves recent uploads from the official YouTube Data API v3.',
          tags: ['Analytics & Performance'],
          parameters: [
            {
              name: 'refresh',
              in: 'query',
              required: false,
              schema: { type: 'boolean', default: false },
              description: 'Force cache bypass and fetch fresh data from YouTube Data API v3',
            },
          ],
          responses: {
            200: {
              description: 'Live YouTube channel statistics and recent video uploads',
            },
          },
        },
      },

      '/clarity/analytics': {
        get: {
          summary: 'Microsoft Clarity Live & Cached UX Analytics',
          description: 'Retrieves UX telemetry for an authorized website (`leaders_performance` or `lionel_eersteling`), including executive dwell times, rage-click ratios, dead clicks, and full breakdown by countries and cities.',
          tags: ['Microsoft Clarity UX & Telemetry'],
          parameters: [
            {
              name: 'website',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['leaders_performance', 'lionel_eersteling'], default: 'leaders_performance' },
              description: 'Target website key to query',
            },
            {
              name: 'days',
              in: 'query',
              required: false,
              schema: { type: 'integer', enum: [1, 2, 3], default: 1 },
              description: 'Number of days of insights (1, 2, or 3)',
            },
            {
              name: 'refresh',
              in: 'query',
              required: false,
              schema: { type: 'boolean', default: false },
              description: 'Bypass cache and force an immediate upstream pull from Clarity API',
            },
          ],
          responses: {
            200: {
              description: 'Normalized Clarity metrics with country and city distributions',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          websiteKey: { type: 'string', example: 'leaders_performance' },
                          websiteName: { type: 'string', example: 'Leaders Performance' },
                          websiteUrl: { type: 'string', example: 'https://leadersperformance.ae' },
                          projectId: { type: 'string', example: 'wu4o652peo' },
                          totalSessions: { type: 'number', example: 148 },
                          distinctUsers: { type: 'number', example: 112 },
                          pagesPerSession: { type: 'number', example: 2.4 },
                          executiveDwellSeconds: { type: 'number', example: 245 },
                          executiveDwellFormatted: { type: 'string', example: '4m 05s' },
                          dwellBenchmarkMet: { type: 'boolean', example: true },
                          rageClickRatio: { type: 'number', example: 0.008 },
                          rageClickRatioFormatted: { type: 'string', example: '0.80%' },
                          rageClickCount: { type: 'number', example: 1 },
                          deadClickRatio: { type: 'number', example: 0.02 },
                          deadClickCount: { type: 'number', example: 3 },
                          quickBackRatio: { type: 'number', example: 0.015 },
                          excessiveScrollRatio: { type: 'number', example: 0.04 },
                          averageScrollDepth: { type: 'number', example: 84.5 },
                          scriptErrorCount: { type: 'number', example: 0 },
                          popularPages: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                url: { type: 'string', example: 'https://leadersperformance.ae/turn-pressure-into-performance' },
                                visits: { type: 'number', example: 68 },
                              },
                            },
                          },
                          countries: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: 'United Arab Emirates' },
                                sessions: { type: 'number', example: 88 },
                              },
                            },
                          },
                          cities: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: 'Dubai' },
                                sessions: { type: 'number', example: 65 },
                              },
                            },
                          },
                          browsers: { type: 'array', items: { type: 'object' } },
                          devices: { type: 'array', items: { type: 'object' } },
                          operatingSystems: { type: 'array', items: { type: 'object' } },
                          anomalyDetected: { type: 'boolean', example: false },
                          ingestionLatencyMs: { type: 'number', example: 12 },
                          cachedAt: { type: 'string', example: '2026-10-29T12:00:00.000Z' },
                          isStale: { type: 'boolean', example: false },
                          quotaStatus: {
                            type: 'object',
                            properties: {
                              limitPerDay: { type: 'number', example: 25 },
                              remaining: { type: 'number', example: 24 },
                              status: { type: 'string', example: 'OK' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/clarity/refresh': {
        post: {
          summary: 'Trigger Controlled Refresh for Clarity Analytics',
          description: 'Triggers a controlled upstream fetch from the Clarity Data Export API, invalidating cached telemetry for the specified website within the 25 req/day quota.',
          tags: ['Microsoft Clarity UX & Telemetry'],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    website: {
                      type: 'string',
                      enum: ['leaders_performance', 'lionel_eersteling'],
                      default: 'leaders_performance',
                      description: 'Website key to refresh',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Fresh Clarity telemetry snapshot',
            },
          },
        },
      },

      '/clarity/recordings': {
        get: {
          summary: 'Clarity Session Recordings with Playback URLs',
          description: 'Returns available session recordings with direct verified playback links (`https://clarity.microsoft.com/projects/view/{projectId}/sessions/{sessionId}`) for embedding in Social CRM, complete with geographic country and city geolocation.',
          tags: ['Microsoft Clarity UX & Telemetry'],
          parameters: [
            {
              name: 'website',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['leaders_performance', 'lionel_eersteling'], default: 'leaders_performance' },
              description: 'Target website key',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 20 },
              description: 'Maximum number of recording sessions to return',
            },
          ],
          responses: {
            200: {
              description: 'Array of session playback records with lead attribution and geographic locations',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            sessionId: { type: 'string', example: '4a9b2c1e-88f1' },
                            playbackUrl: { type: 'string', example: 'https://clarity.microsoft.com/projects/view/wu4o652peo/sessions/4a9b2c1e-88f1' },
                            dwellSeconds: { type: 'number', example: 285 },
                            dwellTimeFormatted: { type: 'string', example: '4m 45s' },
                            rageClicks: { type: 'number', example: 0 },
                            rageClickRate: { type: 'number', example: 0.0 },
                            deadClicks: { type: 'number', example: 0 },
                            quickBack: { type: 'boolean', example: false },
                            device: { type: 'string', example: 'Desktop (macOS / Chrome)' },
                            country: { type: 'string', example: 'United Arab Emirates' },
                            city: { type: 'string', example: 'Dubai' },
                            landingPage: { type: 'string', example: 'https://leadersperformance.ae/strategic-briefings' },
                            lead: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: 'Dr. Tariq Al-Husseini' },
                                email: { type: 'string', example: 'tariq@alhusseini-holdings.ae' },
                                form: { type: 'string', example: 'Founder Pressure Scan' },
                              },
                            },
                            timestamp: { type: 'string', example: '2026-10-29T11:35:00.000Z' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/clarity/sessions': {
        get: {
          summary: 'Clarity Lead-Attributed Sessions (Social CRM Stream)',
          description: 'Alias for `/clarity/recordings` specifically configured for Social CRM embed and playback player integration.',
          tags: ['Microsoft Clarity UX & Telemetry'],
          parameters: [
            {
              name: 'website',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['leaders_performance', 'lionel_eersteling'], default: 'leaders_performance' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 20 },
            },
          ],
          responses: {
            200: {
              description: 'Array of session playback records with lead attribution and geographic locations',
            },
          },
        },
      },

      '/clarity/status': {
        get: {
          summary: 'Clarity Website Connection & Quota Status',
          description: 'Returns connection health, round-trip ping latency, last sync timestamp, and quota status for one or all Clarity websites.',
          tags: ['Microsoft Clarity UX & Telemetry'],
          parameters: [
            {
              name: 'website',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['leaders_performance', 'lionel_eersteling'] },
              description: 'Optional website key. If omitted, returns statuses for all registered websites.',
            },
          ],
          responses: {
            200: {
              description: 'Status object or array of status objects',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            websiteKey: { type: 'string', example: 'leaders_performance' },
                            websiteName: { type: 'string', example: 'Leaders Performance' },
                            websiteUrl: { type: 'string', example: 'https://leadersperformance.ae' },
                            projectId: { type: 'string', example: 'wu4o652peo' },
                            hasToken: { type: 'boolean', example: true },
                            status: { type: 'string', example: 'HEALTHY' },
                            latencyMs: { type: 'number', example: 120 },
                            lastSync: { type: 'string', example: '2026-10-29T11:45:00.000Z' },
                            quotaStatus: { type: 'string', example: 'Within standard daily quota (25 requests/day)' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/clarity/webhook': {
        post: {
          summary: 'Ingest Clarity Session & Telemetry Events',
          description: 'Ingests external Clarity session payloads or telemetry events, calculates rage clicks and UX friction, associates anonymous session IDs with attribution visits, and triggers WARNING alerts if rage-click ratio exceeds 1.5%.',
          tags: ['Microsoft Clarity UX & Telemetry'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessionId: { type: 'string', example: 'cls_session_94819' },
                    website: { type: 'string', enum: ['leaders_performance', 'lionel_eersteling'], default: 'leaders_performance' },
                    dwellSeconds: { type: 'number', example: 240 },
                    totalClicks: { type: 'number', example: 50 },
                    rageClicks: { type: 'number', example: 3 },
                    deadClicks: { type: 'number', example: 1 },
                    quickBack: { type: 'boolean', example: false },
                    landingPage: { type: 'string', example: 'https://leadersperformance.ae/turn-pressure-into-performance' },
                    email: { type: 'string', example: 'executive@enterprise.com' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Telemetry ingested successfully with anomaly status and playback URL',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          ingested: { type: 'boolean', example: true },
                          anomalyDetected: { type: 'boolean', example: false },
                          snapshotId: { type: 'string', example: 'cly1234567890' },
                          sessionId: { type: 'string', example: 'cls_session_94819' },
                          playbackUrl: { type: 'string', example: 'https://clarity.microsoft.com/projects/view/wu4o652peo/sessions/cls_session_94819' },
                        },
                      },
                    },
                  },
                },
              },
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
      ? ['./dist/api/routes/*.js', './dist/modules/**/*.js']
      : ['./src/api/routes/*.ts', './src/modules/**/*.ts'], // Scan src in dev, dist only in production
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
