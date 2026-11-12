import { automationPrisma } from '../state/transition';

export interface NotificationSettingsConfig {
  approverEmails: string[];
  reportCcEmails: string[];
  editorEmails: string[];
  adminEmails: string[];
  infoEmails: string[];
  reminderIntervalHours: number[];
  maxReminders: number;
  dryRunTestingMode: boolean;
  testSafetyEmail: string;
}

const SETTINGS_KEY = 'notification_settings';

const parseEnvList = (raw: string | undefined, fallback: string[]): string[] => {
  if (!raw) return fallback;
  const list = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettingsConfig = {
  approverEmails: parseEnvList(process.env.EMAIL_APPROVER, ['asif@leadersperformance.ae']),
  reportCcEmails: parseEnvList(process.env.REPORT_CC_EMAILS, ['asif@leadersperformance.ae']),
  editorEmails: parseEnvList(process.env.EMAIL_EDITORS, [
    'sharathkiranpr@gmail.com',
    'mirza@leadersperformance.ae',
  ]),
  adminEmails: parseEnvList(process.env.EMAIL_ADMIN, [
    'asif@leadersperformance.ae',
    'mirza@leadersperformance.ae',
  ]),
  infoEmails: parseEnvList(process.env.EMAIL_INFO, ['info@leadersperformance.ae']),
  reminderIntervalHours: [24, 48],
  maxReminders: 2,
  dryRunTestingMode: process.env.DRY_RUN_EMAIL_OVERRIDE === 'true' || process.env.NOTIFICATIONS_LIVE !== 'true',
  testSafetyEmail: process.env.TEST_EMAIL_RECIPIENT || 'asif@leadersperformance.ae',
};

class NotificationSettingsService {
  private cachedSettings: NotificationSettingsConfig | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 30000; // 30s cache

  public async getSettings(): Promise<NotificationSettingsConfig> {
    if (this.cachedSettings && Date.now() < this.cacheExpiresAt) {
      return { ...this.cachedSettings };
    }

    try {
      // 1. Try CrmSetting table
      const setting = await (automationPrisma as any).crmSetting.findUnique({
        where: { key: SETTINGS_KEY },
      });

      if (setting && setting.value) {
        const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
        this.cachedSettings = this.mergeWithDefaults(parsed);
        this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
        return { ...this.cachedSettings };
      }
    } catch {
      // Table might not be migrated yet or connection glitch, try fallback
    }

    try {
      // 2. Try SystemConfig fallback
      const sysConfig = await automationPrisma.systemConfig.findUnique({
        where: { key: SETTINGS_KEY },
      });

      if (sysConfig && sysConfig.value) {
        const parsed = JSON.parse(sysConfig.value);
        this.cachedSettings = this.mergeWithDefaults(parsed);
        this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
        return { ...this.cachedSettings };
      }
    } catch {
      // Fall through to defaults
    }

    this.cachedSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
    this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    return { ...this.cachedSettings };
  }

  public getSettingsSync(): NotificationSettingsConfig {
    if (this.cachedSettings) {
      return { ...this.cachedSettings };
    }
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }

  public async updateSettings(patch: Partial<NotificationSettingsConfig>): Promise<NotificationSettingsConfig> {
    const current = await this.getSettings();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const validateAndCleanEmails = (fieldName: string, list?: string[], allowEmpty = false): string[] | undefined => {
      if (list === undefined) return undefined;
      if (!Array.isArray(list)) {
        throw new Error(`${fieldName} must be an array of email strings.`);
      }
      if (!allowEmpty && list.length === 0) {
        throw new Error(`${fieldName} must contain at least one valid email address.`);
      }
      const cleaned: string[] = [];
      for (const item of list) {
        if (typeof item !== 'string' || !emailRegex.test(item.trim())) {
          throw new Error(`Invalid email address in ${fieldName}: "${item}"`);
        }
        cleaned.push(item.trim().toLowerCase());
      }
      return cleaned;
    };

    const nextApprover = validateAndCleanEmails('approverEmails', patch.approverEmails, false) ?? current.approverEmails;
    const nextReportCc = validateAndCleanEmails('reportCcEmails', patch.reportCcEmails, true) ?? current.reportCcEmails;
    const nextEditors = validateAndCleanEmails('editorEmails', patch.editorEmails, true) ?? current.editorEmails;
    const nextAdmin = validateAndCleanEmails('adminEmails', patch.adminEmails, true) ?? current.adminEmails;
    const nextInfo = validateAndCleanEmails('infoEmails', patch.infoEmails, true) ?? current.infoEmails;

    let nextIntervals = current.reminderIntervalHours;
    if (Array.isArray(patch.reminderIntervalHours) && patch.reminderIntervalHours.length > 0) {
      nextIntervals = patch.reminderIntervalHours
        .map((n) => Number(n))
        .filter((n) => !isNaN(n) && n > 0)
        .sort((a, b) => a - b);
      if (nextIntervals.length === 0) nextIntervals = [24, 48];
    }

    const nextMaxReminders =
      typeof patch.maxReminders === 'number' && patch.maxReminders > 0
        ? Math.min(patch.maxReminders, 5)
        : current.maxReminders;

    const nextDryRun =
      typeof patch.dryRunTestingMode === 'boolean'
        ? patch.dryRunTestingMode
        : current.dryRunTestingMode;

    const nextSafetyEmail =
      typeof patch.testSafetyEmail === 'string' && patch.testSafetyEmail.includes('@')
        ? patch.testSafetyEmail.trim().toLowerCase()
        : current.testSafetyEmail;

    const updated: NotificationSettingsConfig = {
      approverEmails: nextApprover.length > 0 ? nextApprover : ['lionel@leadersperformance.ae'],
      reportCcEmails: nextReportCc.length > 0 ? nextReportCc : ['danielle@eersteling.nl'],
      editorEmails: nextEditors,
      adminEmails: nextAdmin,
      infoEmails: nextInfo,
      reminderIntervalHours: nextIntervals,
      maxReminders: nextMaxReminders,
      dryRunTestingMode: nextDryRun,
      testSafetyEmail: nextSafetyEmail,
    };

    // Save to crmSetting
    try {
      await (automationPrisma as any).crmSetting.upsert({
        where: { key: SETTINGS_KEY },
        create: {
          key: SETTINGS_KEY,
          value: updated,
          description: 'Configurable recipient emails, report CC lists, and reminder timings',
        },
        update: {
          value: updated,
          updatedAt: new Date(),
        },
      });
    } catch {
      // Fallback save to systemConfig
      try {
        await automationPrisma.systemConfig.upsert({
          where: { key: SETTINGS_KEY },
          create: {
            key: SETTINGS_KEY,
            value: JSON.stringify(updated),
          },
          update: {
            value: JSON.stringify(updated),
          },
        });
      } catch (err: any) {
        console.error('[NotificationSettingsService] Failed to save settings to DB:', err?.message || err);
      }
    }

    this.cachedSettings = updated;
    this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    return { ...updated };
  }

  private mergeWithDefaults(raw: any): NotificationSettingsConfig {
    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_NOTIFICATION_SETTINGS };
    }

    const toStringArray = (val: any, fallback: string[]): string[] => {
      if (!Array.isArray(val)) return fallback;
      const res = val.map((x) => String(x || '').trim().toLowerCase()).filter((x) => x.includes('@'));
      return res.length > 0 ? res : fallback;
    };

    const toNumArray = (val: any, fallback: number[]): number[] => {
      if (!Array.isArray(val)) return fallback;
      const res = val.map((x) => Number(x)).filter((x) => !isNaN(x) && x > 0);
      return res.length > 0 ? res : fallback;
    };

    return {
      approverEmails: toStringArray(raw.approverEmails, DEFAULT_NOTIFICATION_SETTINGS.approverEmails),
      reportCcEmails: toStringArray(raw.reportCcEmails, DEFAULT_NOTIFICATION_SETTINGS.reportCcEmails),
      editorEmails: toStringArray(raw.editorEmails, DEFAULT_NOTIFICATION_SETTINGS.editorEmails),
      adminEmails: toStringArray(raw.adminEmails, DEFAULT_NOTIFICATION_SETTINGS.adminEmails),
      infoEmails: toStringArray(raw.infoEmails, DEFAULT_NOTIFICATION_SETTINGS.infoEmails),
      reminderIntervalHours: toNumArray(raw.reminderIntervalHours, DEFAULT_NOTIFICATION_SETTINGS.reminderIntervalHours),
      maxReminders: typeof raw.maxReminders === 'number' ? raw.maxReminders : DEFAULT_NOTIFICATION_SETTINGS.maxReminders,
      dryRunTestingMode:
        typeof raw.dryRunTestingMode === 'boolean'
          ? raw.dryRunTestingMode
          : DEFAULT_NOTIFICATION_SETTINGS.dryRunTestingMode,
      testSafetyEmail:
        typeof raw.testSafetyEmail === 'string' && raw.testSafetyEmail.includes('@')
          ? raw.testSafetyEmail
          : DEFAULT_NOTIFICATION_SETTINGS.testSafetyEmail,
    };
  }
}

export const notificationSettingsService = new NotificationSettingsService();
