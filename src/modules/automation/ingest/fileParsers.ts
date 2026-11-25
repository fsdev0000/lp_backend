import zlib from 'zlib';

/**
 * Zero-dependency ZIP entry reader using Node's built-in zlib.
 * Used to parse .docx (Word) and .xlsx (Excel) files without native binary dependencies.
 */
export function readZipEntries(buf: Buffer): Record<string, Buffer> {
  const entries: Record<string, Buffer> = {};
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP archive (EOCD signature not found)');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const fileName = buf.subarray(pos + 46, pos + 46 + fileNameLen).toString('utf8');

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = buf.subarray(dataStart, dataStart + compressedSize);
    const content = compression === 0 ? rawData : zlib.inflateRawSync(rawData);
    entries[fileName] = content;

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

export function decodeXmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Extracts plain text from a .docx buffer (Plan Section 4 Rule 6).
 * Preserves paragraph breaks, inline line breaks (<w:br/>), and tabs.
 */
export function extractDocxText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const docXmlBuf = entries['word/document.xml'];
  if (!docXmlBuf) {
    throw new Error('Invalid .docx file: word/document.xml is missing');
  }
  const docXml = docXmlBuf.toString('utf8');
  const pMatches = docXml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [];
  const paragraphs: string[] = [];

  for (const p of pMatches) {
    const tokens =
      p.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>/g) || [];
    let pText = '';
    for (const tok of tokens) {
      if (tok.startsWith('<w:br')) {
        pText += '\n';
      } else if (tok.startsWith('<w:tab')) {
        pText += '\t';
      } else {
        const inner = tok.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, '');
        pText += decodeXmlEntities(inner);
      }
    }
    if (pText.trim().length > 0) {
      paragraphs.push(pText.trim());
    }
  }

  return paragraphs.join('\n\n');
}

export interface ParsedXlsxSheet {
  name: string;
  rows: Array<{
    rowNumber: number;
    cells: Array<string | number | null>;
  }>;
}

function colLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/**
 * Parses an .xlsx buffer into sheets and unformatted cell rows (Plan Section 6 Flow 1 Step 1-2).
 */
export function parseXlsxBuffer(buf: Buffer): ParsedXlsxSheet[] {
  const entries = readZipEntries(buf);
  const sharedStrings: string[] = [];

  if (entries['xl/sharedStrings.xml']) {
    const ssXml = entries['xl/sharedStrings.xml'].toString('utf8');
    const siMatches = ssXml.match(/<si[\s>][\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tMatches = si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
      const text = tMatches
        .map((t) => decodeXmlEntities(t.replace(/^<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, '')))
        .join('');
      sharedStrings.push(text);
    }
  }

  const wbXml = entries['xl/workbook.xml']?.toString('utf8') || '';
  const relsXml = entries['xl/_rels/workbook.xml.rels']?.toString('utf8') || '';

  const relMap: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g)) {
    relMap[m[1]] = m[2].replace(/^\//, '');
  }
  // Handle reversed attribute order (Target before Id)
  for (const m of relsXml.matchAll(/<Relationship[^>]+Target="([^"]+)"[^>]+Id="([^"]+)"/g)) {
    relMap[m[2]] = m[1].replace(/^\//, '');
  }

  const sheets: ParsedXlsxSheet[] = [];
  for (const m of wbXml.matchAll(/<sheet\s+([^>]+)\/?>/g)) {
    const attrs = m[1];
    const nameMatch = attrs.match(/\bname="([^"]+)"/);
    const rIdMatch = attrs.match(/\br:id="([^"]+)"/);
    if (!nameMatch || !rIdMatch) continue;
    const sheetName = decodeXmlEntities(nameMatch[1]);
    const target = relMap[rIdMatch[1]];
    if (!target) continue;
    const fullPath = target.startsWith('xl/') ? target : `xl/${target}`;
    const sheetBuf = entries[fullPath];
    if (!sheetBuf) continue;

    const xml = sheetBuf.toString('utf8');
    const rowMatches = xml.match(/<row[\s>][\s\S]*?<\/row>/g) || [];
    const parsedRows: ParsedXlsxSheet['rows'] = [];

    for (const rowXml of rowMatches) {
      const rAttr = rowXml.match(/\br="(\d+)"/);
      const rowNumber = rAttr ? Number(rAttr[1]) : parsedRows.length + 1;
      const cells: Array<string | number | null> = [];
      const cMatches = rowXml.match(/<c[\s>][\s\S]*?(?:<\/c>|\/>)/g) || [];

      for (const cXml of cMatches) {
        const refMatch = cXml.match(/\br="([A-Z]+)\d+"/);
        const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : cells.length;
        const typeMatch = cXml.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : 'n';
        const vMatch = cXml.match(/<v>([\s\S]*?)<\/v>/);
        const isMatch = cXml.match(/<is>[\s\S]*?<\/is>/);

        let val: string | number | null = null;
        if (cellType === 's' && vMatch) {
          val = sharedStrings[Number(vMatch[1])] ?? '';
        } else if (cellType === 'inlineStr' && isMatch) {
          const tMatches = isMatch[0].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
          val = tMatches
            .map((t) =>
              decodeXmlEntities(t.replace(/^<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, ''))
            )
            .join('');
        } else if (cellType === 'str' && vMatch) {
          val = decodeXmlEntities(vMatch[1]);
        } else if (vMatch) {
          const raw = decodeXmlEntities(vMatch[1]).trim();
          const num = Number(raw);
          val = Number.isFinite(num) && raw !== '' ? num : raw;
        }
        cells[colIdx] = val;
      }

      parsedRows.push({ rowNumber, cells });
    }

    sheets.push({ name: sheetName, rows: parsedRows });
  }

  return sheets;
}

export interface MediaProbeResult {
  width?: number;
  height?: number;
  durationSec?: number;
  container?: string;
  valid: boolean;
  invalidReason?: string;
}

/**
 * Lightweight binary header prober for PNG, JPEG, and MP4/MOV (`mvhd`/`tkhd` atoms),
 * plus platform constraint validation (Edge Case #14).
 */
export function probeMediaBuffer(
  buf: Buffer,
  mimeType: string,
  fileName: string
): MediaProbeResult {
  const lowerMime = (mimeType || '').toLowerCase();
  const lowerName = (fileName || '').toLowerCase();

  // 1. PNG header check
  if (lowerMime.includes('png') || lowerName.endsWith('.png')) {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height, container: 'png', valid: true };
    }
    return { container: 'png', valid: true };
  }

  // 2. JPEG SOF0/SOF2 header check
  if (
    lowerMime.includes('jpeg') ||
    lowerMime.includes('jpg') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg')
  ) {
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        if (
          marker === 0xc0 ||
          marker === 0xc1 ||
          marker === 0xc2 ||
          marker === 0xc3
        ) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          return { width, height, container: 'jpeg', valid: true };
        }
        if (marker === 0xd9 || marker === 0xda) break;
        const segLen = buf.readUInt16BE(offset + 2);
        if (segLen < 2) break;
        offset += 2 + segLen;
      }
    }
    return { container: 'jpeg', valid: true };
  }

  // 3. MP4 / MOV ISO BMFF atom scanner for mvhd (duration) and tkhd (width/height)
  if (
    lowerMime.startsWith('video/') ||
    lowerName.endsWith('.mp4') ||
    lowerName.endsWith('.mov')
  ) {
    const container = lowerName.endsWith('.mov') ? 'mov' : 'mp4';
    let durationSec: number | undefined;
    let width: number | undefined;
    let height: number | undefined;

    const mvhdIdx = buf.indexOf(Buffer.from('mvhd'));
    if (mvhdIdx !== -1 && mvhdIdx + 24 <= buf.length) {
      const version = buf[mvhdIdx + 4];
      if (version === 0 && mvhdIdx + 24 <= buf.length) {
        const timescale = buf.readUInt32BE(mvhdIdx + 16);
        const duration = buf.readUInt32BE(mvhdIdx + 20);
        if (timescale > 0) durationSec = Number((duration / timescale).toFixed(2));
      } else if (version === 1 && mvhdIdx + 32 <= buf.length) {
        const timescale = buf.readUInt32BE(mvhdIdx + 24);
        const durationHigh = buf.readUInt32BE(mvhdIdx + 28);
        const durationLow = buf.readUInt32BE(mvhdIdx + 32);
        const duration = durationHigh * 0x100000000 + durationLow;
        if (timescale > 0) durationSec = Number((duration / timescale).toFixed(2));
      }
    }

    let searchStart = 0;
    while (searchStart < buf.length) {
      const tkhdIdx = buf.indexOf(Buffer.from('tkhd'), searchStart);
      if (tkhdIdx === -1) break;
      const version = buf[tkhdIdx + 4];
      const dimsOffset = version === 1 ? tkhdIdx + 92 : tkhdIdx + 80;
      if (dimsOffset + 8 <= buf.length) {
        const w = buf.readUInt32BE(dimsOffset) >>> 16;
        const h = buf.readUInt32BE(dimsOffset + 4) >>> 16;
        if (w > 0 && h > 0) {
          width = w;
          height = h;
          break;
        }
      }
      searchStart = tkhdIdx + 4;
    }

    return {
      width,
      height,
      durationSec,
      container,
      valid: true,
    };
  }

  return { valid: true };
}

/**
 * Validates media metadata (size, duration, dimensions, mimeType) against platform rules (Edge Case #14).
 */
export function validateMediaForPlatform(params: {
  platform: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}): { valid: boolean; invalidReason?: string } {
  const { platform, mimeType, fileName, sizeBytes, width, height, durationSec } = params;
  const lowerMime = (mimeType || '').toLowerCase();
  const lowerName = (fileName || '').toLowerCase();
  const isVideo =
    lowerMime.startsWith('video/') ||
    lowerName.endsWith('.mp4') ||
    lowerName.endsWith('.mov');
  const isImage =
    lowerMime.startsWith('image/') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg') ||
    lowerName.endsWith('.png') ||
    lowerName.endsWith('.webp');

  if (!isVideo && !isImage) {
    return {
      valid: false,
      invalidReason: `Unsupported media MIME type "${mimeType}" for file "${fileName}"`,
    };
  }

  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  if (platform === 'INSTAGRAM') {
    if (isImage && sizeBytes > 8 * MB) {
      return {
        valid: false,
        invalidReason: `Instagram image exceeds 8 MB limit (${(sizeBytes / MB).toFixed(1)} MB)`,
      };
    }
    if (isVideo) {
      if (sizeBytes > 1 * GB) {
        return {
          valid: false,
          invalidReason: `Instagram video exceeds 1 GB limit`,
        };
      }
      if (durationSec != null && (durationSec < 3 || durationSec > 900)) {
        return {
          valid: false,
          invalidReason: `Instagram Reel duration (${durationSec}s) must be between 3s and 900s`,
        };
      }
    }
  } else if (platform === 'TIKTOK') {
    if (!isVideo) {
      return {
        valid: false,
        invalidReason: `TikTok requires a video (.mp4/.mov), got "${mimeType}"`,
      };
    }
    if (sizeBytes > 4 * GB) {
      return {
        valid: false,
        invalidReason: `TikTok video exceeds 4 GB limit`,
      };
    }
    if (durationSec != null && (durationSec < 1 || durationSec > 600)) {
      return {
        valid: false,
        invalidReason: `TikTok video duration (${durationSec}s) must be between 1s and 600s`,
      };
    }
  } else if (platform === 'LINKEDIN') {
    if (isImage && sizeBytes > 10 * MB) {
      return {
        valid: false,
        invalidReason: `LinkedIn image exceeds 10 MB limit (${(sizeBytes / MB).toFixed(1)} MB)`,
      };
    }
    if (isVideo) {
      if (sizeBytes > 5 * GB) {
        return {
          valid: false,
          invalidReason: `LinkedIn video exceeds 5 GB limit`,
        };
      }
      if (durationSec != null && (durationSec < 3 || durationSec > 900)) {
        return {
          valid: false,
          invalidReason: `LinkedIn video duration (${durationSec}s) must be between 3s and 900s`,
        };
      }
    }
  } else if (platform === 'YOUTUBE') {
    if (!isVideo) {
      return {
        valid: false,
        invalidReason: `YouTube main asset must be a video, got "${mimeType}"`,
      };
    }
  }

  if (width != null && height != null && (width <= 0 || height <= 0)) {
    return {
      valid: false,
      invalidReason: `Invalid media dimensions (${width}x${height})`,
    };
  }

  return { valid: true };
}

