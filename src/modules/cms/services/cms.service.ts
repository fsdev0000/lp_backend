import { cmsRepository, CmsRepository } from '../repositories/cms.repository';
import { cmsCache } from '../cache/cmsCache.service';
import {
  CmsPageInput,
  CmsSectionInput,
  CmsTestimonialInput,
  CmsFaqInput,
  CmsNavigationMenuInput,
  CmsSiteSettingInput,
} from '../validation/cms.validation';
import { CmsPageStatus } from '@prisma/client';

export class CmsService {
  private repository: CmsRepository;

  constructor(repo: CmsRepository = cmsRepository) {
    this.repository = repo;
  }

  // --- Public Read Methods (Highly optimized with Fallback Seeds) ---

  public async getPageBySlug(slug: string, preview: boolean = false) {
    const page = preview
      ? await this.repository.findPageBySlug(slug)
      : await this.repository.findPublishedPageBySlug(slug);

    if (page) return page;

    // Built-in resilient bootstrap fallback for core pages if database is newly initialized
    return this.getFallbackPage(slug);
  }

  public async getSectionByKey(slug: string, sectionKey: string) {
    const page = await this.getPageBySlug(slug);
    if (!page || !page.sections) return null;
    return page.sections.find((s: any) => s.sectionKey === sectionKey) || null;
  }

  public async getTestimonials(category?: string) {
    const results = await this.repository.findTestimonials(category, true);
    if (results && results.length > 0) return results;
    return this.getFallbackTestimonials(category);
  }

  public async getFaqs(category?: string) {
    const results = await this.repository.findFaqs(category, true);
    if (results && results.length > 0) return results;
    return this.getFallbackFaqs(category);
  }

  public async getNavigationMenu(location: string) {
    const menu = await this.repository.findNavigationMenu(location);
    if (menu) return menu;
    return this.getFallbackNavigation(location);
  }

  public async getAllNavigation() {
    const menus = await this.repository.findAllNavigationMenus();
    if (menus && menus.length > 0) return menus;
    return [
      this.getFallbackNavigation('header_main'),
      this.getFallbackNavigation('footer_engage'),
      this.getFallbackNavigation('footer_company'),
      this.getFallbackNavigation('footer_legal'),
    ].filter(Boolean);
  }

  public async getSiteSettings() {
    const settings = await this.repository.findAllSiteSettings();
    if (settings && settings.length > 0) {
      return settings.reduce((acc: any, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {});
    }
    return this.getFallbackSettings();
  }

  /**
   * Fast bootstrap endpoint returning all site essentials in 1 single HTTP request
   */
  public async getBootstrapConfig() {
    const [navigation, settings, testimonials] = await Promise.all([
      this.getAllNavigation(),
      this.getSiteSettings(),
      this.getTestimonials('homepage'),
    ]);

    return {
      navigation,
      settings,
      testimonials,
    };
  }

  // --- Admin Mutation Methods (With Immediate Cache Invalidation) ---

  public async listPages(status?: CmsPageStatus) {
    return this.repository.findAllPages(status);
  }

  public async savePage(input: CmsPageInput) {
    const page = await this.repository.upsertPage(input);

    if (input.sections && input.sections.length > 0) {
      for (const section of input.sections) {
        await this.repository.upsertSection(page.id, section);
      }
    }

    // Invalidate caches
    cmsCache.invalidateTag(`page:${input.slug}`);
    cmsCache.invalidateTag('pages');
    return this.repository.findPageBySlug(input.slug);
  }

  public async saveSection(slug: string, section: CmsSectionInput) {
    const page = await this.repository.findPageBySlug(slug);
    if (!page) throw new Error(`Page '${slug}' not found`);

    const updated = await this.repository.upsertSection(page.id, section);
    cmsCache.invalidateTag(`page:${slug}`);
    return updated;
  }

  public async publishPage(slug: string) {
    const published = await this.repository.publishPage(slug);
    cmsCache.invalidateTag(`page:${slug}`);
    cmsCache.invalidateTag('pages');
    return published;
  }

  public async deletePage(slug: string) {
    await this.repository.deletePage(slug);
    cmsCache.invalidateTag(`page:${slug}`);
    cmsCache.invalidateTag('pages');
    return { success: true };
  }

  public async saveTestimonial(id: string | null, input: CmsTestimonialInput) {
    const res = await this.repository.upsertTestimonial(id, input);
    cmsCache.invalidateTag('testimonials');
    return res;
  }

  public async deleteTestimonial(id: string) {
    await this.repository.deleteTestimonial(id);
    cmsCache.invalidateTag('testimonials');
    return { success: true };
  }

  public async saveFaq(id: string | null, input: CmsFaqInput) {
    const res = await this.repository.upsertFaq(id, input);
    cmsCache.invalidateTag('faqs');
    return res;
  }

  public async deleteFaq(id: string) {
    await this.repository.deleteFaq(id);
    cmsCache.invalidateTag('faqs');
    return { success: true };
  }

  public async saveNavigation(input: CmsNavigationMenuInput) {
    const res = await this.repository.upsertNavigationMenu(input);
    cmsCache.invalidateTag('navigation');
    return res;
  }

  public async saveSiteSetting(input: CmsSiteSettingInput) {
    const res = await this.repository.upsertSiteSetting(input);
    cmsCache.invalidateTag('settings');
    return res;
  }

  public purgeCache(tagOrKey?: string) {
    if (!tagOrKey || tagOrKey === 'all') {
      cmsCache.clear();
      return { purged: 'all' };
    }
    const purgedCount = cmsCache.invalidateTag(tagOrKey);
    cmsCache.invalidateKey(tagOrKey);
    return { tagOrKey, purgedCount };
  }

  // --- High-Fidelity Default Fallbacks matching current frontend exactly ---

  private getFallbackPage(slug: string) {
    if (slug === 'home') {
      return {
        id: 'seed-home',
        slug: 'home',
        title: 'Turn Pressure into Performance',
        status: 'PUBLISHED',
        version: 1,
        seoTitle: 'Turn Pressure into Performance | Leaders Performance',
        metaDescription:
          'Strategic support for successful founders and leadership teams preparing for greater pressure, consequential decisions and the next stage of performance.',
        keywords: [
          'founder pressure',
          'leadership diagnostics',
          'Dubai founder coach',
          'Lionel Eersteling',
          'RESET Blueprint',
        ],
        ogImage: '/assets/home/dubai-skyline-final-png0.webp',
        ogType: 'website',
        sections: [
          {
            sectionKey: 'hero',
            sectionType: 'HERO',
            order: 0,
            isEnabled: true,
            content: {
              eyebrow: 'For successful founders & leadership teams',
              headingLine1: 'Ambition creates',
              headingLine2: 'pressure.',
              headingLine3: 'Preparation turns it into',
              headingHighlight: 'performance.',
              subtext:
                'We work with successful founders and leadership teams preparing themselves and their organisations for the next level.',
              ctaText: 'Begin a Strategic Conversation',
              ctaLink: '/connect',
              backgroundImageUrl: '/assets/home/dubai-skyline-final-png0.webp',
            },
          },
          {
            sectionKey: 'the_next_level',
            sectionType: 'FEATURE_GRID',
            order: 1,
            isEnabled: true,
            content: {
              eyebrow: 'The Next Level',
              heading: 'Growth changes what performance requires.',
              paragraphs: [
                'Growth may mean entering a new market, attracting better-fit customers, increasing sales or strengthening profitability.',
                'Progress depends on aligning the founder, leadership team and organisation around the right priorities and executing them consistently.',
              ],
              items: [
                {
                  num: '01',
                  title: 'Founder Performance',
                  desc: 'Stay sharp, decisive and in control when the stakes are highest.',
                },
                {
                  num: '02',
                  title: 'Leadership Performance',
                  desc: 'Turn direction into clear ownership, aligned decisions and reliable execution.',
                },
                {
                  num: '03',
                  title: 'Organisational Performance',
                  desc: 'Build standards, rhythm and accountability that continue to hold as the company grows.',
                },
              ],
            },
          },
        ],
      };
    }
    return null;
  }

  private getFallbackTestimonials(category?: string) {
    return [
      {
        id: 'seed-test-1',
        name: 'Erling Haverkamp',
        role: 'CEO and Owner, Imatech BV',
        company: 'Imatech BV',
        avatarUrl: '/assets/common/erling.jpeg',
        shortText:
          'Working with Lionel had a direct impact on how we run the business. He has a sharp ability to quickly identify where money, time, and energy are being lost inside the company.',
        fullText: [
          'Working with Lionel had a direct impact on how we run the business.',
          'He has a sharp ability to quickly identify where money, time, and energy are being lost inside the company.',
          'What I appreciated most is that he focuses on execution. No long reports, no theory, just clear direction and immediate action.',
        ],
        category: 'homepage',
        order: 1,
        isFeatured: true,
        published: true,
      },
      {
        id: 'seed-test-2',
        name: 'Margot Willemstijn',
        role: 'Executive Director, Netherlands Business Council UAE',
        company: 'NBC UAE',
        avatarUrl: '/assets/common/margot.jpeg',
        shortText:
          'Lionel has a unique way of combining business insight with personal leadership. He helped me see patterns in my own behavior that were directly affecting the performance of my company.',
        fullText: [
          'Lionel has a unique way of combining business insight with personal leadership.',
          'He helped me see patterns in my own behavior that were directly affecting the performance of my company.',
          'What makes his approach different is that he doesn’t separate the business from the founder.',
        ],
        category: 'homepage',
        order: 2,
        isFeatured: true,
        published: true,
      },
    ];
  }

  private getFallbackFaqs(category?: string) {
    return [
      {
        id: 'seed-faq-1',
        question: 'Who is the Founder Pressure Scan designed for?',
        answer:
          'The scan is specifically designed for active founders and executive owners leading scaling businesses facing high decision loads.',
        category: category || 'general',
        order: 1,
        published: true,
      },
    ];
  }

  private getFallbackNavigation(location: string) {
    if (location === 'header_main') {
      return {
        id: 'nav-header-main',
        location: 'header_main',
        title: 'Main Navigation',
        items: [
          { label: 'Performance', href: '/', isExternal: false, order: 0 },
          { label: 'UNMASKED', href: '/unmasked', isExternal: false, order: 1 },
          { label: 'The Round Table', href: '/roundtables', isExternal: false, order: 2 },
          { label: 'Knowledge', href: '/knowledge', isExternal: false, order: 3 },
          { label: 'Meet Lionel', href: '/meetlionel', isExternal: false, order: 4 },
        ],
      };
    }
    if (location === 'footer_engage') {
      return {
        id: 'nav-footer-engage',
        location: 'footer_engage',
        title: 'Engage',
        items: [
          { label: 'Performance', href: '/', isExternal: false, order: 0 },
          { label: 'UNMASKED', href: '/unmasked', isExternal: false, order: 1 },
          { label: "The Founder's Next Move", href: '/masterclass', isExternal: false, order: 2 },
          { label: 'The Round Table', href: '/roundtables', isExternal: false, order: 3 },
          { label: 'Founder Pressure Scan', href: '/diagnostics', isExternal: false, order: 4 },
          { label: 'Begin a Strategic Conversation', href: '/connect', isExternal: false, order: 5 },
        ],
      };
    }
    return null;
  }

  private getFallbackSettings() {
    return {
      branding: {
        siteName: 'Leaders Performance',
        domain: 'https://leadersperformance.ae',
      },
      socials: {
        youtube: 'https://www.youtube.com/@lioneleersteling',
        tiktok: 'https://www.tiktok.com/@lioneleersteling',
        linkedin: 'https://www.linkedin.com/in/lionel-eersteling/',
        x: 'https://x.com/LionelEerstelng',
      },
    };
  }
}

export const cmsService = new CmsService();

