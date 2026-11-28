import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { LinkedInSchedulerJob } from '../modules/content/jobs/linkedinSchedulerJob';
import { contentPrisma } from '../modules/content/services/content.service';

describe('LinkedInSchedulerJob - Publishing Switch & Restart Hardening', () => {
  const originalEnv = { ...process.env };
  const mockPosts = new Map<string, any>();
  const mockSystemConfig = new Map<string, any>();
  const publishPostNowSpy = jest.fn<any>();

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockPosts.clear();
    mockSystemConfig.clear();
    publishPostNowSpy.mockReset();
    LinkedInSchedulerJob.resetState();

    // Mock contentPrisma.systemConfig
    jest.spyOn(contentPrisma.systemConfig, 'findUnique').mockImplementation((async ({ where }: any) => {
      const row = mockSystemConfig.get(where.key);
      return row ? { key: where.key, value: row.value, updatedAt: new Date() } : null;
    }) as any);

    jest.spyOn(contentPrisma.systemConfig, 'upsert').mockImplementation((async ({ where, create, update }: any) => {
      const val = update?.value || create?.value;
      const row = { key: where.key, value: val, updatedAt: new Date() };
      mockSystemConfig.set(where.key, row);
      return row;
    }) as any);

    // Mock contentPrisma.socialPost
    jest.spyOn(contentPrisma.socialPost, 'findMany').mockImplementation((async ({ where }: any = {}) => {
      return Array.from(mockPosts.values()).filter((p) => {
        if (where?.platform && p.platform !== where.platform) return false;
        if (where?.status && p.status !== where.status) return false;
        if (where?.approvalSignature?.not === null && !p.approvalSignature) return false;
        if (where?.scheduledFor?.lte && (!p.scheduledFor || new Date(p.scheduledFor) > where.scheduledFor.lte)) {
          return false;
        }
        return true;
      });
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'update').mockImplementation((async ({ where, data }: any) => {
      const existing = mockPosts.get(where.id);
      if (!existing) throw new Error('Post not found');
      const updated = { ...existing, ...data };
      mockPosts.set(where.id, updated);
      return updated;
    }) as any);

    jest.spyOn(contentPrisma.socialAuditLog, 'create').mockResolvedValue({ id: 'audit-1' } as any);

    // Mock ContentService.prototype.publishPostNow
    const { ContentService } = require('../modules/content/services/content.service');
    jest.spyOn(ContentService.prototype, 'publishPostNow').mockImplementation(publishPostNowSpy);
  });

  afterEach(() => {
    LinkedInSchedulerJob.stop();
    LinkedInSchedulerJob.resetState();
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('Done when 1: After a restart with publishing on, due approved posts are published, not marked FAILED', async () => {
    // 1. Prior state before restart: publishing was ON and active in SystemConfig
    const pastGoLiveTime = new Date(Date.now() - 3600_000); // went live 1 hour ago
    mockSystemConfig.set('linkedin_publishing_switch_state', {
      key: 'linkedin_publishing_switch_state',
      value: JSON.stringify({
        enabled: true,
        enabledAt: pastGoLiveTime.toISOString(),
        updatedAt: pastGoLiveTime.toISOString(),
      }),
    });

    process.env.LINKEDIN_PUBLISHING_ENABLED = 'true';
    process.env.NODE_ENV = 'production';

    // 2. An approved post became due 2 minutes ago (approved while publishing was already on)
    const duePost = {
      id: 'post-due-on-deploy',
      title: 'Due Post During Deploy',
      platform: 'LINKEDIN',
      status: 'SCHEDULED',
      approvalSignature: 'valid-sig-123',
      approvedBy: 'Lionel Eersteling',
      approvedAt: new Date(Date.now() - 1800_000),
      scheduledFor: new Date(Date.now() - 120_000), // due 2 mins ago
      metadata: {}, // NOT approvedWhilePublishingDisabled
    };
    mockPosts.set(duePost.id, duePost);

    // 3. Simulate process restart:
    // start() initializes scheduler without resetting wasPublishingEnabled to false
    LinkedInSchedulerJob.resetState(); // in-memory state is null on fresh boot
    LinkedInSchedulerJob.start();

    // 4. Run scheduler tick
    await LinkedInSchedulerJob.tick();

    // 5. Post must NOT be marked FAILED
    const evaluatedPost = mockPosts.get(duePost.id);
    expect(evaluatedPost.status).not.toBe('FAILED');
    expect(evaluatedPost.approvalSignature).toBe('valid-sig-123');

    // 6. Post must be dispatched for publishing
    expect(publishPostNowSpy).toHaveBeenCalledTimes(1);
    expect(publishPostNowSpy).toHaveBeenCalledWith(duePost.id, 'LinkedInSchedulerJob:Daemon');
  });

  it('Done when 2: Turning the switch from off to on still expires posts that became due while it was off', async () => {
    // 1. Publishing is OFF initially
    process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';
    process.env.NODE_ENV = 'production';

    // 2. Scheduler runs while OFF, recording state in DB
    await LinkedInSchedulerJob.tick();
    const recordedOff = mockSystemConfig.get('linkedin_publishing_switch_state');
    expect(recordedOff).toBeDefined();
    expect(JSON.parse(recordedOff.value).enabled).toBe(false);

    // 3. A post became due while publishing was OFF
    const staleDuePost = {
      id: 'post-stale-while-off',
      title: 'Post That Became Due While Off',
      platform: 'LINKEDIN',
      status: 'SCHEDULED',
      approvalSignature: 'old-sig-abc',
      approvedBy: 'Lionel Eersteling',
      approvedAt: new Date(Date.now() - 7200_000),
      scheduledFor: new Date(Date.now() - 1800_000), // scheduled 30 mins ago while off
      metadata: {},
    };
    mockPosts.set(staleDuePost.id, staleDuePost);

    // 4. Switch is flipped from OFF to ON
    process.env.LINKEDIN_PUBLISHING_ENABLED = 'true';

    // 5. Run scheduler tick
    await LinkedInSchedulerJob.tick();

    // 6. Post must be marked FAILED with signature cleared (expired at go-live)
    const evaluatedPost = mockPosts.get(staleDuePost.id);
    expect(evaluatedPost.status).toBe('FAILED');
    expect(evaluatedPost.approvalSignature).toBeNull();
    expect(evaluatedPost.approvedBy).toBeNull();
    expect(evaluatedPost.rejectionReason).toContain('Scheduled time already passed while publishing was disabled');

    // 7. publishPostNow must NOT have been called for the expired post
    expect(publishPostNowSpy).not.toHaveBeenCalled();

    // 8. SystemConfig must be updated to enabled: true
    const recordedOn = mockSystemConfig.get('linkedin_publishing_switch_state');
    expect(recordedOn).toBeDefined();
    expect(JSON.parse(recordedOn.value).enabled).toBe(true);
  });

  it('Preserves state when start() is called and does not reset flags to false', () => {
    // Set active state
    LinkedInSchedulerJob.resetState({
      wasPublishingEnabled: true,
      publishingEnabledAt: new Date('2026-11-28T10:00:00Z'),
    });

    process.env.NODE_ENV = 'production';
    LinkedInSchedulerJob.start();

    // Internal state must retain wasPublishingEnabled === true, not reset to false
    expect((LinkedInSchedulerJob as any).wasPublishingEnabled).toBe(true);
    expect((LinkedInSchedulerJob as any).publishingEnabledAt).toEqual(new Date('2026-11-28T10:00:00Z'));
  });
});
