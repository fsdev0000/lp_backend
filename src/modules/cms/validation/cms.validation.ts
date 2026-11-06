import { z } from 'zod';

export const CmsPageStatusEnum = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export const CmsSectionInputSchema = z.object({
  sectionKey: z.string().min(1).max(100),
  sectionType: z.string().min(1).max(50),
  order: z.number().int().default(0),
  isEnabled: z.boolean().default(true),
  content: z.record(z.string(), z.any()), // arbitrary JSON matching section component props
});

export const CmsPageInputSchema = z.object({
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-_]+$/, 'Slug must be alphanumeric, hyphen or underscore'),
  title: z.string().min(1).max(255),
  description: z.string().optional().nullable(),
  status: CmsPageStatusEnum.optional(), // Keep existing status if not provided (Fix 2c)
  seoTitle: z.string().max(150).optional().nullable(),
  metaDescription: z.string().max(300).optional().nullable(),
  keywords: z.array(z.string()).default([]),
  ogImage: z.string().url().or(z.string().startsWith('/')).optional().nullable(),
  ogType: z.string().default('website'),
  canonicalUrl: z.string().url().optional().nullable(),
  schemaJson: z.record(z.string(), z.any()).optional().nullable(),
  sections: z.array(CmsSectionInputSchema).optional(),
});

export const CmsTestimonialInputSchema = z.object({
  name: z.string().min(1).max(150),
  role: z.string().min(1).max(255),
  company: z.string().max(150).optional().nullable(),
  avatarUrl: z.string().min(1),
  shortText: z.string().min(1),
  fullText: z.array(z.string()).min(1),
  category: z.string().default('homepage'),
  order: z.number().int().default(0),
  isFeatured: z.boolean().default(false),
  published: z.boolean().default(true),
});

export const CmsFaqInputSchema = z.object({
  question: z.string().min(1).max(300),
  answer: z.string().min(1),
  category: z.string().default('general'),
  order: z.number().int().default(0),
  published: z.boolean().default(true),
});

export const CmsNavigationItemSchema = z.object({
  label: z.string().min(1).max(100),
  href: z.string().min(1),
  isExternal: z.boolean().default(false),
  order: z.number().int().default(0),
  target: z.string().optional(),
});

export const CmsNavigationMenuInputSchema = z.object({
  location: z.string().min(1).max(50), // e.g. "header_main", "footer_engage"
  title: z.string().min(1).max(100),
  items: z.array(CmsNavigationItemSchema),
});

export const CmsSiteSettingInputSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.record(z.string(), z.any()),
});

// ============================================================================
// CMS TEXTS VALIDATION (Section 4)
// ============================================================================

export const CmsTextInputSchema = z.object({
  key: z
    .string()
    .min(1, 'Key is required')
    .max(200, 'Key must not exceed 200 characters')
    .regex(/^[A-Za-z0-9_.-]+$/, 'Key must only contain letters, numbers, dots, hyphens, and underscores'),
  locale: z.literal('en', {
    message: 'Only "en" locale is supported at this time.',
  }).default('en'),
  value: z
    .string()
    .max(5000, 'Text value must be at most 5,000 characters')
    .nullable(),
});

export const CmsTextDiscardSchema = z.object({
  keys: z.array(z.string().min(1).max(200)).min(1, 'At least one key is required to discard drafts'),
});

export const CmsTextPublishSchema = z.object({
  keys: z.array(z.string().min(1).max(200)).optional(),
});

export type CmsPageInput = z.infer<typeof CmsPageInputSchema>;
export type CmsSectionInput = z.infer<typeof CmsSectionInputSchema>;
export type CmsTestimonialInput = z.infer<typeof CmsTestimonialInputSchema>;
export type CmsFaqInput = z.infer<typeof CmsFaqInputSchema>;
export type CmsNavigationMenuInput = z.infer<typeof CmsNavigationMenuInputSchema>;
export type CmsSiteSettingInput = z.infer<typeof CmsSiteSettingInputSchema>;
export type CmsTextInput = z.infer<typeof CmsTextInputSchema>;
export type CmsTextDiscardInput = z.infer<typeof CmsTextDiscardSchema>;
export type CmsTextPublishInput = z.infer<typeof CmsTextPublishSchema>;
