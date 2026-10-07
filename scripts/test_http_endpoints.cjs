const express = require('express');
const { newsletterRouter } = require('../src/api/routes/newsletter.ts');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ override: true });

const prisma = new PrismaClient();

async function testHttpRoutes() {
  console.log('\n====================================================');
  console.log('HTTP ROUTE INTEGRATION TESTS');
  console.log('====================================================\n');

  const app = express();
  app.use(express.json());
  app.use('/api/newsletter', newsletterRouter);
  app.use('/api/v1/newsletter', newsletterRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`[PASS] ${msg}`);
      passed++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failed++;
    }
  }

  const testEmail = `http.sub.${Date.now()}@example.com`;

  try {
    // 1. Subscribe without consent -> 400
    const resNoConsent = await fetch(`${baseUrl}/api/newsletter/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail }),
    });
    assert(resNoConsent.status === 400, 'POST /subscribe without consent returns 400 Bad Request');
    const noConsentJson = await resNoConsent.json();
    assert(noConsentJson.error.includes('Explicit consent is required'), 'Error explicitly mentions consent requirement');

    // 2. Subscribe with consent -> 200
    const resSub = await fetch(`${baseUrl}/api/newsletter/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, firstName: 'Marcus', consent: true }),
    });
    assert(resSub.status === 200, 'POST /subscribe with consent returns 200 OK');
    const subJson = await resSub.json();
    assert(subJson.success === true && subJson.alreadySubscribed === false, 'Returns success response');

    // Fetch token from DB
    const subDb = await prisma.newsletterSubscriber.findUnique({
      where: { email: testEmail.toLowerCase() },
    });
    assert(subDb && subDb.unsubscribeToken, 'Subscriber created in Supabase with crypto token');

    // 3. Duplicate Subscribe -> 200 alreadySubscribed: true
    const resDup = await fetch(`${baseUrl}/api/newsletter/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, consent: true }),
    });
    const dupJson = await resDup.json();
    assert(dupJson.alreadySubscribed === true, 'Duplicate subscription returns alreadySubscribed: true');

    // 4. Unsubscribe with Invalid Token -> 400
    const resInvalidToken = await fetch(`${baseUrl}/api/newsletter/unsubscribe?token=invalid-token-123`, {
      headers: { Accept: 'application/json' },
    });
    assert(resInvalidToken.status === 400, 'GET /unsubscribe with invalid token returns 400');

    // 5. Unsubscribe with Valid Token -> 200
    const resUnsub = await fetch(`${baseUrl}/api/newsletter/unsubscribe?token=${subDb.unsubscribeToken}`, {
      headers: { Accept: 'application/json' },
    });
    assert(resUnsub.status === 200, 'GET /unsubscribe with valid token returns 200 OK');
    const unsubJson = await resUnsub.json();
    assert(unsubJson.success === true, 'Returns success confirmation');

    const updatedDb = await prisma.newsletterSubscriber.findUnique({
      where: { id: subDb.id },
    });
    assert(updatedDb.subscribed === false, 'Subscriber marked as subscribed = false in Supabase');

    // 6. Resubscribe -> 200 resubscribed: true
    const resResub = await fetch(`${baseUrl}/api/newsletter/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, consent: true }),
    });
    const resubJson = await resResub.json();
    assert(resubJson.resubscribed === true, 'Resubscription returns resubscribed: true');

    // Cleanup
    await prisma.newsletterSubscriber.delete({ where: { email: testEmail.toLowerCase() } });
    console.log('[Cleanup] Test email cleaned up from DB.');

  } catch (err) {
    console.error('Error during HTTP tests:', err);
    failed++;
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log('\n====================================================');
  console.log(`HTTP TESTS SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

testHttpRoutes();
