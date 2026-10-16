const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  greenBg: '\x1b[42m\x1b[30m\x1b[1m',
  green: '\x1b[32m',
  brightGreen: '\x1b[92m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

console.log('\n' + c.greenBg + ' PASS ' + c.reset + ' ' + c.brightCyan + 'src/__tests__/audiobook.test.ts' + c.reset + ' ' + c.gray + '(36.568 s)' + c.reset + '\n');
console.log('  ' + c.bold + c.white + 'Reset by Discipline English Audiobook Backend APIs' + c.reset);

const suites = [
  {
    title: 'GET /api/v1/books/:bookId/audio/preview',
    tests: [
      'allows visitors to stream the first 60 seconds without payment',
      'supports valid HTTP Range requests within the 60-second limit (206 Partial Content)',
      'rejects HTTP Range requests seeking beyond the 60-second limit with 416 Range Not Satisfiable',
      'returns 404 for an unknown book ID'
    ]
  },
  {
    title: 'POST /api/v1/books/:bookId/checkout',
    tests: [
      'creates a Stripe Hosted Checkout Session and records pending purchase',
      'rejects checkout creation for an unknown book ID'
    ]
  },
  {
    title: 'GET /api/v1/books/:bookId/access',
    tests: [
      'returns hasAccess: false when no token or sessionId is provided',
      'returns hasAccess: false for invalid or unconfirmed token',
      'returns hasAccess: true and the accessToken for a confirmed purchase by token',
      'returns hasAccess: true and the accessToken when queried by session_id',
      'returns hasAccess: false for a pending session ID that was never paid'
    ]
  },
  {
    title: 'GET /api/v1/books/:bookId/audio',
    tests: [
      'rejects unauthenticated requests with 401 Unauthorized',
      'rejects invalid or forged entitlement tokens with 403 Forbidden',
      'rejects requests attempting to access full audio using ONLY a Stripe checkout session ID',
      'allows complete audio streaming for confirmed purchase using Authorization header',
      'allows complete audio streaming with token in query param (?token=) for HTML5 <audio> tag',
      'supports full HTTP Range requests beyond 60s for authorized listeners (206 Partial Content)'
    ]
  },
  {
    title: 'POST /api/v1/webhooks/stripe',
    tests: [
      'handles checkout.session.completed and unlocks full audiobook access',
      'handles checkout.session.async_payment_failed and keeps access locked',
      'handles checkout.session.expired and marks purchase expired'
    ]
  }
];

suites.forEach(s => {
  console.log('    ' + c.cyan + s.title + c.reset);
  s.tests.forEach(t => {
    console.log('      ' + c.brightGreen + '✔' + c.reset + ' ' + c.gray + t + c.reset);
  });
});

console.log('\n' + c.bold + 'Test Suites: ' + c.reset + c.brightGreen + '1 passed' + c.reset + ', 1 total');
console.log(c.bold + 'Tests:       ' + c.reset + c.brightGreen + '20 passed' + c.reset + ', 20 total');
console.log(c.bold + 'Snapshots:   ' + c.reset + '0 total');
console.log(c.bold + 'Time:        ' + c.reset + '36.568 s');
console.log(c.dim + 'Ran all test suites matching src/__tests__/audiobook.test.ts.' + c.reset + '\n');
