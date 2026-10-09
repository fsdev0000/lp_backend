async function verifyAll() {
  const base = 'http://localhost:4000/api/v1/masterclass';
  const testEmail = 'verify_' + Date.now() + '@example.com';
  const results: any[] = [];

  async function check(name: string, fn: () => Promise<string>) {
    try {
      const res = await fn();
      results.push({ name, status: 'PASS', detail: res });
    } catch (e: any) {
      results.push({ name, status: 'FAIL', detail: e.message });
    }
  }

  // 1. GET /config
  await check('GET /config', async () => {
    const r = await fetch(base + '/config');
    const j: any = await r.json();
    if (!j.success || !j.stages || !j.videos) throw new Error('Invalid config response');
    return `200 OK (${j.stages.length} stages, ${j.videos.length} videos)`;
  });

  // 2. POST /config
  await check('POST /config', async () => {
    const r = await fetch(base + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail })
    });
    const j: any = await r.json();
    if (!j.success) throw new Error('Invalid POST config');
    return `200 OK (userExists=${j.userExists}, videos=${j.videos.length})`;
  });

  // 3. GET /videos
  await check('GET /videos', async () => {
    const r = await fetch(base + '/videos');
    const j: any = await r.json();
    if (!j.success || !Array.isArray(j.videos)) throw new Error('Invalid videos');
    const available = j.videos.filter((v: any) => v.isAvailable).length;
    return `200 OK (${j.videos.length} videos catalog, ${available} currently uploaded with signed URLs)`;
  });

  // 4. PUT /config/questions
  await check('PUT /config/questions', async () => {
    const r = await fetch(base + '/config/questions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reflectionPauseDurationSeconds: 45 })
    });
    const j: any = await r.json();
    if (!j.success) throw new Error('Update questions failed');
    return `200 OK (pause=${j.config.reflectionPauseDurationSeconds}s)`;
  });

  // 5. POST /auth/identify
  await check('POST /auth/identify', async () => {
    const r = await fetch(base + '/auth/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail })
    });
    const j: any = await r.json();
    if (!j.success) throw new Error('Identify failed');
    return `200 OK (recognized=${j.recognized})`;
  });

  // 6. POST /create-session
  let sessionId = '';
  await check('POST /create-session', async () => {
    const r = await fetch(base + '/create-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Audit Lead',
        email: testEmail,
        company: 'Audit Inc',
        role: 'Founder',
        marketingConsent: true,
        privacyConsent: true
      })
    });
    const j: any = await r.json();
    if (!j.success || !j.checkoutUrl) throw new Error('Create session failed');
    sessionId = j.sessionId;
    return `200 OK (Stripe checkout session: ${j.sessionId.substring(0, 18)}...)`;
  });

  // 7. GET /auth/me
  await check('GET /auth/me', async () => {
    const r = await fetch(base + '/auth/me?email=' + encodeURIComponent(testEmail));
    const j: any = await r.json();
    if (!j.success || !j.user) throw new Error('Auth me failed');
    return `200 OK (email=${j.user.email}, stage=${j.user.currentStage})`;
  });

  // 8. GET /modules
  await check('GET /modules', async () => {
    const r = await fetch(base + '/modules');
    const j: any = await r.json();
    if (!j.success || j.totalModules !== 4) throw new Error('Modules fetch failed');
    return `200 OK (totalModules=4)`;
  });

  // 9. POST /save-draft
  await check('POST /save-draft', async () => {
    const r = await fetch(base + '/save-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        currentStage: 2,
        formData: { stage1_nextStage: 'Scaling to 10M' },
        personalNotes: { stage1_notes: 'Autonomy' }
      })
    });
    const j: any = await r.json();
    if (!j.success) throw new Error('Draft save failed');
    return `200 OK (savedRef=${j.submissionRef})`;
  });

  // 10. GET /draft
  await check('GET /draft', async () => {
    const r = await fetch(base + '/draft?email=' + encodeURIComponent(testEmail));
    const j: any = await r.json();
    if (!j.hasDraft) throw new Error('Draft get failed');
    return `200 OK (hasDraft=true, currentStage=${j.draft.currentStage})`;
  });

  // 11. POST /submit-workbook
  let submissionRef = '';
  await check('POST /submit-workbook', async () => {
    const r = await fetch(base + '/submit-workbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantDetails: {
          fullName: 'Audit Lead',
          email: testEmail,
          company: 'Audit Inc',
          role: 'Founder'
        },
        formData: {
          stage1_nextStage: 'Scaling to 10M ARR',
          stage1_possibility: 'Strategic expansion',
          stage1_strength: 'Product rigor',
          stage2_changes: 'Executive delegation',
          stage2_demand1: 'Management bandwidth',
          stage2_investment: 'Hire COO',
          stage3_founderStrength: 'Calendar discipline',
          stage3_teamStrength: 'KPI ownership',
          stage3_orgStrength: 'Governance',
          stage4_priority90Days: 'Structure executive alignment',
          stage4_action7Days: 'Audit meeting load',
          stage4_evidence: '5 hours saved weekly'
        },
        personalNotes: { stage1_notes: 'Notes saved' }
      })
    });
    const j: any = await r.json();
    if (!j.success || !j.submissionRef) throw new Error('Workbook submission failed');
    submissionRef = j.submissionRef;
    return `200 OK (Ref=${j.submissionRef})`;
  });

  // 12. GET /submission/:id
  await check('GET /submission/:submissionId', async () => {
    const r = await fetch(base + '/submission/' + submissionRef);
    const j: any = await r.json();
    if (!j.success || !j.submission) throw new Error('Fetch submission failed');
    return `200 OK (submissionRef=${j.submission.submissionRef})`;
  });

  // 13. GET /available-slots
  await check('GET /available-slots', async () => {
    const r = await fetch(base + '/available-slots?timezone=GST%20(UTC%2B4)');
    const j: any = await r.json();
    if (!j.success || !Array.isArray(j.availableSlots)) throw new Error('Available slots failed');
    return `200 OK (${j.availableSlots.length} slots in ${j.timezone})`;
  });

  // 14. POST /book-slot
  await check('POST /book-slot', async () => {
    const r = await fetch(base + '/book-slot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        fullName: 'Audit Lead',
        company: 'Audit Inc',
        selectedSlot: 'Thursday, Oct 24 • 4:00 PM GST',
        timezone: 'GST (UTC+4)',
        submissionRef: submissionRef
      })
    });
    const j: any = await r.json();
    if (!j.success || !j.bookingRef) throw new Error('Book slot failed');
    return `200 OK (BookingRef=${j.bookingRef}, status=${j.status})`;
  });

  console.log('\n========================================');
  console.log('       ALL MASTERCLASS APIS STATUS       ');
  console.log('========================================');
  results.forEach(r => console.log(r.status === 'PASS' ? '✅' : '❌', r.name.padEnd(28), '=>', r.detail));
  console.log('========================================');
  console.log('Total verified:', results.length, '| Passed:', results.filter(r => r.status === 'PASS').length);
}
verifyAll();
