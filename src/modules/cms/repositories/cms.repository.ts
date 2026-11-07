import { PrismaClient, CmsPageStatus } from '@prisma/client';
import {
  CmsPageInput,
  CmsSectionInput,
  CmsTestimonialInput,
  CmsFaqInput,
  CmsNavigationMenuInput,
  CmsSiteSettingInput,
} from '../validation/cms.validation';

const prisma = new PrismaClient();

export class CmsRepository {
  private static tablesInitialized = false;

  /**
   * Automatically ensure CMS tables exist in database on first access
   */
  public async ensureTables(): Promise<void> {
    if (CmsRepository.tablesInitialized) return;

    const statements = [
      `DO $$ BEGIN
        CREATE TYPE "CmsPageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;`,
      `CREATE TABLE IF NOT EXISTS "cms_pages" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" TEXT UNIQUE NOT NULL,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "status" "CmsPageStatus" NOT NULL DEFAULT 'DRAFT',
        "version" INTEGER NOT NULL DEFAULT 1,
        "seo_title" TEXT,
        "meta_description" TEXT,
        "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "og_image" TEXT,
        "og_type" TEXT NOT NULL DEFAULT 'website',
        "canonical_url" TEXT,
        "schema_json" JSONB,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "published_at" TIMESTAMP(3)
      );`,
      `CREATE TABLE IF NOT EXISTS "cms_page_sections" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "page_id" TEXT NOT NULL REFERENCES "cms_pages"("id") ON DELETE CASCADE,
        "section_key" TEXT NOT NULL,
        "section_type" TEXT NOT NULL,
        "order" INTEGER NOT NULL DEFAULT 0,
        "is_enabled" BOOLEAN NOT NULL DEFAULT true,
        "content" JSONB NOT NULL,
        CONSTRAINT "uq_cms_page_section" UNIQUE ("page_id", "section_key")
      );`,
      `CREATE TABLE IF NOT EXISTS "cms_testimonials" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" TEXT NOT NULL,
        "role" TEXT NOT NULL,
        "company" TEXT,
        "avatar_url" TEXT NOT NULL,
        "short_text" TEXT NOT NULL,
        "full_text" TEXT[] NOT NULL,
        "category" TEXT NOT NULL DEFAULT 'general',
        "order" INTEGER NOT NULL DEFAULT 0,
        "is_featured" BOOLEAN NOT NULL DEFAULT false,
        "published" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS "cms_faqs" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "question" TEXT NOT NULL,
        "answer" TEXT NOT NULL,
        "category" TEXT NOT NULL,
        "order" INTEGER NOT NULL DEFAULT 0,
        "published" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS "cms_navigation_menus" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        "location" TEXT UNIQUE NOT NULL,
        "title" TEXT NOT NULL,
        "items" JSONB NOT NULL,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS "cms_site_settings" (
        "key" TEXT PRIMARY KEY,
        "value" JSONB NOT NULL,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE INDEX IF NOT EXISTS "idx_cms_pages_slug_status" ON "cms_pages"("slug", "status");`,
      `CREATE INDEX IF NOT EXISTS "idx_cms_sections_page_order" ON "cms_page_sections"("page_id", "order");`,
      `CREATE INDEX IF NOT EXISTS "idx_cms_testimonials_cat_pub" ON "cms_testimonials"("category", "published");`,
      `CREATE INDEX IF NOT EXISTS "idx_cms_faqs_cat_pub" ON "cms_faqs"("category", "published");`,
      `CREATE TABLE IF NOT EXISTS "cms_texts" (
        "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" VARCHAR(200) NOT NULL,
        "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
        "has_draft" BOOLEAN NOT NULL DEFAULT false,
        "draft_value" TEXT,
        "published_value" TEXT,
        "updated_by" TEXT,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "published_by" TEXT,
        "published_at" TIMESTAMP(3)
      );`,
      `CREATE TABLE IF NOT EXISTS "cms_text_revisions" (
        "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" VARCHAR(200) NOT NULL,
        "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
        "value" TEXT,
        "action" VARCHAR(50) NOT NULL,
        "actor_email" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "cms_texts_key_locale_key" ON "cms_texts"("key", "locale");`,
      `CREATE INDEX IF NOT EXISTS "cms_texts_locale_idx" ON "cms_texts"("locale");`,
      `CREATE INDEX IF NOT EXISTS "cms_text_revisions_key_locale_idx" ON "cms_text_revisions"("key", "locale");`,
      `CREATE INDEX IF NOT EXISTS "cms_text_revisions_created_at_idx" ON "cms_text_revisions"("created_at");`,
    ];

    try {
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement).catch((err: any) => {
          // Ignore if type or index already exists
          if (!err.message.includes('already exists')) {
            console.warn('[CmsRepository] Warning on statement:', err.message);
          }
        });
      }
      CmsRepository.tablesInitialized = true;
    } catch (err: any) {
      console.warn('[CmsRepository] Note during ensureTables:', err.message);
    }
  }

  // --- Pages & Sections ---

  public async findPublishedPageBySlug(slug: string) {
    await this.ensureTables();
    return prisma.cmsPage.findFirst({
      where: {
        slug,
        status: CmsPageStatus.PUBLISHED,
      },
      include: {
        sections: {
          where: { isEnabled: true },
          orderBy: { order: 'asc' },
        },
      },
    });
  }

  public async findPageBySlug(slug: string) {
    await this.ensureTables();
    return prisma.cmsPage.findUnique({
      where: { slug },
      include: {
        sections: {
          orderBy: { order: 'asc' },
        },
      },
    });
  }

  public async findAllPages(status?: CmsPageStatus) {
    await this.ensureTables();
    return prisma.cmsPage.findMany({
      where: status ? { status } : undefined,
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        version: true,
        seoTitle: true,
        updatedAt: true,
        publishedAt: true,
        _count: {
          select: { sections: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  public async upsertPage(input: CmsPageInput) {
    await this.ensureTables();
    const existing = await prisma.cmsPage.findUnique({
      where: { slug: input.slug },
    });

    if (existing) {
      return prisma.cmsPage.update({
        where: { slug: input.slug },
        data: {
          title: input.title,
          description: input.description,
          status: input.status ? (input.status as CmsPageStatus) : existing.status, // Fix 2c: Preserve status
          version: existing.version + 1,
          seoTitle: input.seoTitle,
          metaDescription: input.metaDescription,
          keywords: input.keywords,
          ogImage: input.ogImage,
          ogType: input.ogType,
          canonicalUrl: input.canonicalUrl,
          schemaJson: input.schemaJson as any,
        },
        include: { sections: true },
      });
    }

    return prisma.cmsPage.create({
      data: {
        slug: input.slug,
        title: input.title,
        description: input.description,
        status: (input.status as CmsPageStatus) || CmsPageStatus.DRAFT,
        version: 1,
        seoTitle: input.seoTitle,
        metaDescription: input.metaDescription,
        keywords: input.keywords,
        ogImage: input.ogImage,
        ogType: input.ogType,
        canonicalUrl: input.canonicalUrl,
        schemaJson: input.schemaJson as any,
        publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
      },
      include: { sections: true },
    });
  }

  public async upsertSection(pageId: string, section: CmsSectionInput) {
    await this.ensureTables();
    return prisma.cmsPageSection.upsert({
      where: {
        pageId_sectionKey: {
          pageId,
          sectionKey: section.sectionKey,
        },
      },
      create: {
        pageId,
        sectionKey: section.sectionKey,
        sectionType: section.sectionType,
        order: section.order,
        isEnabled: section.isEnabled,
        content: section.content as any,
      },
      update: {
        sectionType: section.sectionType,
        order: section.order,
        isEnabled: section.isEnabled,
        content: section.content as any,
      },
    });
  }

  public async publishPage(slug: string) {
    await this.ensureTables();
    const existing = await prisma.cmsPage.findUnique({ where: { slug } });
    const nextVersion = existing ? existing.version + 1 : 1; // Fix 2e: Increment version

    return prisma.cmsPage.update({
      where: { slug },
      data: {
        status: CmsPageStatus.PUBLISHED,
        version: nextVersion,
        publishedAt: new Date(),
      },
      include: {
        sections: {
          where: { isEnabled: true },
          orderBy: { order: 'asc' },
        },
      },
    });
  }

  public async deletePage(slug: string) {
    await this.ensureTables();
    return prisma.cmsPage.delete({
      where: { slug },
    });
  }

  // --- Testimonials ---

  public async findTestimonials(category?: string, publishedOnly: boolean = true) {
    await this.ensureTables();
    return prisma.cmsTestimonial.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(publishedOnly ? { published: true } : {}),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
    });
  }

  public async upsertTestimonial(id: string | null, input: CmsTestimonialInput) {
    await this.ensureTables();
    if (id) {
      return prisma.cmsTestimonial.update({
        where: { id },
        data: {
          name: input.name,
          role: input.role,
          company: input.company,
          avatarUrl: input.avatarUrl,
          shortText: input.shortText,
          fullText: input.fullText,
          category: input.category,
          order: input.order,
          isFeatured: input.isFeatured,
          published: input.published,
        },
      });
    }

    return prisma.cmsTestimonial.create({
      data: {
        name: input.name,
        role: input.role,
        company: input.company,
        avatarUrl: input.avatarUrl,
        shortText: input.shortText,
        fullText: input.fullText,
        category: input.category,
        order: input.order,
        isFeatured: input.isFeatured,
        published: input.published,
      },
    });
  }

  public async deleteTestimonial(id: string) {
    await this.ensureTables();
    return prisma.cmsTestimonial.delete({ where: { id } });
  }

  // --- FAQs ---

  public async findFaqs(category?: string, publishedOnly: boolean = true) {
    await this.ensureTables();
    return prisma.cmsFaq.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(publishedOnly ? { published: true } : {}),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
    });
  }

  public async upsertFaq(id: string | null, input: CmsFaqInput) {
    await this.ensureTables();
    if (id) {
      return prisma.cmsFaq.update({
        where: { id },
        data: {
          question: input.question,
          answer: input.answer,
          category: input.category,
          order: input.order,
          published: input.published,
        },
      });
    }

    return prisma.cmsFaq.create({
      data: {
        question: input.question,
        answer: input.answer,
        category: input.category,
        order: input.order,
        published: input.published,
      },
    });
  }

  public async deleteFaq(id: string) {
    await this.ensureTables();
    return prisma.cmsFaq.delete({ where: { id } });
  }

  // --- Navigation Menus ---

  public async findNavigationMenu(location: string) {
    await this.ensureTables();
    return prisma.cmsNavigationMenu.findUnique({
      where: { location },
    });
  }

  public async findAllNavigationMenus() {
    await this.ensureTables();
    return prisma.cmsNavigationMenu.findMany();
  }

  public async upsertNavigationMenu(input: CmsNavigationMenuInput) {
    await this.ensureTables();
    return prisma.cmsNavigationMenu.upsert({
      where: { location: input.location },
      create: {
        location: input.location,
        title: input.title,
        items: input.items as any,
      },
      update: {
        title: input.title,
        items: input.items as any,
      },
    });
  }

  // --- Site Settings ---

  public async findSiteSetting(key: string) {
    await this.ensureTables();
    return prisma.cmsSiteSetting.findUnique({
      where: { key },
    });
  }

  public async findAllSiteSettings() {
    await this.ensureTables();
    return prisma.cmsSiteSetting.findMany();
  }

  public async upsertSiteSetting(input: CmsSiteSettingInput) {
    await this.ensureTables();
    return prisma.cmsSiteSetting.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        value: input.value as any,
      },
      update: {
        value: input.value as any,
      },
    });
  }

  // ============================================================================
  // CMS TEXTS & REVISIONS (Section 4)
  // ============================================================================

  public async getTextVersionConfig(locale: string = 'en') {
    const configKey = `cms_texts_version_${locale}`;
    const row = await prisma.systemConfig.findUnique({
      where: { key: configKey },
    });

    if (row && row.value) {
      try {
        return JSON.parse(row.value) as { version: number; publishedAt: string };
      } catch {}
    }

    return { version: 1, publishedAt: new Date().toISOString() };
  }

  public async updateTextVersionConfig(locale: string = 'en', nextVersion: number, publishedAt: string) {
    const configKey = `cms_texts_version_${locale}`;
    const payload = JSON.stringify({ version: nextVersion, publishedAt });
    await prisma.systemConfig.upsert({
      where: { key: configKey },
      create: { key: configKey, value: payload },
      update: { value: payload },
    });
  }

  public async findPublishedTexts(locale: string = 'en') {
    await this.ensureTables();
    const rows = await prisma.cmsText.findMany({
      where: {
        locale,
        publishedValue: { not: null },
      },
      select: {
        key: true,
        publishedValue: true,
      },
      orderBy: { key: 'asc' },
    });

    const textsMap: Record<string, string> = {};
    for (const r of rows) {
      if (r.publishedValue !== null) {
        textsMap[r.key] = r.publishedValue;
      }
    }

    const versionConfig = await this.getTextVersionConfig(locale);

    return {
      version: versionConfig.version,
      publishedAt: versionConfig.publishedAt,
      texts: textsMap,
    };
  }

  public async findAllTexts(locale: string = 'en') {
    await this.ensureTables();
    return prisma.cmsText.findMany({
      where: { locale },
      select: {
        key: true,
        hasDraft: true,
        draftValue: true,
        publishedValue: true,
        updatedBy: true,
        updatedAt: true,
        publishedBy: true,
        publishedAt: true,
      },
      orderBy: { key: 'asc' },
    });
  }

  public async upsertTextDraft(key: string, locale: string, value: string | null, actorEmail: string) {
    await this.ensureTables();
    const existing = await prisma.cmsText.findUnique({
      where: { key_locale: { key, locale } },
    });

    const now = new Date();
    let textRow;

    if (existing) {
      textRow = await prisma.cmsText.update({
        where: { key_locale: { key, locale } },
        data: {
          hasDraft: true,
          draftValue: value,
          updatedBy: actorEmail,
          updatedAt: now,
        },
      });
    } else {
      textRow = await prisma.cmsText.create({
        data: {
          key,
          locale,
          hasDraft: true,
          draftValue: value,
          publishedValue: null,
          updatedBy: actorEmail,
          updatedAt: now,
        },
      });
    }

    // Add revision row
    await prisma.cmsTextRevision.create({
      data: {
        key,
        locale,
        value,
        action: 'SAVE_DRAFT',
        actorEmail,
        createdAt: now,
      },
    });

    // Write to audit log
    await prisma.socialAuditLog.create({
      data: {
        actor: actorEmail,
        action: 'CMS_TEXT_DRAFT_SAVED',
        entity: `CmsText [${locale}] ${key}`,
        details: `Saved draft value: "${existing?.draftValue ?? 'none'}" -> "${value ?? 'null (original)'}"`,
      },
    }).catch(() => {});

    return textRow;
  }

  public async discardTextDrafts(keys: string[], locale: string = 'en', actorEmail: string) {
    await this.ensureTables();
    const now = new Date();
    let discardedCount = 0;

    for (const key of keys) {
      const existing = await prisma.cmsText.findUnique({
        where: { key_locale: { key, locale } },
      });

      if (!existing || !existing.hasDraft) continue;

      if (existing.publishedValue === null) {
        // If it was never published, delete the draft row entirely
        await prisma.cmsText.delete({
          where: { key_locale: { key, locale } },
        });
      } else {
        await prisma.cmsText.update({
          where: { key_locale: { key, locale } },
          data: {
            hasDraft: false,
            draftValue: null,
            updatedBy: actorEmail,
            updatedAt: now,
          },
        });
      }

      await prisma.cmsTextRevision.create({
        data: {
          key,
          locale,
          value: existing.publishedValue,
          action: 'DISCARD',
          actorEmail,
          createdAt: now,
        },
      });

      await prisma.socialAuditLog.create({
        data: {
          actor: actorEmail,
          action: 'CMS_TEXT_DRAFT_DISCARDED',
          entity: `CmsText [${locale}] ${key}`,
          details: `Discarded draft: "${existing.draftValue}" (reverted to published value: "${existing.publishedValue}")`,
        },
      }).catch(() => {});

      discardedCount++;
    }

    return { discardedCount };
  }

  public async publishTextDrafts(keys: string[] | undefined, locale: string, actorEmail: string) {
    await this.ensureTables();
    const now = new Date();
    const whereClause: any = {
      locale,
      hasDraft: true,
    };

    if (keys && keys.length > 0) {
      whereClause.key = { in: keys };
    }

    const pendingDrafts = await prisma.cmsText.findMany({
      where: whereClause,
    });

    const versionConfig = await this.getTextVersionConfig(locale);

    // No-op when nothing is pending: do not increment version
    if (pendingDrafts.length === 0) {
      return {
        version: versionConfig.version,
        publishedAt: versionConfig.publishedAt,
        publishedCount: 0,
      };
    }

    for (const draft of pendingDrafts) {
      await prisma.cmsText.update({
        where: { id: draft.id },
        data: {
          publishedValue: draft.draftValue,
          hasDraft: false,
          draftValue: null,
          publishedBy: actorEmail,
          publishedAt: now,
          updatedAt: now,
        },
      });

      await prisma.cmsTextRevision.create({
        data: {
          key: draft.key,
          locale,
          value: draft.draftValue,
          action: 'PUBLISH',
          actorEmail,
          createdAt: now,
        },
      });

      await prisma.socialAuditLog.create({
        data: {
          actor: actorEmail,
          action: 'CMS_TEXT_PUBLISHED',
          entity: `CmsText [${locale}] ${draft.key}`,
          details: `Published live text: "${draft.publishedValue ?? 'none'}" -> "${draft.draftValue ?? 'null (original)'}"`,
        },
      }).catch(() => {});
    }

    // Increment version only when at least one pending draft was published
    const nextVersion = versionConfig.version + 1;
    const publishedAtStr = now.toISOString();
    await this.updateTextVersionConfig(locale, nextVersion, publishedAtStr);

    return {
      version: nextVersion,
      publishedAt: publishedAtStr,
      publishedCount: pendingDrafts.length,
    };
  }

  public async findTextHistory(key: string, locale: string = 'en') {
    await this.ensureTables();
    return prisma.cmsTextRevision.findMany({
      where: { key, locale },
      select: {
        id: true,
        key: true,
        locale: true,
        value: true,
        action: true,
        actorEmail: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

export const cmsRepository = new CmsRepository();
