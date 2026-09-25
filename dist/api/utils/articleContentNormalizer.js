"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeArticleContent = normalizeArticleContent;
function normalizeArticleContent(content) {
    if (!content || typeof content !== 'string') {
        return content;
    }
    // Regex to detect an unordered list item line:
    // Starts with optional spaces/tabs, optional backslash escape, followed by *, -, +, •, or ●,
    // followed by at least one space/tab, then non-empty text that is not just more delimiter chars.
    const listItemPattern = /^([ \t]*)\\?(?:[*+\-•●])[ \t]+(?!\*|-|\+)(\S.*)$/;
    const rawLines = content.split(/\r?\n/);
    let inCodeBlock = false;
    let seenFirstH1 = false;
    let hasChanges = false;
    const resultLines = [];
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const trimmed = line.trim();
        // Check code fences
        if (trimmed.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            resultLines.push(line);
            continue;
        }
        if (inCodeBlock) {
            resultLines.push(line);
            continue;
        }
        // Check for mid-article H1 heading (e.g. `# FAQ` or subsequent `# Heading` in body)
        const h1Match = line.match(/^#\s+(\S.*)$/);
        if (h1Match) {
            const headingText = h1Match[1].trim();
            const isFaqHeading = /^(?:FAQ|Frequently Asked Questions)\b/i.test(headingText);
            if (!seenFirstH1 && !isFaqHeading) {
                // First H1 is the valid top-level article title
                seenFirstH1 = true;
                resultLines.push(line);
            }
            else {
                // Subsequent H1 or any `# FAQ` inside the body is malformed; normalize to H2 (`## `)
                const normalizedHeading = `## ${headingText}`;
                if (line !== normalizedHeading) {
                    hasChanges = true;
                }
                // Ensure separation from preceding content if preceding line was non-empty
                if (resultLines.length > 0) {
                    const prevLine = resultLines[resultLines.length - 1];
                    if (prevLine.trim() !== '') {
                        resultLines.push('');
                        hasChanges = true;
                    }
                }
                resultLines.push(normalizedHeading);
                // Ensure separation from following content if next line is non-empty
                if (i + 1 < rawLines.length && rawLines[i + 1].trim() !== '') {
                    resultLines.push('');
                    hasChanges = true;
                }
            }
            continue;
        }
        const match = line.match(listItemPattern);
        if (match) {
            const indent = match[1] || '';
            const text = match[2];
            const normalizedLine = `${indent}● ${text}`;
            if (line !== normalizedLine) {
                hasChanges = true;
            }
            // Ensure separation from preceding content if preceding line was non-empty
            if (resultLines.length > 0) {
                const prevLine = resultLines[resultLines.length - 1];
                if (prevLine.trim() !== '') {
                    resultLines.push('');
                    hasChanges = true;
                }
            }
            resultLines.push(normalizedLine);
            // Check if next line exists and is non-empty
            if (i + 1 < rawLines.length) {
                const nextLine = rawLines[i + 1];
                if (nextLine.trim() !== '') {
                    // If the next line is not an indented continuation line of this list item,
                    // ensure a blank line separates them.
                    const nextIsIndentedContinuation = /^[ \t]{2,}\S/.test(nextLine) && !listItemPattern.test(nextLine);
                    if (!nextIsIndentedContinuation) {
                        resultLines.push('');
                        hasChanges = true;
                    }
                }
            }
        }
        else {
            resultLines.push(line);
        }
    }
    if (!hasChanges) {
        return content;
    }
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    return resultLines.join(newline);
}
