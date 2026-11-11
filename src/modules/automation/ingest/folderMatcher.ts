import { Platform, PublishMode } from '@prisma/client';
import { normalizeFileNameNfc } from '../storage/storage.service';
import { normalizeTextForKey } from './calendarParser';

export interface ResolvedChannelInfo {
  known: boolean;
  platform: Platform;
  mode: PublishMode;
  accountId: string | null;
  normalizedAlias: string;
}

export interface FolderRuleConfig {
  drivePath: string; // e.g. "01_Linkedin/01_Quotes"
  platform: Platform;
  postKind: string;
  contentTypeAliases: string[];
  mode: PublishMode;
  expectedFiles: string;
}

export const DEFAULT_FOLDER_RULES: FolderRuleConfig[] = [
  {
    drivePath: '01_Linkedin/01_Quotes',
    platform: 'LINKEDIN',
    postKind: 'Image',
    contentTypeAliases: ['quote', 'quotes', 'quote image', 'quote post', 'citaten', 'quote fps', 'quote pls', 'quote profit leak scan', 'quote founder pressure scan'],
    mode: 'AUTO',
    expectedFiles: '1 image + caption',
  },
  {
    drivePath: '01_Linkedin/02_Poster',
    platform: 'LINKEDIN',
    postKind: 'Image',
    contentTypeAliases: ['poster', 'posters', 'image', 'single image', 'photo', 'infographic', 'carousel', 'carousels', 'avatar picture / photo', 'avatar picture', 'avatar photo'],
    mode: 'AUTO',
    expectedFiles: '1 image + caption',
  },
  {
    drivePath: '01_Linkedin/03_Video',
    platform: 'LINKEDIN',
    postKind: 'Video',
    contentTypeAliases: ['video', 'videos', 'reel', 'short', 'clip'],
    mode: 'AUTO',
    expectedFiles: '1 video + caption',
  },
  {
    drivePath: '01_Linkedin/04_Newsletter_Article',
    platform: 'LINKEDIN_NEWSLETTER',
    postKind: 'Article',
    contentTypeAliases: ['newsletter', 'article', 'newsletter article', 'linkedin newsletter', 'linkedin article', 'linkedin article post', 'article post'],
    mode: 'MANUAL',
    expectedFiles: 'article .docx + cover image',
  },
  {
    drivePath: '02_Instagram/01_Video',
    platform: 'INSTAGRAM',
    postKind: 'Reel',
    contentTypeAliases: ['video', 'videos', 'reel', 'reels', 'short', 'ig reel', 'video (script chloë)', 'video script chloë', 'video script'],
    mode: 'AUTO',
    expectedFiles: '1 video + caption',
  },
  {
    drivePath: '02_Instagram/02_Photo',
    platform: 'INSTAGRAM',
    postKind: 'Image',
    contentTypeAliases: ['photo', 'photos', 'image', 'single image', 'quote', 'quotes', 'quote fps', 'quote pls', 'poster', 'posters', 'carousel', 'carousels', 'avatar picture / photo', 'avatar picture', 'avatar photo'],
    mode: 'AUTO',
    expectedFiles: '1 image, or 2-10 images sorted by file name + caption',
  },
  {
    drivePath: '03_Youtube',
    platform: 'YOUTUBE',
    postKind: 'Video',
    contentTypeAliases: ['video', 'videos', 'youtube', 'long form', 'short', 'shorts', 'episode'],
    mode: 'AUTO',
    expectedFiles: '1 video + caption + optional Thumbnail.png/.jpg',
  },
  {
    drivePath: '04_Tiktok',
    platform: 'TIKTOK',
    postKind: 'Video',
    contentTypeAliases: ['video', 'videos', 'tiktok', 'short', 'reel', 'dutch tiktok', 'dutch video', 'dutch video from the series'],
    mode: 'AUTO',
    expectedFiles: '1 video (.mov/.mp4) + caption',
  },
];

const BUILTIN_CHANNEL_ALIASES: Record<
  string,
  { platform: Platform; mode: PublishMode }
> = {
  linkedin: { platform: 'LINKEDIN', mode: 'AUTO' },
  li: { platform: 'LINKEDIN', mode: 'AUTO' },
  'linkedin personal': { platform: 'LINKEDIN', mode: 'AUTO' },
  'linkedin lionel': { platform: 'LINKEDIN', mode: 'AUTO' },
  'linkedin company': { platform: 'LINKEDIN', mode: 'AUTO' },
  'linkedin business': { platform: 'LINKEDIN', mode: 'AUTO' },
  'linkedin page': { platform: 'LINKEDIN', mode: 'AUTO' },
  'leaders performance linkedin': { platform: 'LINKEDIN', mode: 'AUTO' },
  'linkedin newsletter': { platform: 'LINKEDIN_NEWSLETTER', mode: 'MANUAL' },
  newsletter: { platform: 'LINKEDIN_NEWSLETTER', mode: 'MANUAL' },
  'linkedin article': { platform: 'LINKEDIN_NEWSLETTER', mode: 'MANUAL' },
  instagram: { platform: 'INSTAGRAM', mode: 'AUTO' },
  ig: { platform: 'INSTAGRAM', mode: 'AUTO' },
  insta: { platform: 'INSTAGRAM', mode: 'AUTO' },
  youtube: { platform: 'YOUTUBE', mode: 'AUTO' },
  yt: { platform: 'YOUTUBE', mode: 'AUTO' },
  'youtube video': { platform: 'YOUTUBE', mode: 'AUTO' },
  'youtube shorts': { platform: 'YOUTUBE', mode: 'AUTO' },
  'youtube account': { platform: 'YOUTUBE', mode: 'AUTO' },
  'youtube dutch account': { platform: 'YOUTUBE', mode: 'AUTO' },
  tiktok: { platform: 'TIKTOK', mode: 'AUTO' },
  'tiktok nl': { platform: 'TIKTOK', mode: 'AUTO' },
  'dutch tiktok': { platform: 'TIKTOK', mode: 'AUTO' },
  'tiktok dutch': { platform: 'TIKTOK', mode: 'AUTO' },
  'tiktok dutch account': { platform: 'TIKTOK', mode: 'AUTO' },
  tt: { platform: 'TIKTOK', mode: 'AUTO' },
  medium: { platform: 'MEDIUM', mode: 'MANUAL' },
  inspo: { platform: 'INSPO', mode: 'MANUAL' },
  'inspo account': { platform: 'INSPO', mode: 'MANUAL' },
  website: { platform: 'WEBSITE', mode: 'MANUAL' },
  blog: { platform: 'WEBSITE', mode: 'MANUAL' },
  cms: { platform: 'WEBSITE', mode: 'MANUAL' },
  x: { platform: 'X', mode: 'MANUAL' },
  twitter: { platform: 'X', mode: 'MANUAL' },
};

/**
 * Resolves a calendar channel token (and optional contentType such as "Newsletter")
 * into a Platform, PublishMode, and optional SocialAccount ID.
 * If unknown, returns `known: false` (Edge Case #8).
 */
export function resolveChannelAlias(
  channelToken: string,
  contentType?: string | null,
  dbAliases: Array<{
    alias: string;
    platform: Platform;
    accountId: string | null;
    mode: PublishMode;
  }> = [],
  activeAccounts: Array<{
    id: string;
    platform: Platform;
    label: string;
  }> = []
): ResolvedChannelInfo {
  const normalizedAlias = normalizeTextForKey(channelToken);
  const normalizedType = normalizeTextForKey(contentType);

  // Check DB ChannelAlias overrides first
  const dbMatch = dbAliases.find(
    (a) => normalizeTextForKey(a.alias) === normalizedAlias
  );
  if (dbMatch) {
    return {
      known: true,
      platform: dbMatch.platform,
      mode: dbMatch.mode,
      accountId: dbMatch.accountId,
      normalizedAlias,
    };
  }

  // Special case: LinkedIn + Newsletter/Article in column D -> LINKEDIN_NEWSLETTER (MANUAL)
  if (
    (normalizedAlias.includes('linkedin') || normalizedAlias === 'li') &&
    (normalizedType.includes('newsletter') || normalizedType.includes('article'))
  ) {
    return {
      known: true,
      platform: 'LINKEDIN_NEWSLETTER',
      mode: 'MANUAL',
      accountId: null,
      normalizedAlias,
    };
  }

  const builtin = BUILTIN_CHANNEL_ALIASES[normalizedAlias];
  if (builtin) {
    const matchedAccount = activeAccounts.find((a) => a.platform === builtin.platform);
    return {
      known: true,
      platform: builtin.platform,
      mode: builtin.mode,
      accountId: builtin.mode === 'AUTO' ? matchedAccount?.id ?? null : null,
      normalizedAlias,
    };
  }

  return {
    known: false,
    platform: 'WEBSITE',
    mode: 'MANUAL',
    accountId: null,
    normalizedAlias,
  };
}

/**
 * Resolves the expected Drive path under `07_Social_media` for a given platform, contentType, and date.
 * Returns null for manual channels that do not use a Drive folder (MEDIUM, INSPO, WEBSITE, X).
 */
export function resolveExpectedDrivePath(params: {
  platform: Platform;
  contentType?: string | null;
  dateYmd: string;
  folderRules?: FolderRuleConfig[];
  socialRootName?: string;
}): {
  requiresDriveFolder: boolean;
  drivePath: string | null;
  rule: FolderRuleConfig | null;
  blockedReason?: string;
} {
  const socialRoot = (params.socialRootName || process.env.SOCIAL_FOLDER_NAME || '07_Social_media').replace(/\/+$/, '');
  const rules = params.folderRules && params.folderRules.length > 0 ? params.folderRules : DEFAULT_FOLDER_RULES;
  const normType = normalizeTextForKey(params.contentType);

  // Manual channels without a Drive folder in 07_Social_media
  if (
    params.platform === 'MEDIUM' ||
    params.platform === 'INSPO' ||
    params.platform === 'WEBSITE' ||
    params.platform === 'X'
  ) {
    return { requiresDriveFolder: false, drivePath: null, rule: null };
  }

  const platformRules = rules.filter((r) => r.platform === params.platform);
  if (platformRules.length === 0) {
    return {
      requiresDriveFolder: false,
      drivePath: null,
      rule: null,
    };
  }

  // YouTube and TikTok have a single folder level (no type subfolder)
  if (params.platform === 'YOUTUBE' || params.platform === 'TIKTOK' || params.platform === 'LINKEDIN_NEWSLETTER') {
    const rule = platformRules[0];
    return {
      requiresDriveFolder: true,
      drivePath: `${socialRoot}/${rule.drivePath}/${params.dateYmd}`,
      rule,
    };
  }

  // Match contentType against rule contentTypeAliases
  if (normType) {
    const exactMatch = platformRules.find((r) =>
      r.contentTypeAliases.some((a) => normalizeTextForKey(a) === normType)
    );
    if (exactMatch) {
      return {
        requiresDriveFolder: true,
        drivePath: `${socialRoot}/${exactMatch.drivePath}/${params.dateYmd}`,
        rule: exactMatch,
      };
    }

    const partialMatch = platformRules.find((r) =>
      r.contentTypeAliases.some(
        (a) =>
          normType.includes(normalizeTextForKey(a)) ||
          normalizeTextForKey(a).includes(normType)
      )
    );
    if (partialMatch) {
      return {
        requiresDriveFolder: true,
        drivePath: `${socialRoot}/${partialMatch.drivePath}/${params.dateYmd}`,
        rule: partialMatch,
      };
    }
  }

  // Fallback for LinkedIn / Instagram when type is missing or unrecognised:
  return {
    requiresDriveFolder: true,
    drivePath: null,
    rule: null,
    blockedReason: `UNKNOWN_CONTENT_TYPE: Cannot map type "${params.contentType || '(empty)'}" for platform ${params.platform}`,
  };
}

export interface DriveFileInput {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: number | string;
  modifiedTime?: string;
  parents?: string[];
}

export interface DriveSubfolderInput {
  id: string;
  name: string;
  files: DriveFileInput[];
}

export interface MatchedAssetCandidate {
  driveFileId: string;
  fileName: string;
  mimeType: string;
  checksumMd5: string;
  sizeBytes: number;
  role: 'MAIN' | 'THUMBNAIL' | 'COVER' | 'CAPTION_SOURCE';
  position: number;
}

export interface FolderMatchResult {
  matched: boolean;
  blockedReason?: string;
  candidates?: Array<{ id: string; name: string; mimeType: string }>;
  selectedAssets: MatchedAssetCandidate[];
  mediaType?: 'IMAGE' | 'REELS' | 'CAROUSEL' | 'VIDEO' | 'ARTICLE';
  missingCaptionDocx: boolean;
}

function classifyDriveFile(file: DriveFileInput): 'VIDEO' | 'IMAGE' | 'DOCX' | 'OTHER' {
  const mime = (file.mimeType || '').toLowerCase();
  const name = normalizeFileNameNfc(file.name || '').toLowerCase();

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.google-apps.document' ||
    name.endsWith('.docx')
  ) {
    return 'DOCX';
  }
  if (mime.startsWith('video/') || name.endsWith('.mp4') || name.endsWith('.mov')) {
    return 'VIDEO';
  }
  if (
    mime.startsWith('image/') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.webp')
  ) {
    return 'IMAGE';
  }
  return 'OTHER';
}

function toAssetCandidate(
  file: DriveFileInput,
  role: MatchedAssetCandidate['role'],
  position: number
): MatchedAssetCandidate {
  const normalizedName = normalizeFileNameNfc(file.name);
  const checksumMd5 =
    (file.md5Checksum && file.md5Checksum.trim()) ||
    `drive-${file.id}-${file.modifiedTime || 'v1'}`;
  const sizeBytes = Number(file.size || 0);
  return {
    driveFileId: file.id,
    fileName: normalizedName,
    mimeType: file.mimeType || 'application/octet-stream',
    checksumMd5,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    role,
    position,
  };
}

/**
 * Normalises a file stem (without extension) for subject matching (Plan Section 4 Rule 4 & 7).
 */
function normalizeFileStemForMatch(fileName: string): string {
  const noExt = normalizeFileNameNfc(fileName).replace(/\.[a-z0-9]{2,5}$/i, '');
  return normalizeTextForKey(noExt);
}

/**
 * Evaluates all 11 Folder Matching Rules from Plan Section 4 against a Drive folder listing.
 */
export function matchDriveFolderListing(params: {
  platform: Platform;
  contentType?: string | null;
  subject?: string | null;
  drivePath: string;
  folderFound: boolean;
  files: DriveFileInput[];
  subfolders?: DriveSubfolderInput[];
}): FolderMatchResult {
  // Rule 2: Date folder missing -> BLOCKED "folder missing"
  if (!params.folderFound) {
    return {
      matched: false,
      blockedReason: `folder missing: ${params.drivePath}`,
      selectedAssets: [],
      missingCaptionDocx: true,
    };
  }

  const files = params.files || [];
  const subfolders = params.subfolders || [];

  if (files.length === 0 && subfolders.length === 0) {
    return {
      matched: false,
      blockedReason: `folder empty: ${params.drivePath}`,
      selectedAssets: [],
      missingCaptionDocx: true,
    };
  }

  // Rule 3 & 5: Classify files in the date folder
  const docxFiles = files.filter((f) => classifyDriveFile(f) === 'DOCX');
  const videoFiles = files.filter((f) => classifyDriveFile(f) === 'VIDEO');
  const imageFiles = files.filter((f) => classifyDriveFile(f) === 'IMAGE');

  // Rule 5: Caption .docx selection
  let selectedDocx: DriveFileInput | null = null;
  if (docxFiles.length === 1) {
    selectedDocx = docxFiles[0];
  } else if (docxFiles.length > 1) {
    const captionNamed = docxFiles.filter((f) =>
      normalizeFileNameNfc(f.name).toLowerCase().startsWith('caption')
    );
    if (captionNamed.length === 1) {
      selectedDocx = captionNamed[0];
    } else if (params.subject) {
      const normSubject = normalizeTextForKey(params.subject);
      const subjectMatched = docxFiles.filter((f) =>
        normalizeFileStemForMatch(f.name).includes(normSubject)
      );
      if (subjectMatched.length === 1) {
        selectedDocx = subjectMatched[0];
      }
    }
    if (!selectedDocx) {
      return {
        matched: false,
        blockedReason: `ambiguous caption: found ${docxFiles.length} .docx files in ${params.drivePath}`,
        candidates: docxFiles.map((f) => ({ id: f.id, name: normalizeFileNameNfc(f.name), mimeType: f.mimeType })),
        selectedAssets: [],
        missingCaptionDocx: false,
      };
    }
  }

  const selectedAssets: MatchedAssetCandidate[] = [];

  // Special case: LinkedIn Newsletter Article (`01_Linkedin/04_Newsletter_Article/{date}`)
  if (params.platform === 'LINKEDIN_NEWSLETTER') {
    if (!selectedDocx) {
      return {
        matched: false,
        blockedReason: `missing article .docx in ${params.drivePath}`,
        selectedAssets: [],
        missingCaptionDocx: true,
      };
    }
    selectedAssets.push(toAssetCandidate(selectedDocx, 'CAPTION_SOURCE', 0));
    if (imageFiles.length === 1) {
      selectedAssets.push(toAssetCandidate(imageFiles[0], 'COVER', 0));
    } else if (imageFiles.length > 1) {
      return {
        matched: false,
        blockedReason: `ambiguous cover image in ${params.drivePath}`,
        candidates: imageFiles.map((f) => ({ id: f.id, name: normalizeFileNameNfc(f.name), mimeType: f.mimeType })),
        selectedAssets: [],
        missingCaptionDocx: false,
      };
    }
    return {
      matched: true,
      selectedAssets,
      mediaType: 'ARTICLE',
      missingCaptionDocx: false,
    };
  }

  // Check for carousel subfolder (Rule 3 & 4: e.g. `02_Instagram/02_Photo/{date}/01_Carousels`)
  const imageSubfolders = subfolders
    .map((sf) => ({
      ...sf,
      images: (sf.files || []).filter((f) => classifyDriveFile(f) === 'IMAGE'),
    }))
    .filter((sf) => sf.images.length > 0);

  if (imageSubfolders.length > 1) {
    return {
      matched: false,
      blockedReason: `ambiguous carousel subfolders in ${params.drivePath}`,
      selectedAssets: [],
      missingCaptionDocx: !selectedDocx,
    };
  }

  if (imageSubfolders.length === 1) {
    const sortedSlides = [...imageSubfolders[0].images].sort((a, b) =>
      normalizeFileNameNfc(a.name).localeCompare(normalizeFileNameNfc(b.name), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    );

    // Edge Case #15: Carousel with more images than platform allows (max 10 on Instagram, 20 on LinkedIn)
    const maxSlides = params.platform === 'INSTAGRAM' ? 10 : 20;
    if (sortedSlides.length > maxSlides) {
      return {
        matched: false,
        blockedReason: `carousel limit exceeded: found ${sortedSlides.length} images in ${imageSubfolders[0].name} (max ${maxSlides} for ${params.platform})`,
        selectedAssets: [],
        missingCaptionDocx: !selectedDocx,
      };
    }
    if (sortedSlides.length < 2) {
      return {
        matched: false,
        blockedReason: `carousel subfolder ${imageSubfolders[0].name} must contain at least 2 images`,
        selectedAssets: [],
        missingCaptionDocx: !selectedDocx,
      };
    }

    sortedSlides.forEach((img, idx) => {
      selectedAssets.push(toAssetCandidate(img, 'MAIN', idx));
    });
    if (selectedDocx) {
      selectedAssets.push(toAssetCandidate(selectedDocx, 'CAPTION_SOURCE', 0));
    }

    return {
      matched: true,
      selectedAssets,
      mediaType: 'CAROUSEL',
      missingCaptionDocx: !selectedDocx,
    };
  }

  // Separate YouTube Thumbnail images (Rule 3: name starts with "thumbnail" on YouTube)
  const thumbnailFiles =
    params.platform === 'YOUTUBE'
      ? imageFiles.filter((f) =>
          normalizeFileNameNfc(f.name).toLowerCase().startsWith('thumbnail')
        )
      : [];
  const nonThumbnailImages =
    params.platform === 'YOUTUBE'
      ? imageFiles.filter(
          (f) => !normalizeFileNameNfc(f.name).toLowerCase().startsWith('thumbnail')
        )
      : imageFiles;

  // Candidate main media files
  const candidateMedia: DriveFileInput[] =
    params.platform === 'YOUTUBE' || params.platform === 'TIKTOK'
      ? videoFiles
      : [...videoFiles, ...nonThumbnailImages];

  if (candidateMedia.length === 0) {
    return {
      matched: false,
      blockedReason: `no usable media found in ${params.drivePath}`,
      selectedAssets: [],
      missingCaptionDocx: !selectedDocx,
    };
  }

  let chosenMain: DriveFileInput | null = null;
  if (candidateMedia.length === 1) {
    chosenMain = candidateMedia[0];
  } else {
    // Rule 4: Several media files in one date folder -> pick the one whose normalised name contains column E's subject
    const normSubject = normalizeTextForKey(params.subject);
    if (normSubject) {
      const matches = candidateMedia.filter((f) => {
        const stem = normalizeFileStemForMatch(f.name);
        return stem.includes(normSubject) || normSubject.includes(stem);
      });
      if (matches.length === 1) {
        chosenMain = matches[0];
      }
    }

    if (!chosenMain) {
      return {
        matched: false,
        blockedReason: `ambiguous: ${candidateMedia.length} media files in ${params.drivePath} match or cannot be disambiguated by subject "${params.subject || ''}"`,
        candidates: candidateMedia.map((f) => ({
          id: f.id,
          name: normalizeFileNameNfc(f.name),
          mimeType: f.mimeType,
        })),
        selectedAssets: [],
        missingCaptionDocx: !selectedDocx,
      };
    }
  }

  const mainKind = classifyDriveFile(chosenMain);
  selectedAssets.push(toAssetCandidate(chosenMain, 'MAIN', 0));

  if (thumbnailFiles.length > 0) {
    selectedAssets.push(toAssetCandidate(thumbnailFiles[0], 'THUMBNAIL', 0));
  }

  if (selectedDocx) {
    selectedAssets.push(toAssetCandidate(selectedDocx, 'CAPTION_SOURCE', 0));
  }

  const mediaType =
    mainKind === 'VIDEO'
      ? params.platform === 'INSTAGRAM'
        ? 'REELS'
        : 'VIDEO'
      : 'IMAGE';

  return {
    matched: true,
    selectedAssets,
    mediaType,
    missingCaptionDocx: !selectedDocx,
  };
}

