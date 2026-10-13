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

function getTextWidth(text: string, fontSize: number, isBold: boolean = false): number {
  if (!text) return 0;
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += getCharWidth(text[i], isBold) * fontSize;
  }
  return w;
}

function renderFitText(
  doc: SimplePdfDocument,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  defaultSize: number = 9.5,
  font: 'F1' | 'F2' | 'F3' = 'F1',
  color: [number, number, number] = [0.106, 0.149, 0.216]
): void {
  if (!text) return;
  const isBold = font === 'F2';
  let size = defaultSize;
  let w = getTextWidth(text, size, isBold);

  // If text exceeds maxWidth, scale down gracefully to a minimum readable size
  while (w > maxWidth && size > 7.0) {
    size -= 0.5;
    w = getTextWidth(text, size, isBold);
  }

  // If still too wide, truncate with ellipsis so it never overflows
  let displayText = text;
  if (w > maxWidth) {
    while (displayText.length > 3 && getTextWidth(displayText + '...', size, isBold) > maxWidth) {
      displayText = displayText.slice(0, -1);
    }
    displayText += '...';
  }

  doc.addText(displayText, x, y, { font, size, color });
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

  // Metadata Card (Responsive, auto-fitted grid with dedicated lines for review status)
  const metaHeight = 98;
  doc.addRect(40, doc.currentY, width, metaHeight, { fillColor: BG_LIGHT, strokeColor: BORDER, lineWidth: 1 });

  // Subtle vertical dividing line between Left & Right metadata columns
  doc.addLine(280, doc.currentY + 12, 280, doc.currentY + metaHeight - 12, BORDER, 0.75);

  const col1X = 52;
  const col1ValX = 135;
  const col1ValMaxW = 138;

  const col2X = 294;
  const col2ValX = 390;
  const col2ValMaxW = 156;

  const row1Y = doc.currentY + 18;
  const row2Y = doc.currentY + 36;
  const row3Y = doc.currentY + 54;
  const row4Y = doc.currentY + 72;
  const row4bY = doc.currentY + 84;

  // Left Column
  doc.addText('PARTICIPANT:', col1X, row1Y, { font: 'F2', size: 8, color: GOLD });
  renderFitText(doc, data.fullName || 'Executive Participant', col1ValX, row1Y, col1ValMaxW, 9.5, 'F2', TEXT_DARK);

  doc.addText('COMPANY:', col1X, row2Y, { font: 'F2', size: 8, color: GOLD });
  renderFitText(doc, data.company || 'Not provided', col1ValX, row2Y, col1ValMaxW, 9.5, 'F1', TEXT_DARK);

  doc.addText('EXECUTIVE ROLE:', col1X, row3Y, { font: 'F2', size: 8, color: GOLD });
  renderFitText(doc, data.role || 'Founder / Executive', col1ValX, row3Y, col1ValMaxW, 9.5, 'F1', TEXT_DARK);

  doc.addText('CONTACT EMAIL:', col1X, row4Y, { font: 'F2', size: 8, color: GOLD });
  renderFitText(doc, data.email || 'Not provided', col1ValX, row4Y, col1ValMaxW, 9.5, 'F1', TEXT_DARK);

  // Right Column
  doc.addText('WORKSHEET REF:', col2X, row1Y, { font: 'F2', size: 8, color: GOLD });
  renderFitText(doc, data.submissionRef || 'FNM-VERIFIED', col2ValX, row1Y, col2ValMaxW, 9.5, 'F2', TEXT_DARK);

  const formattedDate = data.submittedAt
    ? typeof data.submittedAt === 'string'
      ? data.submittedAt
      : data.submittedAt.toISOString().slice(0, 10)
    : 'Recorded in Session';
  doc.addText('SUBMISSION DATE:', col2X, row2Y, { font: 'F2', size: 8, color: GOLD });
  renderFitText(doc, formattedDate, col2ValX, row2Y, col2ValMaxW, 9.5, 'F1', TEXT_DARK);

  doc.addText('STATUS / STAGE:', col2X, row3Y, { font: 'F2', size: 8, color: GOLD });
  const statusStageStr = `${(data.status || 'Submitted').toUpperCase()} (Stage ${data.currentStage || 4}/4 · ${data.courseProgress || 100}%)`;
  renderFitText(doc, statusStageStr, col2ValX, row3Y, col2ValMaxW, 8.5, 'F2', GOLD);

  doc.addText('STRATEGIC REVIEW:', col2X, row4Y, { font: 'F2', size: 8, color: GOLD });
  if (data.bookingRef) {
    renderFitText(doc, `Confirmed (${data.bookingRef})`, col2ValX, row4Y, col2ValMaxW, 8.5, 'F2', TEXT_DARK);
    if (data.slotTime) {
      renderFitText(doc, data.slotTime, col2ValX, row4bY, col2ValMaxW, 8, 'F1', TEXT_MUTED);
    }
  } else {
    renderFitText(doc, 'Pending calendar slot booking', col2ValX, row4Y, col2ValMaxW, 8.5, 'F3', TEXT_MUTED);
  }

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
  // PARTICIPANT REFLECTIONS & PERSONAL NOTES
  // ==========================================
  renderSectionHeader('Participant Reflections & Personal Notes');

  // Helper to render dedicated note items with gold accent styling
  const renderNoteItem = (numLabel: string, noteTitle: string, noteContent: any) => {
    const rawVal = noteContent !== undefined && noteContent !== null ? String(noteContent).trim() : '';
    const hasNote = rawVal.length > 0;
    const displayAnswer = hasNote ? rawVal : `[No personal reflection notes recorded for this stage]`;

    const answerLines = wrapLines(displayAnswer, width - 24, 9.5, false);
    const itemHeight = 18 + answerLines.length * 13 + 12;

    doc.ensureSpace(Math.min(itemHeight, 150), drawRunningHeader);

    // Note header label
    doc.addText(`${numLabel}. ${noteTitle}`, 40, doc.currentY, {
      font: 'F2',
      size: 9.5,
      color: GOLD,
    });
    doc.currentY += 14;

    // Note box background with gold left accent border
    const boxHeight = answerLines.length * 13 + 10;
    doc.addRect(40, doc.currentY - 2, width, boxHeight, {
      fillColor: hasNote ? BG_LIGHT : [0.97, 0.97, 0.97],
      strokeColor: BORDER,
      lineWidth: 0.5,
    });
    doc.addLine(40, doc.currentY - 2, 40, doc.currentY - 2 + boxHeight, hasNote ? GOLD : BORDER, 2.5);

    // Note body text
    doc.currentY = doc.addWrappedText(displayAnswer, 50, doc.currentY + 9, width - 24, 13, {
      font: hasNote ? 'F1' : 'F3',
      size: 9.5,
      color: hasNote ? TEXT_DARK : TEXT_MUTED,
      onPageBreak: drawRunningHeader,
    });

    doc.currentY += 14;
  };

  // Consolidate personal notes from both data.personalNotes and data.formData
  const notesSource: Record<string, any> = {};
  if (notes && typeof notes === 'object') {
    Object.assign(notesSource, notes);
  }
  if (f && typeof f === 'object') {
    if (f.personalNotes && typeof f.personalNotes === 'object') {
      Object.assign(notesSource, f.personalNotes);
    }
    for (const key of [
      'stage1_notes', 'stage2_notes', 'stage3_notes', 'stage4_notes',
      'stage1Notes', 'stage2Notes', 'stage3Notes', 'stage4Notes',
    ]) {
      if (f[key] && !notesSource[key]) {
        notesSource[key] = f[key];
      }
    }
  }

  const stage1Note = notesSource.stage1_notes ?? notesSource.stage1Notes ?? notesSource.stage_1_notes ?? notesSource['stage1 notes'];
  const stage2Note = notesSource.stage2_notes ?? notesSource.stage2Notes ?? notesSource.stage_2_notes ?? notesSource['stage2 notes'];
  const stage3Note = notesSource.stage3_notes ?? notesSource.stage3Notes ?? notesSource.stage_3_notes ?? notesSource['stage3 notes'];
  const stage4Note = notesSource.stage4_notes ?? notesSource.stage4Notes ?? notesSource.stage_4_notes ?? notesSource['stage4 notes'];

  const standardNoteKeys = new Set([
    'stage1_notes', 'stage1Notes', 'stage_1_notes', 'stage1 notes',
    'stage2_notes', 'stage2Notes', 'stage_2_notes', 'stage2 notes',
    'stage3_notes', 'stage3Notes', 'stage_3_notes', 'stage3 notes',
    'stage4_notes', 'stage4Notes', 'stage_4_notes', 'stage4 notes',
  ]);

  const customNotes = Object.entries(notesSource).filter(
    ([k, v]) => !standardNoteKeys.has(k) && v !== null && v !== undefined && String(v).trim().length > 0
  );

  const hasStage1 = Boolean(stage1Note && String(stage1Note).trim());
  const hasStage2 = Boolean(stage2Note && String(stage2Note).trim());
  const hasStage3 = Boolean(stage3Note && String(stage3Note).trim());
  const hasStage4 = Boolean(stage4Note && String(stage4Note).trim());
  const hasAnyStageNotes = hasStage1 || hasStage2 || hasStage3 || hasStage4;
  const hasAnyNotes = hasAnyStageNotes || customNotes.length > 0;

  if (!hasAnyNotes) {
    doc.ensureSpace(55, drawRunningHeader);
    doc.addRect(40, doc.currentY, width, 42, {
      fillColor: BG_LIGHT,
      strokeColor: BORDER,
      lineWidth: 0.5,
    });
    doc.addLine(40, doc.currentY, 40, doc.currentY + 42, GOLD, 3);
    doc.addText('STATUS: No personal reflection notes recorded by participant.', 52, doc.currentY + 16, {
      font: 'F2',
      size: 9,
      color: TEXT_DARK,
    });
    doc.addText(
      'Worksheet responses across Stages 1-4 are documented above for executive strategic review.',
      52,
      doc.currentY + 30,
      {
        font: 'F3',
        size: 8.5,
        color: TEXT_MUTED,
      }
    );
    doc.currentY += 56;
  } else {
    // If participant entered any stage notes, render all 4 stage note blocks with notes or clear placeholders
    if (hasAnyStageNotes) {
      renderNoteItem('Note 1', 'Stage 1 Personal Reflection: Define the Next Stage', stage1Note);
      renderNoteItem('Note 2', 'Stage 2 Personal Reflection: Success Changes the Game', stage2Note);
      renderNoteItem('Note 3', 'Stage 3 Personal Reflection: Prepare for Performance', stage3Note);
      renderNoteItem('Note 4', 'Stage 4 Personal Reflection: Your Next Move', stage4Note);
    }

    // Render any additional or custom executive reflection notes
    for (let i = 0; i < customNotes.length; i++) {
      const [k, v] = customNotes[i];
      const cleanLabel = k
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      const noteNum = hasAnyStageNotes ? `Note ${5 + i}` : `Note ${1 + i}`;
      renderNoteItem(noteNum, `Executive Reflection: ${cleanLabel}`, v);
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
