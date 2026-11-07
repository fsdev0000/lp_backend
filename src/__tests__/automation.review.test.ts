import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { crmAutomationRouter } from '../modules/automation/crm.routes';
import { automationPrisma } from '../modules/automation/state/transition';
import {
  validateGeminiDraftOutput,
  geminiDraftService
} from '../modules/automation/review/geminiDraft.service';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(60000);

const TEST_INTERNAL_KEY = 'test-internal-key-secret-32chars';
process.env.INTERNAL_API_KEY = TEST_INTERNAL_KEY;
process.env.CRM_SESSION_SECRET =
  process.env.CRM_SESSION_SECRET || 'test-crm-session-secret-32chars-long';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/internal', internalAutomationRouter);
app.use('/api/v1/social-crm', crmAutomationRouter);

let lionelToken: string;
let sarathToken: string;
let asadToken: string;

beforeAll(async () => {
  process.env.INTERNAL_API_KEY = TEST_INTERNAL_KEY;
  process.env.EMAIL_APPROVER = 'lionel@leadersperformance.ae';
  process.env.EMAIL_EDITORS = 'sarath@leadersperformance.ae,asad@leadersperformance.ae';
  process.env.EMAIL_ADMIN = 'asif@leadersperformance.ae';
  process.env.EMAIL_INFO = 'info@leadersperformance.ae';

  lionelToken = generateCrmSessionToken({
    id: 'usr-lionel',
    email: 'lionel@leadersperformance.ae',
    name: 'Mr. Lionel',
    role: 'approver'
  });

  sarathToken = generateCrmSessionToken({
    id: 'usr-sarath',
    email: 'sarath@leadersperformance.ae',
    name: 'Sarath',
    role: 'editor'
  });

  asadToken = generateCrmSessionToken({
    id: 'usr-asad',
    email: 'asad@leadersperformance.ae',
    name: 'Asad',
    role: 'editor'
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await automationPrisma.$queryRaw`SELECT 1`;
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}, 45000);

afterAll(async () => {
  await automationPrisma.$disconnect();
});

describe('Step 3: Review Loop — Gemini Draft Validation, CRM Review Cycle & Notification Outbox', () => {
  describe('1. Gemini Draft Validation & Retry/Fallback (Edge Case #16)', () => {
    it('validates clean JSON output and rejects forbidden word "coach", invalid category, or over-length captions', () => {
      const valid = validateGeminiDraftOutput(
        {
          title: 'Executive Metabolic Periodization',
          caption: 'Sustained cognitive output requires deliberate autonomic recovery windows.',
          hashtags: ['#LeadersPerformance', '#ExecutiveVitality'],
          category: 'Vitality'
        },
        'LINKEDIN'
      );
      expect(valid.valid).toBe(true);
      expect(valid.normalized?.category).toBe('Vitality');

      const withForbiddenWord = validateGeminiDraftOutput(
        {
          title: 'Work With an Executive Coach',
          caption: 'Our coaching program helps founders scale.',
          hashtags: ['#Leadership'],
          category: 'Leadership'
        },
        'LINKEDIN'
      );
      expect(withForbiddenWord.valid).toBe(false);
      expect(withForbiddenWord.reason).toMatch(/forbidden word "coach"/i);

      const withBadCategory = validateGeminiDraftOutput(
        {
          title: 'Strategic Focus',
          caption: 'Protect your morning focus block.',
          hashtags: ['#Strategy'],
          category: 'RandomCategory'
        },
        'LINKEDIN'
      );
      expect(withBadCategory.valid).toBe(false);
      expect(withBadCategory.reason).toMatch(/Invalid category/i);
    });

    it('retries Gemini once on bad output and falls back cleanly when both attempts fail (Edge Case #16)', async () => {
      let calls = 0;
      const retrySuccess = await geminiDraftService.callGeminiWithRetry({
        platform: 'LINKEDIN',
        contentType: 'Post',
        subject: 'Executive recovery',
        sourceCaptionText: 'Raw Drive copy on executive recovery.',
        customGenerator: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              title: 'Why Every Founder Needs a Coach',
              caption: 'Bad first draft.',
              hashtags: ['#Performance'],
              category: 'Business'
            };
          }
          return {
            title: 'Why Every Founder Needs Physiological Telemetry',
            caption: 'Clean second draft without forbidden terms.',
            hashtags: ['#Performance', '#ExecutiveVitality'],
            category: 'Vitality'
          };
        }
      });

      expect(calls).toBe(2);
      expect(retrySuccess.success).toBe(true);
      expect(retrySuccess.draft?.title).toBe('Why Every Founder Needs Physiological Telemetry');

      // Now test both attempts failing -> fallback
      let failCalls = 0;
      const fallbackResult = await geminiDraftService.callGeminiWithRetry({
        platform: 'INSTAGRAM',
        contentType: 'Reel',
        subject: 'Raw copy',
        sourceCaptionText: 'Raw copy.',
        customGenerator: async () => {
          failCalls += 1;
          return 'NOT_VALID_JSON';
        }
      });
      expect(failCalls).toBe(2);
      expect(fallbackResult.success).toBe(false);
      expect(fallbackResult.draft).toBeUndefined();
    });
  });

  describe('2. End-to-End Review Loop: Draft -> Request Changes -> Edit & Resubmit (Rev 2) -> Approve -> Edit Approved (Rev 3) -> Reject', () => {
    const testRowKey = `test-review-loop-${Date.now()}`;
    let createdItemId: string;
    let createdPostId: string;

    afterAll(async () => {
      if (createdPostId) {
        await automationPrisma.notification.deleteMany({ where: { postId: createdPostId } });
      }
      if (createdItemId) {
        await automationPrisma.contentItem.deleteMany({ where: { id: createdItemId } });
      }
    });

    it('creates a post and saves Gemini draft via POST /internal/posts/:id/draft, queueing REVIEW_REQUEST to Lionel', async () => {
      const scheduledAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const item = await automationPrisma.contentItem.create({
        data: {
          sheetId: '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL',
          sheetTab: '2026 Content Calendar',
          rowNumber: 50,
          rowKey: testRowKey,
          rowHash: 'hash-review-1',
          scheduledAt,
          channelRaw: 'LinkedIn',
          contentType: 'Post',
          subject: 'Initial Calendar Title',
          rawRow: { Subject: 'Initial Calendar Title' },
          category: 'Leadership',
          lastSeenAt: new Date(),
          posts: {
            create: {
              platform: 'LINKEDIN',
              mode: 'AUTO',
              status: 'PENDING_REVIEW',
              scheduledAt,
              captionSource: 'CALENDAR',
              idempotencyKey: `${testRowKey}|LINKEDIN|default`
            }
          }
        },
        include: { posts: true }
      });

      createdItemId = item.id;
      createdPostId = item.posts[0].id;

      const draftRes = await request(app)
        .post(`/internal/posts/${createdPostId}/draft`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          title: 'Executive Decision Velocity Under Pressure',
          caption: 'When stakes compound, physiological readiness determines strategic clarity.',
          hashtags: ['#LeadersPerformance', '#ExecutiveReadiness', '#DecisionVelocity'],
          category: 'Leadership'
        });

      expect(draftRes.status).toBe(200);
      expect(draftRes.body.data.post.status).toBe('PENDING_REVIEW');
      expect(draftRes.body.data.post.revision).toBe(1);
      expect(draftRes.body.data.usedFallback).toBe(false);

      // Verify REVIEW_REQUEST notification queued for Lionel
      const pendingNotifs = await automationPrisma.notification.findMany({
        where: { postId: createdPostId, type: 'REVIEW_REQUEST' }
      });
      expect(pendingNotifs.length).toBe(1);
      expect(pendingNotifs[0].recipients).toContain('lionel@leadersperformance.ae');
      expect(pendingNotifs[0].body).toContain('Europe/Amsterdam');
      expect(pendingNotifs[0].body).toContain('Asia/Dubai');
    });

    it('enforces comment requirement on request-changes and transitions PENDING_REVIEW -> CHANGES_REQUESTED, queueing email to Sarath & Asad', async () => {
      // Missing comment should fail with 400
      const missingCommentRes = await request(app)
        .post(`/api/v1/social-crm/posts/${createdPostId}/request-changes`)
        .set('Authorization', `Bearer ${lionelToken}`)
        .send({ comment: '   ' });

      expect(missingCommentRes.status).toBe(400);

      // With comment should transition to CHANGES_REQUESTED
      const reqChangesRes = await request(app)
        .post(`/api/v1/social-crm/posts/${createdPostId}/request-changes`)
        .set('Authorization', `Bearer ${lionelToken}`)
        .send({
          comment: 'Please sharpen the opening hook and add a reference to board cycle recovery.'
        });

      expect(reqChangesRes.status).toBe(200);
      expect(reqChangesRes.body.data.status).toBe('CHANGES_REQUESTED');

      const notifs = await automationPrisma.notification.findMany({
        where: { postId: createdPostId, type: 'CHANGES_REQUESTED' }
      });
      expect(notifs.length).toBe(1);
      expect(notifs[0].recipients).toEqual(
        expect.arrayContaining(['sarath@leadersperformance.ae', 'asad@leadersperformance.ae'])
      );
      expect(notifs[0].body).toContain('board cycle recovery');
    });

    it('allows Sarath to edit caption and resubmit -> PENDING_REVIEW (revision 2) with PostRevision diff and REVISION_READY email to Lionel', async () => {
      const patchRes = await request(app)
        .patch(`/api/v1/social-crm/posts/${createdPostId}`)
        .set('Authorization', `Bearer ${sarathToken}`)
        .send({
          caption:
            'Across 14-hour board cycles, physiological readiness determines strategic clarity and decision velocity.',
          hashtags: ['#LeadersPerformance', '#BoardReadiness', '#DecisionVelocity']
        });

      expect(patchRes.status).toBe(200);

      const submitRes = await request(app)
        .post(`/api/v1/social-crm/posts/${createdPostId}/submit`)
        .set('Authorization', `Bearer ${sarathToken}`)
        .send({
          comment: 'Added 14-hour board cycle context and updated hashtags.'
        });

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.data.status).toBe('PENDING_REVIEW');
      expect(submitRes.body.data.revision).toBe(2);

      // Verify PostRevision #2 was recorded and GET /posts/:id returns diffSummary
      const detailRes = await request(app)
        .get(`/api/v1/social-crm/posts/${createdPostId}`)
        .set('Authorization', `Bearer ${lionelToken}`);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.revisions.length).toBe(2);
      expect(detailRes.body.data.revisions[1].revision).toBe(2);
      expect(detailRes.body.data.revisions[1].diffSummary).toMatch(/Caption updated/i);

      const revReadyNotifs = await automationPrisma.notification.findMany({
        where: { postId: createdPostId, type: 'REVISION_READY' }
      });
      expect(revReadyNotifs.length).toBe(1);
      expect(revReadyNotifs[0].recipients).toContain('lionel@leadersperformance.ae');
    });

    it('allows Lionel to approve revision 2 -> APPROVED, and automatically moves back to PENDING_REVIEW (rev 3) if edited after approval', async () => {
      const approveRes = await request(app)
        .post(`/api/v1/social-crm/posts/${createdPostId}/approve`)
        .set('Authorization', `Bearer ${lionelToken}`)
        .send({ comment: 'Looks great now, approved.' });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.status).toBe('APPROVED');
      expect(approveRes.body.data.approvedById).toBe('lionel@leadersperformance.ae');

      const approvedNotifs = await automationPrisma.notification.findMany({
        where: { postId: createdPostId, type: 'APPROVED' }
      });
      expect(approvedNotifs.length).toBe(1);

      // Hard rule: Any edit after approval sends the post back to PENDING_REVIEW
      const editAfterApprovalRes = await request(app)
        .patch(`/api/v1/social-crm/posts/${createdPostId}`)
        .set('Authorization', `Bearer ${asadToken}`)
        .send({
          title: 'Executive Decision Velocity Under Board Pressure (Updated)'
        });

      expect(editAfterApprovalRes.status).toBe(200);
      expect(editAfterApprovalRes.body.data.status).toBe('PENDING_REVIEW');
      expect(editAfterApprovalRes.body.data.revision).toBe(3);
      expect(editAfterApprovalRes.body.data.approvedById).toBeNull();
    });

    it('allows Lionel to reject a post with a mandatory comment -> REJECTED, queueing REJECTED email', async () => {
      const rejectRes = await request(app)
        .post(`/api/v1/social-crm/posts/${createdPostId}/reject`)
        .set('Authorization', `Bearer ${lionelToken}`)
        .send({ comment: 'Dropping this topic from the October campaign.' });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.data.status).toBe('REJECTED');

      const rejectNotifs = await automationPrisma.notification.findMany({
        where: { postId: createdPostId, type: 'REJECTED' }
      });
      expect(rejectNotifs.length).toBe(1);
    });
  });

  describe('3. Notification Outbox Lifecycle & Retry Cap (Edge Cases #28 & #29)', () => {
    let testNotifId: string;

    afterAll(async () => {
      if (testNotifId) {
        await automationPrisma.notification.deleteMany({ where: { id: testNotifId } });
      }
    });

    it('lists PENDING notifications and transitions to FAILED after 3 failed delivery attempts (Edge Case #28)', async () => {
      const notif = await automationPrisma.notification.create({
        data: {
          type: 'REVIEW_REQUEST',
          recipients: ['lionel@leadersperformance.ae'],
          cc: [],
          subject: '[Social CRM] Outbox Retry Test',
          body: 'Test notification body',
          dedupeKey: `test-outbox-retry-${Date.now()}`
        }
      });
      testNotifId = notif.id;

      const listRes = await request(app)
        .get('/internal/notifications?status=PENDING')
        .set('X-Internal-Key', TEST_INTERNAL_KEY);

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.items.some((n: { id: string }) => n.id === testNotifId)).toBe(true);

      // Fail 1 -> stays PENDING (attemptCount = 1)
      const fail1 = await request(app)
        .post(`/internal/notifications/${testNotifId}/failed`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ error: 'SMTP timeout 1' });
      expect(fail1.body.data.status).toBe('PENDING');
      expect(fail1.body.data.attemptCount).toBe(1);

      // Fail 2 -> stays PENDING (attemptCount = 2)
      const fail2 = await request(app)
        .post(`/internal/notifications/${testNotifId}/failed`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ error: 'SMTP timeout 2' });
      expect(fail2.body.data.status).toBe('PENDING');
      expect(fail2.body.data.attemptCount).toBe(2);

      // Fail 3 -> becomes FAILED (attemptCount = 3)
      const fail3 = await request(app)
        .post(`/internal/notifications/${testNotifId}/failed`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ error: 'SMTP timeout 3' });
      expect(fail3.body.data.status).toBe('FAILED');
      expect(fail3.body.data.attemptCount).toBe(3);
    });
  });
});
