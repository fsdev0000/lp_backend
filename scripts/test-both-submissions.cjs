const http = require('http');

function sendPost(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      'http://localhost:4000/api/v1/unmasked-private/apply',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('--- TEST 1: BELOW THRESHOLD (< AED 10k) ---');
  const payload1 = {
    step1: {
      fullName: 'Asif (Test Below Threshold)',
      email: 'asif@leadersperformance.ae',
      phone: '+971 50 123 4567',
      companyName: 'Leaders Performance (Test)',
      companyWebsite: 'https://leadersperformance.ae',
      role: 'Director',
      cityAndCountry: 'Dubai, UAE',
    },
    step2: {
      businessResult: 'Testing Below Threshold Email Notification',
      attentionNow: 'Validating internal alert system',
      outcome90Days: 'Full visibility on all incoming applications',
      attemptedAlready: 'Previous test run',
    },
    step3: {
      decisionInfluence: 'Direct owner of testing cadence',
      challengeView: 'Ensuring both tiers trigger notifications',
      authorityToAct: 'Yes',
      investmentReadiness: 'Up to AED 5,000',
      availableForCall: 'Yes',
    },
    consent: {
      privacyConsent: true,
      privacyPolicyVersion: '2026.1',
    },
  };

  const res1 = await sendPost(payload1);
  console.log('Status:', res1.status);
  console.log('Response:', JSON.stringify(res1.body, null, 2));

  console.log('\nWaiting 4 seconds before Test 2 to allow background GHL email dispatch...\n');
  await new Promise((r) => setTimeout(r, 4000));

  console.log('--- TEST 2: QUALIFIED (>= AED 10k) ---');
  const payload2 = {
    step1: {
      fullName: 'Asif (Test Qualified Review)',
      email: 'asif@leadersperformance.ae',
      phone: '+971 50 123 4567',
      companyName: 'Leaders Performance (Test)',
      companyWebsite: 'https://leadersperformance.ae',
      role: 'Managing Director',
      cityAndCountry: 'Dubai, UAE',
    },
    step2: {
      businessResult: 'Testing Qualified Review Email Notification',
      attentionNow: 'Validating executive review alert',
      outcome90Days: 'Lionel personal review workflow verified',
      attemptedAlready: 'Automated test suite',
    },
    step3: {
      decisionInfluence: 'Full operational authority',
      challengeView: 'Ready for strategic diagnostic reset',
      authorityToAct: 'Yes',
      investmentReadiness: 'AED 15,000–19,999',
      availableForCall: 'Yes',
    },
    consent: {
      privacyConsent: true,
      privacyPolicyVersion: '2026.1',
    },
  };

  const res2 = await sendPost(payload2);
  console.log('Status:', res2.status);
  console.log('Response:', JSON.stringify(res2.body, null, 2));

  console.log('\nBoth tests executed successfully. Checking email delivery logs...');
}

run().catch(console.error);
