"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAndValidateArticleInput = parseAndValidateArticleInput;
/**
 * Extracts metadata and content from raw request body (JSON or text with YAML frontmatter/headers)
 */
function parseAndValidateArticleInput(rawBody, headers, query) {
    let body = {};
    const getHeader = (name) => {
        const val = headers[name] || headers[name.toLowerCase()] || query[name.replace(/^x-/, '')];
        if (Array.isArray(val))
            return val[0];
        return val;
    };
    // 1. Determine body payload
    if (typeof rawBody === 'object' && rawBody !== null && !Buffer.isBuffer(rawBody)) {
        body = { ...rawBody };
    }
    else if (typeof rawBody === 'string') {
        const trimmed = rawBody.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                body = JSON.parse(trimmed);
            }
            catch (e) {
                return { valid: false, error: 'Invalid JSON body' };
            }
        }
        else {
            // Raw markdown or text format
            body = {
                content: rawBody,
                slug: getHeader('x-slug'),
                title: getHeader('x-title'),
                excerpt: getHeader('x-excerpt'),
                pillar: getHeader('x-pillar'),
                meta_title: getHeader('x-meta-title'),
                meta_description: getHeader('x-meta-description'),
                pillar_color: getHeader('x-pillar-color'),
                keywords: getHeader('x-keywords') ? getHeader('x-keywords').split(',').map((k) => k.trim()) : undefined,
                publish_date: getHeader('x-publish-date'),
                reading_time: getHeader('x-reading-time') ? Number(getHeader('x-reading-time')) : undefined,
                author: getHeader('x-author'),
                published: getHeader('x-published') ? getHeader('x-published') === 'true' : undefined,
            };
        }
    }
    let { slug, title, excerpt, pillar, pillar_color, keywords, meta_title, meta_description, publish_date, reading_time, author, content, published, } = body;
    // 2. YAML Frontmatter parsing if content contains frontmatter block
    if (typeof content === 'string') {
        const fmMatch = content.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
        if (fmMatch) {
            const fmBlock = fmMatch[1];
            const remaining = fmMatch[2];
            const fm = {};
            for (const rawLine of fmBlock.split(/\r?\n/)) {
                const m = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
                if (m) {
                    fm[m[1].toLowerCase().replace(/-/g, '_')] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
                }
            }
            slug = slug || fm.slug;
            title = title || fm.title;
            excerpt = excerpt || fm.excerpt;
            pillar = pillar || fm.pillar;
            meta_title = meta_title || fm.meta_title;
            meta_description = meta_description || fm.meta_description;
            author = author || fm.author;
            if (reading_time === undefined && fm.reading_time)
                reading_time = Number(fm.reading_time);
            if (keywords === undefined && fm.keywords)
                keywords = fm.keywords.split(',').map((k) => k.trim()).filter(Boolean);
            if (published === undefined && fm.published !== undefined)
                published = fm.published === 'true';
            if (publish_date === undefined && fm.publish_date)
                publish_date = fm.publish_date;
            if (pillar_color === undefined && fm.pillar_color)
                pillar_color = fm.pillar_color;
            content = remaining.replace(/^\s+/, '');
        }
    }
    // 3. Validation of required fields
    const missing = {
        slug: !slug,
        title: !title,
        excerpt: !excerpt,
        pillar: !pillar,
        content: !content,
        meta_title: !meta_title,
        meta_description: !meta_description,
    };
    if (missing.slug || missing.title || missing.excerpt || missing.pillar || missing.content || missing.meta_title || missing.meta_description) {
        return {
            valid: false,
            error: 'Missing required fields: slug, title, excerpt, pillar, content, meta_title, meta_description',
            received: {
                slug: !missing.slug,
                title: !missing.title,
                excerpt: !missing.excerpt,
                pillar: !missing.pillar,
                content: !missing.content,
                meta_title: !missing.meta_title,
                meta_description: !missing.meta_description,
            },
        };
    }
    // 4. Normalize publish_date: accept YYYY-MM-DD or DD-MM-YYYY
    if (typeof publish_date === 'string' && publish_date.trim().length > 0) {
        publish_date = publish_date.trim();
        const ddmmyyyy = publish_date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        const isoyyyy = /^\d{4}-\d{2}-\d{2}$/.test(publish_date);
        if (ddmmyyyy) {
            publish_date = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
        }
        else if (!isoyyyy) {
            return {
                valid: false,
                error: 'Invalid publish_date format. Use YYYY-MM-DD or DD-MM-YYYY.',
            };
        }
    }
    else if (!publish_date) {
        // Default to current date YYYY-MM-DD
        publish_date = new Date().toISOString().split('T')[0];
    }
    // 5. Normalize keywords
    let normalizedKeywords = [];
    if (Array.isArray(keywords)) {
        normalizedKeywords = keywords.map(k => String(k).trim()).filter(Boolean);
    }
    else if (typeof keywords === 'string') {
        normalizedKeywords = keywords.split(',').map(k => k.trim()).filter(Boolean);
    }
    // 6. Normalize reading_time
    let normalizedReadingTime = 5;
    if (reading_time !== undefined && reading_time !== null) {
        const parsed = Number(reading_time);
        if (!isNaN(parsed) && parsed > 0) {
            normalizedReadingTime = Math.round(parsed);
        }
    }
    // 7. Normalize published
    const isPublished = published !== undefined ? Boolean(published) : true;
    return {
        valid: true,
        data: {
            slug: String(slug).trim().toLowerCase(),
            title: String(title).trim(),
            excerpt: String(excerpt).trim(),
            pillar: String(pillar).trim(),
            pillar_color: pillar_color ? String(pillar_color).trim() : 'hsl(122,31%,42%)',
            keywords: normalizedKeywords,
            meta_title: String(meta_title).trim(),
            meta_description: String(meta_description).trim(),
            publish_date,
            reading_time: normalizedReadingTime,
            author: author ? String(author).trim() : 'Lionel Eersteling',
            content: String(content),
            published: isPublished,
        },
    };
}
