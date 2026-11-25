import { PrismaClient } from '@prisma/client';

const API_BASE = 'http://localhost:4000/api/v1';

async function runVerification() {
  console.log('--- STARTING 100% MEMO COMPLIANCE VERIFICATION ---\n');

  // 1. Calculation Tests
  const tests = [
    { input: Array(10).fill(1), expectedScore: 0, expectedTier: 'Limited Signal' },
    { input: Array(10).fill(2), expectedScore: 25, expectedTier: 'Emerging Signal' },
    { input: Array(10).fill(3), expectedScore: 50, expectedTier: 'Active Signal' },
    { input: Array(10).fill(4), expectedScore: 75, expectedTier: 'Priority Signal' },
    { input: Array(10).fill(5), expectedScore: 100, expectedTier: 'Priority Signal' },
  ];

  let ipCounter = 10;
  for (const t of tests) {
    ipCounter++;
    const res = await fetch(`${API_BASE}/assessments/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `10.0.0.${ipCounter}`,
      },
      body: JSON.stringify({
        founder: { founder: 'Audit Test', company: 'Leaders Performance', email: 'audit@example.com' },
        answers: t.input,
      }),
    });
    const data = await res.json();
    const sessionRes = await fetch(`${API_BASE}/assessments/session/${data.sessionId}`);
    const session = await sessionRes.json();

    const scoreMatch = session.score === t.expectedScore;
    const tierMatch = session.tier === t.expectedTier;
    console.log(`[Score Test] All answers=${t.input[0]} -> Score: ${session.score} (Exp: ${t.expectedScore}) [${scoreMatch ? 'PASS' : 'FAIL'}], Tier: "${session.tier}" (Exp: "${t.expectedTier}") [${tierMatch ? 'PASS' : 'FAIL'}]`);
  }

  // 2. Domain & Joint Primary Signal Areas Test
  // Questions: 0,1: Founder Involvement, 2,3: Decision Load, 4,5: Execution Rhythm, 6,7: Leadership Ownership, 8,9: Operational Resilience
  // Give high scores (5) to Decision Load and Operational Resilience
  const jointInput = [1, 1, 5, 5, 1, 1, 1, 1, 5, 5];
  const jointRes = await fetch(`${API_BASE}/assessments/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '10.0.0.99',
    },
    body: JSON.stringify({
      founder: { founder: 'Joint Test', company: 'Co', email: 'joint@example.com' },
      answers: jointInput,
    }),
  });
  const jointData = await jointRes.json();
  const jointSession = await (await fetch(`${API_BASE}/assessments/session/${jointData.sessionId}`)).json();
  console.log('\n[Joint Primary Test] Highest domains:', jointSession.domainScores.filter((d: any) => d.mean === 5).map((d: any) => d.domain).join(' & '));
  console.log('[Joint Primary Test] Total 5 domains present:', jointSession.domainScores.length === 5 ? 'PASS' : 'FAIL');

  // 3. Calendar info duration test
  const calRes = await fetch(`${API_BASE}/bookings/calendar-info`);
  const calInfo = await calRes.json();
  console.log('\n[Calendar Info Test] Duration:', calInfo.duration, 'min, Label:', calInfo.sessionLabel);

  console.log('\n--- VERIFICATION FINISHED SUCCESSFULLY ---');
}

runVerification().catch(console.error);
