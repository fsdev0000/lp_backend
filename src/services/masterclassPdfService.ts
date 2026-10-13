/**
 * masterclassPdfService.ts
 * 
 * Standalone PDF generator for The Founder's Next Move Masterclass WorkSheet Dossier.
 * Produces standard, 100% compliant PDF 1.4 binary buffers with zero external dependencies.
 * Designed for Lionel Eersteling's executive reviews with Leaders Performance aesthetic.
 */

export interface WorksheetPdfData {
  submissionRef: string;
  fullName: string;
  email: string;
  company: string;
  role?: string;
  phone?: string;
  submittedAt?: string | Date;
  status?: string;
  courseProgress?: number;
  currentStage?: number;
  bookingRef?: string;
  slotTime?: string;
  formData: Record<string, any>;
  personalNotes?: Record<string, any>;
}

// Approximate widths for Helvetica characters at 1pt font size
function getCharWidth(char: string, isBold: boolean = false): number {
  const code = char.charCodeAt(0);
  if (code === 32) return isBold ? 0.28 : 0.28; // space
  if ('ijlI.,;:\'|![]()'.includes(char)) return isBold ? 0.32 : 0.28;
  if ('wmWM@%#'.includes(char)) return isBold ? 0.95 : 0.89;
  if ('ABCDEFGHJKLNOPQRSTUVXYZ'.includes(char)) return isBold ? 0.72 : 0.67;
  return isBold ? 0.61 : 0.56; // default lowercase
}

function escapePdfText(text: string): string {
  // Replace smart quotes, en/em dashes, bullets with clean ASCII equivalents
  const clean = text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2022\u2023\u25E6]/g, '*')
    .replace(/[\u2026]/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');

  // Escape PDF special syntax: backslash, open paren, close paren
  return clean
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapLines(text: string, maxWidthPt: number, fontSizePt: number, isBold: boolean = false): string[] {
  if (!text) return [];
  const paragraphs = text.split(/\r?\n/);
  const result: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      result.push('');
      continue;
    }

    const words = para.split(/\s+/);
    let currentLine = '';
    let currentWidth = 0;

    for (const word of words) {
      let wordWidth = 0;
      for (let i = 0; i < word.length; i++) {
        wordWidth += getCharWidth(word[i], isBold) * fontSizePt;
      }
      const spaceWidth = getCharWidth(' ', isBold) * fontSizePt;

      if (!currentLine) {
        currentLine = word;
        currentWidth = wordWidth;
      } else if (currentWidth + spaceWidth + wordWidth <= maxWidthPt) {
        currentLine += ' ' + word;
        currentWidth += spaceWidth + wordWidth;
      } else {
        result.push(currentLine);
        currentLine = word;
        currentWidth = wordWidth;
      }
    }

    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result;
}

export class SimplePdfDocument {
  private pageWidth = 595.28; // A4 standard width
  private pageHeight = 841.89; // A4 standard height
  private leftMargin = 40;
  private rightMargin = 40;
  private topMargin = 45;
  private bottomMargin = 45;
  private usableWidth = 515.28;

  private pages: string[] = [];
  private currentPageContent: string[] = [];
  public currentY: number;

  constructor() {
    this.currentY = this.topMargin;
  }

  public getUsableWidth(): number {
    return this.usableWidth;
  }

  public getPageCount(): number {
    return this.pages.length + (this.currentPageContent.length > 0 ? 1 : 0);
  }

  public startNewPage(): void {
    if (this.currentPageContent.length > 0 || this.pages.length === 0) {
      this.pages.push(this.currentPageContent.join('\n'));
      this.currentPageContent = [];
    }
    this.currentY = this.topMargin;
  }

  public ensureSpace(neededHeight: number, onPageBreak?: () => void): void {
    if (this.currentY + neededHeight > this.pageHeight - this.bottomMargin) {
      this.startNewPage();
      if (onPageBreak) {
        onPageBreak();
      }
    }
  }

  // PDF coordinate conversion: Y=0 at bottom in PDF, but we use Y=0 at top
  private toPdfY(userY: number): number {
    return Number((this.pageHeight - userY).toFixed(2));
  }

  public addRect(
    x: number,
    y: number,
    width: number,
    height: number,
    options: {
      fillColor?: [number, number, number];
      strokeColor?: [number, number, number];
      lineWidth?: number;
    } = {}
  ): void {
    const pdfY = this.toPdfY(y + height);
    const ops: string[] = ['q'];

    if (options.lineWidth) {
      ops.push(`${options.lineWidth.toFixed(2)} w`);
    }
    if (options.strokeColor) {
      const [r, g, b] = options.strokeColor;
      ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
    }
    if (options.fillColor) {
      const [r, g, b] = options.fillColor;
      ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    }

    ops.push(`${x.toFixed(2)} ${pdfY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re`);

    if (options.fillColor && options.strokeColor) {
      ops.push('B');
    } else if (options.fillColor) {
      ops.push('f');
    } else {
      ops.push('S');
    }

    ops.push('Q');
    this.currentPageContent.push(ops.join(' '));
  }

  public addLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    strokeColor: [number, number, number] = [0.8, 0.8, 0.8],
    lineWidth: number = 0.75
  ): void {
    const py1 = this.toPdfY(y1);
    const py2 = this.toPdfY(y2);
    const [r, g, b] = strokeColor;
    this.currentPageContent.push(
      `q ${lineWidth.toFixed(2)} w ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${x1.toFixed(2)} ${py1.toFixed(2)} m ${x2.toFixed(2)} ${py2.toFixed(2)} l S Q`
    );
  }

  public addText(
    text: string,
    x: number,
    y: number,
    options: {
      font?: 'F1' | 'F2' | 'F3'; // F1: Helvetica, F2: Helvetica-Bold, F3: Helvetica-Oblique
      size?: number;
      color?: [number, number, number];
    } = {}
  ): void {
    const font = options.font || 'F1';
    const size = options.size || 10;
    const [r, g, b] = options.color || [0.1, 0.1, 0.1];
    const pdfY = this.toPdfY(y);
    const escaped = escapePdfText(text);

    this.currentPageContent.push(
      `BT /${font} ${size.toFixed(1)} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ${x.toFixed(2)} ${pdfY.toFixed(2)} Td (${escaped}) Tj ET`
    );
  }

  public addWrappedText(
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    options: {
      font?: 'F1' | 'F2' | 'F3';
      size?: number;
      color?: [number, number, number];
      onPageBreak?: () => void;
    } = {}
  ): number {
    const font = options.font || 'F1';
    const size = options.size || 10;
    const isBold = font === 'F2';
    const lines = wrapLines(text, maxWidth, size, isBold);

    let curY = y;
    for (const line of lines) {
      if (curY + lineHeight > this.pageHeight - this.bottomMargin) {
        this.startNewPage();
        if (options.onPageBreak) {
          options.onPageBreak();
        }
        curY = this.currentY;
      }

      if (line) {
        this.addText(line, x, curY, { font, size, color: options.color });
      }
      curY += lineHeight;
    }

    return curY;
  }

  public compileBuffer(): Buffer {
    // Flush active page if content exists
    if (this.currentPageContent.length > 0) {
      this.pages.push(this.currentPageContent.join('\n'));
      this.currentPageContent = [];
    }

    if (this.pages.length === 0) {
      this.pages.push('');
    }

    const totalPages = this.pages.length;
    const objects: string[] = [];
    const offsets: number[] = [];

    let currentOffset = 0;
    const addObj = (content: string): number => {
      offsets.push(currentOffset);
      const str = `${offsets.length} 0 obj\n${content}\nendobj\n`;
      currentOffset += Buffer.byteLength(str, 'utf8');
      objects.push(str);
      return offsets.length;
    };

    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    currentOffset = Buffer.byteLength(header, 'utf8');

    // Obj 1: Catalog
    addObj('<< /Type /Catalog /Pages 2 0 R >>');

    // Obj 2: Pages list placeholder (will update with kids)
    const pagesObjIndex = 2;
    offsets.push(0); // placeholder
    objects.push(''); // placeholder

    // Standard Built-in Fonts
    const f1Obj = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2Obj = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const f3Obj = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');

    const pageObjNumbers: number[] = [];

    // For each page, render contents and inject running footer with total page count
    for (let p = 0; p < totalPages; p++) {
      const pageIndex = p + 1;
      const footerText = `Page ${pageIndex} of ${totalPages}  |  Strictly Confidential  |  The Founder's Next Move  |  Leaders Performance`;
      const escapedFooter = escapePdfText(footerText);
      const footerOps = `BT /F1 8.5 Tf 0.5 0.5 0.5 rg 40.00 25.00 Td (${escapedFooter}) Tj ET`;
      const fullPageStream = this.pages[p] + '\n' + footerOps;
      const streamBytes = Buffer.byteLength(fullPageStream, 'utf8');

      // Content stream obj
      const streamObjNum = addObj(`<< /Length ${streamBytes} >>\nstream\n${fullPageStream}\nendstream`);

      // Page obj
      const pageObjNum = addObj(`<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [0 0 ${this.pageWidth} ${this.pageHeight}]
  /Resources <<
    /Font <<
      /F1 ${f1Obj} 0 R
      /F2 ${f2Obj} 0 R
      /F3 ${f3Obj} 0 R
    >>
  >>
  /Contents ${streamObjNum} 0 R
>>`);

      pageObjNumbers.push(pageObjNum);
    }

    // Now fill Pages Obj (Obj 2)
    const kidsStr = pageObjNumbers.map((num) => `${num} 0 R`).join(' ');
    const pagesObjContent = `<< /Type /Pages /Kids [${kidsStr}] /Count ${totalPages} >>`;
    const pagesStr = `2 0 obj\n${pagesObjContent}\nendobj\n`;

    // Recalculate offsets accurately
    offsets[1] = Buffer.byteLength(header, 'utf8') + Buffer.byteLength(objects[0], 'utf8');
    objects[1] = pagesStr;

    // Recalculate exact offsets for all objects
    let runningOffset = Buffer.byteLength(header, 'utf8');
    for (let i = 0; i < objects.length; i++) {
      offsets[i] = runningOffset;
      runningOffset += Buffer.byteLength(objects[i], 'utf8');
    }

    const startXref = runningOffset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += offset.toString().padStart(10, '0') + ' 00000 n \n';
    }

    const trailer = `trailer\n<<\n  /Size ${objects.length + 1}\n  /Root 1 0 R\n>>\nstartxref\n${startXref}\n%%EOF\n`;

    const fullPdf = header + objects.join('') + xref + trailer;
    return Buffer.from(fullPdf, 'utf8');
  }
}

/**
 * Builds the complete, formatted executive Masterclass WorkSheet PDF.
 */
export function generateMasterclassWorksheetPdf(data: WorksheetPdfData): Buffer {
  const doc = new SimplePdfDocument();
  const width = doc.getUsableWidth();

  const NAVY: [number, number, number] = [0.008, 0.075, 0.161]; // #021329
  const GOLD: [number, number, number] = [0.624, 0.396, 0.067]; // #9F6511
  const ACCENT_GOLD: [number, number, number] = [0.816, 0.639, 0.353]; // #D0A35A
  const TEXT_DARK: [number, number, number] = [0.106, 0.149, 0.216]; // #1B2637
  const TEXT_MUTED: [number, number, number] = [0.290, 0.333, 0.408]; // #4A5568
  const BG_LIGHT: [number, number, number] = [0.984, 0.973, 0.949]; // #FBF8F2
  const BORDER: [number, number, number] = [0.922, 0.894, 0.859]; // #EBE4DB

  const drawRunningHeader = () => {
    doc.addRect(40, doc.currentY, width, 24, { fillColor: NAVY });
    doc.addText('LEADERS PERFORMANCE · THE FOUNDER’S NEXT MOVE · STRATEGIC REVIEW DOSSIER', 50, doc.currentY + 16, {
      font: 'F2',
      size: 8,
      color: ACCENT_GOLD,
    });
    doc.addLine(40, doc.currentY + 24, 40 + width, doc.currentY + 24, ACCENT_GOLD, 1);
    doc.currentY += 36;
  };

  // ==========================================
  // PAGE 1: HERO HEADER & EXECUTIVE BRIEFING
  // ==========================================
  // Top Banner
  doc.addRect(40, doc.currentY, width, 72, { fillColor: NAVY });
  doc.addText('LEADERS PERFORMANCE  |  EXECUTIVE ADVISORY  |  DUBAI', 52, doc.currentY + 22, {
    font: 'F2',
    size: 8.5,
    color: ACCENT_GOLD,
  });
  doc.addText("The Founder's Next Move — Strategic WorkSheet", 52, doc.currentY + 44, {
    font: 'F2',
    size: 16,
    color: [1, 1, 1],
  });
  doc.addText('Executive 1-on-1 Strategic Review Dossier with Lionel Eersteling', 52, doc.currentY + 60, {
    font: 'F1',
    size: 9.5,
    color: [0.88, 0.88, 0.88],
  });
  doc.addLine(40, doc.currentY + 72, 40 + width, doc.currentY + 72, ACCENT_GOLD, 2);
  doc.currentY += 86;

  // Metadata Card
  const metaHeight = 90;
  doc.addRect(40, doc.currentY, width, metaHeight, { fillColor: BG_LIGHT, strokeColor: BORDER, lineWidth: 1 });

  const col1X = 54;
  const col2X = 300;
  const row1Y = doc.currentY + 18;
  const row2Y = doc.currentY + 36;
  const row3Y = doc.currentY + 54;
  const row4Y = doc.currentY + 72;

  // Left Column
  doc.addText('PARTICIPANT:', col1X, row1Y, { font: 'F2', size: 8, color: GOLD });
  doc.addText(data.fullName || 'Executive Participant', col1X + 75, row1Y, { font: 'F2', size: 9.5, color: TEXT_DARK });

  doc.addText('COMPANY:', col1X, row2Y, { font: 'F2', size: 8, color: GOLD });
  doc.addText(data.company || 'Not provided', col1X + 75, row2Y, { font: 'F1', size: 9.5, color: TEXT_DARK });

  doc.addText('EXECUTIVE ROLE:', col1X, row3Y, { font: 'F2', size: 8, color: GOLD });
  doc.addText(data.role || 'Founder / Executive', col1X + 75, row3Y, { font: 'F1', size: 9.5, color: TEXT_DARK });

  doc.addText('CONTACT EMAIL:', col1X, row4Y, { font: 'F2', size: 8, color: GOLD });
  doc.addText(data.email || 'Not provided', col1X + 75, row4Y, { font: 'F1', size: 9.5, color: TEXT_DARK });

  // Right Column
  doc.addText('WORKSHEET REF:', col2X, row1Y, { font: 'F2', size: 8, color: GOLD });
  doc.addText(data.submissionRef || 'FNM-VERIFIED', col2X + 96, row1Y, { font: 'F2', size: 9.5, color: TEXT_DARK });

  const formattedDate = data.submittedAt
    ? typeof data.submittedAt === 'string'
      ? data.submittedAt
      : data.submittedAt.toISOString().slice(0, 10)
    : 'Recorded in Session';
  doc.addText('SUBMISSION DATE:', col2X, row2Y, { font: 'F2', size: 8, color: GOLD });
  doc.addText(formattedDate, col2X + 96, row2Y, { font: 'F1', size: 9.5, color: TEXT_DARK });

  doc.addText('STATUS / STAGE:', col2X, row3Y, { font: 'F2', size: 8, color: GOLD });
  const statusStageStr = `${(data.status || 'Submitted').toUpperCase()} (Stage ${data.currentStage || 4} of 4 - ${data.courseProgress || 100}% Complete)`;
  doc.addText(statusStageStr, col2X + 96, row3Y, { font: 'F2', size: 8.5, color: GOLD });

  doc.addText('STRATEGIC REVIEW:', col2X, row4Y, { font: 'F2', size: 8, color: GOLD });
  const reviewBookingStr = data.bookingRef ? `Confirmed (${data.bookingRef}${data.slotTime ? ` - ${data.slotTime}` : ''})` : 'Pending calendar slot booking';
  doc.addText(reviewBookingStr, col2X + 96, row4Y, { font: 'F1', size: 8.5, color: TEXT_DARK });

  doc.currentY += metaHeight + 18;

  // Helper to render Stage sections
  const f = data.formData || {};
  const notes = data.personalNotes || {};

  let isFirstSection = true;
  const renderSectionHeader = (stageTitle: string) => {
    doc.ensureSpace(55, drawRunningHeader);
    if (!isFirstSection) {
      doc.currentY += 14;
    }
    isFirstSection = false;

    doc.addRect(40, doc.currentY, width, 24, { fillColor: BG_LIGHT, strokeColor: BORDER, lineWidth: 0.75 });
    doc.addLine(40, doc.currentY, 40, doc.currentY + 24, GOLD, 3.5);
    doc.addText(stageTitle.toUpperCase(), 50, doc.currentY + 16, { font: 'F2', size: 9.5, color: GOLD });
    // Provide generous breathing room (24 height + 18 margin) so the first question title line is not too close to the bar
    doc.currentY += 42;
  };

  const renderQaItem = (numLabel: string, questionTitle: string, answer: any) => {
    const rawVal = answer !== undefined && answer !== null ? String(answer).trim() : '';
    const displayAnswer = rawVal.length > 0 ? rawVal : '[Participant provided no response for this item]';
    const isPlaceholder = rawVal.length === 0;

    // Estimate height
    const headerLines = 1;
    const answerLines = wrapLines(displayAnswer, width - 20, 9.5, false);
    const itemHeight = 18 + answerLines.length * 13 + 12;

    doc.ensureSpace(Math.min(itemHeight, 150), drawRunningHeader);

    // Question label
    doc.addText(`${numLabel}. ${questionTitle}`, 40, doc.currentY, {
      font: 'F2',
      size: 9.5,
      color: TEXT_DARK,
    });
    doc.currentY += 14;

    // Answer block background
    const boxHeight = answerLines.length * 13 + 10;
    doc.addRect(40, doc.currentY - 2, width, boxHeight, {
      fillColor: isPlaceholder ? [0.97, 0.97, 0.97] : BG_LIGHT,
      strokeColor: BORDER,
      lineWidth: 0.5,
    });

    // Answer lines
    doc.currentY = doc.addWrappedText(displayAnswer, 48, doc.currentY + 9, width - 20, 13, {
      font: isPlaceholder ? 'F3' : 'F1',
      size: 9.5,
      color: isPlaceholder ? TEXT_MUTED : TEXT_DARK,
      onPageBreak: drawRunningHeader,
    });

    doc.currentY += 14;
  };

  // ==========================================
  // STAGE 1: DEFINE THE NEXT STAGE
  // ==========================================
  renderSectionHeader('Stage 1: Define the Next Stage');
  renderQaItem('1', 'Next Stage of Growth', f.stage1_nextStage);
  renderQaItem('2', 'What This Next Stage Makes Possible', f.stage1_possibility);
  renderQaItem('3', 'Core Strengths to Carry Forward', f.stage1_strength);

  // ==========================================
  // STAGE 2: SUCCESS CHANGES THE GAME
  // ==========================================
  renderSectionHeader('Stage 2: Success Changes the Game');
  renderQaItem('1', 'What Changes Most as the Organisation Scales', f.stage2_changes);
  renderQaItem('2A', 'Demand 1: Leadership & Strategic Altitude', f.stage2_demand1);
  renderQaItem('2B', 'Demand 2: Executive Accountability & Team Alignment', f.stage2_demand2);
  renderQaItem('2C', 'Demand 3: Operational Cadence & Strategic Governance', f.stage2_demand3);
  renderQaItem('3', 'Performance Investment & Capacity Required', f.stage2_investment);

  // ==========================================
  // STAGE 3: PREPARE FOR PERFORMANCE
  // ==========================================
  renderSectionHeader('Stage 3: Prepare for Performance');
  renderQaItem('1A', 'Founder Capability to Elevate', f.stage3_founderStrength);
  renderQaItem('1B', 'Founder Performance Standard to Uphold', f.stage3_founderStandard);
  renderQaItem('2A', 'Executive Leadership Capability Required', f.stage3_teamStrength);
  renderQaItem('2B', 'Executive Leadership Performance Standard', f.stage3_teamStandard);
  renderQaItem('3A', 'Organisation System & Architecture to Reinforce', f.stage3_orgStrength);
  renderQaItem('3B', 'Organisation Investment & Resource Allocation', f.stage3_orgInvestment);
  renderQaItem('3C', 'Primary Focus Area & Highest Leverage Pivot', f.stage3_focusArea);

  // ==========================================
  // STAGE 4: YOUR NEXT MOVE
  // ==========================================
  renderSectionHeader('Stage 4: Your Next Move');
  const p30 = f.stage4_priority30Days || f.stage4_priority90Days;
  renderQaItem('1', 'One 30-Day Preparation Priority', p30);
  renderQaItem('1A', 'Milestone 1', f.stage4_milestone1);
  renderQaItem('1B', 'Milestone 2', f.stage4_milestone2);
  renderQaItem('1C', 'Milestone 3', f.stage4_milestone3);
  renderQaItem('2', 'One Action Within Next 24 Hours', f.stage4_action7Days);
  renderQaItem('3', 'When Action Will Be Taken', f.stage4_actionTiming);
  renderQaItem('4', 'Evidence to Tell Whether Action Has Helped', f.stage4_evidence);

  // ==========================================
  // PERSONAL NOTES & STRATEGIC REFLECTIONS
  // ==========================================
  const notesEntries = Object.entries(notes).filter(
    ([_, v]) => v !== null && v !== undefined && String(v).trim().length > 0
  );
  if (notesEntries.length > 0) {
    renderSectionHeader('Participant Reflections & Personal Notes');
    for (const [key, val] of notesEntries) {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
      renderQaItem('Note', label, val);
    }
  }

  // Final Confidentiality Statement
  doc.ensureSpace(50, drawRunningHeader);
  doc.addRect(40, doc.currentY, width, 40, { fillColor: BG_LIGHT, strokeColor: BORDER, lineWidth: 0.5 });
  doc.addText(
    'ADVISORY NOTICE: This dossier is strictly confidential and reserved for executive strategic review.',
    50,
    doc.currentY + 16,
    { font: 'F2', size: 8, color: GOLD }
  );
  doc.addText(
    'Conducted under Leaders Performance Executive Advisory protocol. All intellectual property remains protected.',
    50,
    doc.currentY + 28,
    { font: 'F1', size: 8, color: TEXT_MUTED }
  );
  doc.currentY += 50;

  return doc.compileBuffer();
}
