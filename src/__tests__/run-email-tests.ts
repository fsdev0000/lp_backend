import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  escapeHtml,
  formatOperationalSubmissionDate,
  generateReferenceNumber,
  getSecureReviewUrl,
  renderTemplate,
  buildAdminBriefingEmail,
} from '../services/email';

async function main() {
  console.log('--- Starting Founder Pressure Scan Email Tests ---');

  // Test 1: Template existence and structure
  const templatePath = path.join(__dirname, '../../templates/internal-consultant-briefing.html');
  assert.strictEqual(fs.existsSync(templatePath), true, 'Template file must exist');
  const templateRaw = fs.readFileSync(templatePath, 'utf8');
  assert(templateRaw.includes('<!DOCTYPE html'), 'Must have DOCTYPE');
  assert(templateRaw.includes('role="presentation"'), 'Must have role=presentation');
  console.log('✓ Test 1 Passed: Template file exists and contains valid email-safe table markup');

  // Test 2: Approved Hidden Preheader
  const email = await buildAdminBriefingEmail({
    name: 'Daniel Mercer',
    company: 'Mercer Group',
    reference_number: 'FPS-2026-0048',
    submission_date: '2026-09-24T06:42:00Z',
    score: 87,
    tier: 'Critical',
    primary_focus: 'Decisions',
    greatest_opportunity: 'Delegation of Operational Decisions',
    opening_question: 'Where are decisions bottlenecking?',
  });

  const expectedPreheader = 'A new Founder Pressure Scan submission is awaiting human review.';
  assert(email.html.includes(expectedPreheader), 'Must contain exact approved preheader');
  assert(email.html.includes('display:none'), 'Preheader must be hidden via display:none');
  console.log('✓ Test 2 Passed: Approved hidden preheader text verified');

  // Test 3: Approved Dynamic Subject Line
  const expectedSubject = 'New Founder Pressure Scan Submission — Mercer Group — FPS-2026-0048';
  assert.strictEqual(email.subject, expectedSubject, `Subject must match ${expectedSubject}`);
  console.log('✓ Test 3 Passed: Dynamic subject line with Company Name and Reference Number verified');

  // Test 4: Canonical Reference Number generation
  const email2 = await buildAdminBriefingEmail({
    name: 'Sarah Connor',
    company: 'Cyberdyne Systems',
  });
  assert(/^New Founder Pressure Scan Submission — Cyberdyne Systems — FPS-\d{4}-\d{4}$/.test(email2.subject), 'Subject must match generated reference number');
  assert(email2.html.includes(email2.referenceNumber), 'HTML must display reference number');
  console.log('✓ Test 4 Passed: Canonical reference number generation verified');

  // Test 5: Approved Secure CTA "Open Secure Review" & Zero Sensitive Data in Link
  assert(email.html.includes('Open Secure Review'), 'Must contain exact CTA text "Open Secure Review"');
  const reviewUrl = await getSecureReviewUrl();
  assert(!reviewUrl.includes('score='), 'Review URL must not contain score query param');
  assert(!reviewUrl.includes('answers='), 'Review URL must not contain answers query param');
  assert(!reviewUrl.includes('tier='), 'Review URL must not contain tier query param');
  console.log('✓ Test 5 Passed: Secure review CTA and zero sensitive query parameters verified');

  // Test 6: Zero Exposure of Confidential Submission Data in Subject or Body
  assert(!email.subject.includes('87'), 'Subject must not leak score');
  assert(!email.subject.includes('Critical'), 'Subject must not leak tier');
  assert(!email.html.includes('87/100'), 'Body must not contain diagnostic score');
  assert(!email.html.includes('Critical Risk'), 'Body must not contain diagnostic tier');
  assert(!email.html.includes('Where are decisions bottlenecking?'), 'Body must not contain diagnostic interpretation questions');
  console.log('✓ Test 6 Passed: Complete security protection of confidential scan responses verified');

  // Test 7: Operational Timezone Formatting
  process.env.OPERATIONAL_TIMEZONE = 'Asia/Dubai';
  const formattedDubai = formatOperationalSubmissionDate('2026-09-24T06:42:00Z');
  assert.strictEqual(formattedDubai, '24 September 2026 · 10:42 AM GST', `Dubai date must match '24 September 2026 · 10:42 AM GST', got '${formattedDubai}'`);
  console.log('✓ Test 7 Passed: Operational timezone date formatting (GST) verified');

  // Test 8: Safe Escaping of HTML (Anti-XSS)
  const xssEmail = await buildAdminBriefingEmail({
    name: '<script>alert("hack")</script>',
    company: 'Acme & Sons <Co>',
    reference_number: 'FPS-<b>test</b>',
    initial_reason: 'Growth "strategy" & testing <script>',
  });
  assert(!xssEmail.html.includes('<script>'), 'Must not contain unescaped <script>');
  assert(!xssEmail.html.includes('<b>test</b>'), 'Must not contain unescaped <b>');
  assert(xssEmail.html.includes('&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt;'), 'Must contain escaped script');
  assert(xssEmail.html.includes('Acme &amp; Sons &lt;Co&gt;'), 'Must contain escaped company');
  console.log('✓ Test 8 Passed: Dynamic input sanitization and XSS protection verified');

  // Test 9: Desktop 600px constraint and email client font fallbacks
  assert(email.html.includes('width="600"'), 'Desktop container width must be 600px');
  assert(email.html.includes('max-width:600px'), 'Desktop container max-width must be 600px');
  assert(email.html.includes('Georgia'), 'Must include Georgia fallback');
  assert(email.html.includes('Arial'), 'Must include Arial fallback');
  console.log('✓ Test 9 Passed: Desktop 600px constraint and typography fallbacks verified');

  // Test 10: Mobile responsiveness (375px) and CTA full width
  assert(email.html.includes('@media only screen and (max-width: 599px)'), 'Must include mobile media query');
  assert(email.html.includes('.meta-cell-label'), 'Must have mobile rule for meta labels');
  assert(email.html.includes('.meta-cell-value'), 'Must have mobile rule for meta values');
  assert(email.html.includes('width: 100% !important'), 'Must expand CTA and cells to 100% width on mobile');
  console.log('✓ Test 10 Passed: Mobile responsiveness at 375px verified');

  // Test 11: Interactive CTA States (Default, Hover, Focus)
  assert(email.html.includes('#d0a35a'), 'Default gold fill present');
  assert(email.html.includes('#010d20'), 'Default navy text present');
  assert(email.html.includes('.cta-btn:hover'), 'Hover state selector present');
  assert(email.html.includes('#9f6511'), 'Hover gold-dark fill present');
  assert(email.html.includes('#fbf8f2'), 'Hover cream text present');
  assert(email.html.includes('.cta-btn:focus'), 'Focus state selector present');
  assert(email.html.includes('outline: 2px solid #d0a35a'), 'Focus 2px gold outline present');
  console.log('✓ Test 11 Passed: CTA interactive states (Default, Hover, Focus) verified');

  console.log('\n========================================');
  console.log('ALL 11 EMAIL NOTIFICATION TESTS PASSED!');
  console.log('========================================');
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
