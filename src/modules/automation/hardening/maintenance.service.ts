import {
  automationPrisma,
  transition,
  FINAL_POST_STATUSES,
  PostStatusType,
} from '../state/transition';
import {
  IStorageService,
  storageService as defaultStorageService,
} from '../storage/storage.service';
import { publisherService, PublisherService } from '../publisher/publisher.service';
import { decryptToken, encryptToken } from '../crypto/tokenCrypto';
import { notificationService } from '../notifications/notification.service';

export interface MaintenanceRunSummary {
  tokensRefreshed: string[];
  tokenRefreshFailed: string[];
  expiredMediaDeleted: number;
  unseenItemsCancelled: number;
  postsCancelled: string[];
  oldJobRunsDeleted: number;
}

export class MaintenanceService {
  constructor(
    private readonly storage: IStorageService = defaultStorageService,
    private readonly publisher: PublisherService = publisherService
  ) {}

  private resolveToken(encrypted?: string | null): string {
    if (!encrypted) return '';
    if (encrypted.startsWith('v1:')) {
      return decryptToken(encrypted);
    }
    return encrypted;
  }

  /**
   * Executes the 4 maintenance tasks at the end of Flow 1 (`POST /internal/maintenance/run`):
   * 1. Refreshes tokens that expire within 10 days
   * 2. Deletes Storage objects past `deleteAfter`
   * 3. Cancels ContentItems not seen in the calendar for 2 runs (`unseenRuns >= 2`, Edge Case #7)
   * 4. Deletes JobRun rows older than 90 days
   */
  public async run(options: { now?: Date } = {}): Promise<MaintenanceRunSummary> {
    const now = options.now || new Date();
    const in10Days = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const summary: MaintenanceRunSummary = {
      tokensRefreshed: [],
      tokenRefreshFailed: [],
      expiredMediaDeleted: 0,
      unseenItemsCancelled: 0,
      postsCancelled: [],
      oldJobRunsDeleted: 0,
    };

    // 1. Refresh tokens expiring within 10 days
    const expiringAccounts = await automationPrisma.socialAccount.findMany({
      where: {
        isActive: true,
        tokenExpiresAt: { not: null, lte: in10Days },
      },
    });

    for (const account of expiringAccounts) {
      const adapter = this.publisher.getAdapter(account.platform);
      const refreshPlain = account.refreshEncrypted
        ? this.resolveToken(account.refreshEncrypted)
        : '';

      if (!adapter || !refreshPlain) {
        if (account.tokenExpiresAt && account.tokenExpiresAt <= in7Days) {
          await notificationService.queueAccountAlert({
            type: 'TOKEN_EXPIRING',
            account: {
              id: account.id,
              platform: account.platform,
              label: account.label,
            },
            reason: `Token expires on ${account.tokenExpiresAt.toISOString()} and cannot be auto-refreshed.`,
            dedupeSuffix: now.toISOString().slice(0, 10),
          });
        }
        continue;
      }

      try {
        const refreshed = await adapter.refreshToken({
          id: account.id,
          platform: account.platform,
          externalId: account.externalId,
          refreshToken: refreshPlain,
        });

        await automationPrisma.socialAccount.update({
          where: { id: account.id },
          data: {
            tokenEncrypted: encryptToken(refreshed.accessToken),
            refreshEncrypted: refreshed.refreshToken
              ? encryptToken(refreshed.refreshToken)
              : account.refreshEncrypted,
            tokenExpiresAt: refreshed.expiresAt ?? account.tokenExpiresAt,
            isActive: true,
          },
        });
        summary.tokensRefreshed.push(account.id);
      } catch (err: any) {
        summary.tokenRefreshFailed.push(account.id);
        await notificationService.queueAccountAlert({
          type: 'TOKEN_EXPIRING',
          account: {
            id: account.id,
            platform: account.platform,
            label: account.label,
          },
          reason: `Auto-refresh failed (${err?.message || 'error'}); token expires at ${account.tokenExpiresAt?.toISOString()}`,
          dedupeSuffix: now.toISOString().slice(0, 10),
        });
      }
    }

    // 2. Delete Storage objects past `deleteAfter`
    const expiredAssets = await automationPrisma.mediaAsset.findMany({
      where: {
        deleteAfter: { not: null, lte: now },
        objectKey: { not: null },
      },
      take: 100,
    });

    for (const asset of expiredAssets) {
      if (!asset.objectKey) continue;
      try {
        if (process.env.NODE_ENV !== 'test') {
          await this.storage.delete(asset.objectKey, asset.bucket);
        }
        await automationPrisma.mediaAsset.update({
          where: { id: asset.id },
          data: {
            objectKey: null,
            deleteAfter: null,
          },
        });
        summary.expiredMediaDeleted += 1;
      } catch (err: any) {
        console.warn(`[Maintenance] postId=none delete expired asset ${asset.id} warning: ${err?.message}`);
      }
    }

    // 3. Cancel ContentItems not seen in the calendar for 2 runs (`unseenRuns >= 2`, Edge Case #7)
    const unseenItems = await automationPrisma.contentItem.findMany({
      where: {
        unseenRuns: { gte: 2 },
      },
      include: {
        posts: true,
      },
    });

    for (const item of unseenItems) {
      let itemHadActivePost = false;
      for (const post of item.posts) {
        if (!FINAL_POST_STATUSES.has(post.status as PostStatusType)) {
          try {
            const cancelled = await transition(post.id, 'CALENDAR_ROW_DELETED', {
              actorId: 'flow1-maintenance',
              now,
              comment: `Cancelled after calendar row was unseen for ${item.unseenRuns} consecutive runs`,
            });
            summary.postsCancelled.push(cancelled.id);
            itemHadActivePost = true;

            await notificationService.queueChangesRequestedOrRejected({
              type: 'REJECTED',
              post: {
                id: cancelled.id,
                platform: cancelled.platform,
                scheduledAt: cancelled.scheduledAt,
                title: cancelled.title,
                caption: cancelled.caption,
                revision: cancelled.revision,
              },
              comment: `Calendar row removed (unseen for ${item.unseenRuns} runs); post automatically CANCELLED.`,
            });
          } catch (err: any) {
            console.warn(`[Maintenance] postId=${post.id} cancel unseen post warning: ${err?.message}`);
          }
        }
      }
      if (itemHadActivePost) {
        summary.unseenItemsCancelled += 1;
      }
    }

    // 4. Delete JobRun rows older than 90 days
    const deletedRuns = await automationPrisma.jobRun.deleteMany({
      where: {
        startedAt: { lt: ninetyDaysAgo },
      },
    });
    summary.oldJobRunsDeleted = deletedRuns.count;

    console.log(
      `[Maintenance] postId=batch refreshed=${summary.tokensRefreshed.length} mediaDeleted=${summary.expiredMediaDeleted} postsCancelled=${summary.postsCancelled.length} jobRunsDeleted=${summary.oldJobRunsDeleted}`
    );

    return summary;
  }
}

export const maintenanceService = new MaintenanceService();

