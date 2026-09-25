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

describe('Founder Pressure Scan Internal Notification Email Template', () => {
  const templatePath = path.join(__dirname, '../../templates/internal-consultant-briefing.html');

  test('template file exists and has valid HTML structure', () => {
    expect(fs.existsSync(templatePath)).toBe(true);
    const html = fs.readFileSync(templatePath, 'utf8');
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('<table');
  });

  test('renders approved hidden preheader text', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
    });

    const expectedPreheader = 'A new Founder Pressure Scan submission is awaiting human review.';
    expect(email.html).toContain(expectedPreheader);

    // Verify it is hidden via CSS
    expect(email.html).toMatch(/display:\s*none/i);
    expect(email.html).toMatch(/max-height:\s*0px/i);
  });

  test('generates dynamic subject with Company Name and Reference Number', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
      reference_number: 'FPS-2026-0048',
    });

    expect(email.subject).toBe('New Founder Pressure Scan Submission — Mercer Group — FPS-2026-0048');
  });

  test('generates canonical reference number if omitted', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Sarah Connor',
      company: 'Cyberdyne Systems',
    });

    expect(email.subject).toMatch(/^New Founder Pressure Scan Submission — Cyberdyne Systems — FPS-\d{4}-\d{4}$/);
    expect(email.html).toContain(email.referenceNumber);
  });

  test('contains approved Secure CTA text "Open Secure Review" with no sensitive query parameters', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
      reference_number: 'FPS-2026-0048',
    });

    expect(email.html).toContain('Open Secure Review');
    
    // Ensure the review URL does not leak confidential data
    const urlMatch = email.html.match(/href="([^"]+)"/);
    expect(urlMatch).toBeTruthy();
    const href = urlMatch![1];
    
    expect(href).not.toContain('score=');
    expect(href).not.toContain('tier=');
    expect(href).not.toContain('answers=');
    expect(href).not.toContain('question=');
    expect(href).not.toContain('diagnostic=');
  });

  test('strictly protects confidential information: no scores, tiers, or raw answers exposed', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
      reference_number: 'FPS-2026-0048',
      score: 87,
      tier: 'Critical',
      primary_focus: 'Decisions',
      greatest_opportunity: 'Delegation of Operational Decisions',
      opening_question: 'Where are decisions bottlenecking?',
    });

    // Score and tier must NOT appear anywhere in subject or body
    expect(email.subject).not.toContain('87');
    expect(email.subject).not.toContain('Critical');
    expect(email.html).not.toContain('87/100');
    expect(email.html).not.toContain('Critical Risk');
    expect(email.html).not.toContain('Where are decisions bottlenecking?');
  });

  test('formats submission date/time with operational timezone', () => {
    const testDate = new Date('2026-09-24T06:42:00Z');
    process.env.OPERATIONAL_TIMEZONE = 'Asia/Dubai';

    const formatted = formatOperationalSubmissionDate(testDate);
    expect(formatted).toBe('24 September 2026 · 10:42 AM GST');
  });

  test('safely escapes HTML in all dynamic user inputs (anti-XSS)', async () => {
    const email = await buildAdminBriefingEmail({
      name: '<script>alert("hack")</script>',
      company: 'Acme & Sons <Co>',
      reference_number: 'FPS-<b>test</b>',
      initial_reason: 'Growth "strategy" & testing <script>',
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<b>test</b>');
    expect(email.html).toContain('&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt;');
    expect(email.html).toContain('Acme &amp; Sons &lt;Co&gt;');
    expect(email.html).toContain('Growth &quot;strategy&quot; &amp; testing &lt;script&gt;');
  });

  test('enforces desktop 600px constraint and email-safe presentation tables', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
    });

    expect(email.html).toContain('width="600"');
    expect(email.html).toContain('max-width:600px');
    expect(email.html).toContain('role="presentation"');
    // Ensure email-safe fallbacks are included
    expect(email.html).toContain('Playfair Display');
    expect(email.html).toContain('Georgia');
    expect(email.html).toContain('Inter');
    expect(email.html).toContain('Arial');
  });

  test('implements mobile responsive styles for 375px viewport', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
    });

    // Mobile media query for vertical stacking of metadata and full-width CTA
    expect(email.html).toContain('@media only screen and (max-width: 599px)');
    expect(email.html).toContain('.meta-cell-label');
    expect(email.html).toContain('.meta-cell-value');
    expect(email.html).toContain('.cta-btn');
    expect(email.html).toContain('width: 100% !important');
  });

  test('includes required CTA interactive states (Default, Hover, Focus)', async () => {
    const email = await buildAdminBriefingEmail({
      name: 'Daniel Mercer',
      company: 'Mercer Group',
    });

    // Default state: Gold fill (#d0a35a), Navy text (#010d20)
    expect(email.html).toContain('#d0a35a');
    expect(email.html).toContain('#010d20');

    // Hover state: Gold-dark fill (#9f6511), Cream text (#fbf8f2)
    expect(email.html).toContain('.cta-btn:hover');
    expect(email.html).toContain('#9f6511');
    expect(email.html).toContain('#fbf8f2');

    // Focus state: 2px gold focus ring with offset
    expect(email.html).toContain('.cta-btn:focus');
    expect(email.html).toContain('outline: 2px solid #d0a35a');
    expect(email.html).toContain('outline-offset: 2px');
  });
});
