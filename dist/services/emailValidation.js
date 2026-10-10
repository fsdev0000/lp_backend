"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEmailBasic = validateEmailBasic;
exports.validateNewsletterEmailStrict = validateNewsletterEmailStrict;
const dns_1 = __importDefault(require("dns"));
const dnsResolver = new dns_1.default.promises.Resolver();
try {
    dnsResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
}
catch {
    // Fall back to default system servers
}
/**
 * Common disposable / burner email domains
 */
const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com',
    'tempmail.com',
    'temp-mail.org',
    '10minutemail.com',
    'guerrillamail.com',
    'guerrillamailblock.com',
    'trashmail.com',
    'yopmail.com',
    'throwawaymail.com',
    'sharklasers.com',
    'dispostable.com',
    'getairmail.com',
    'maildrop.cc',
    'inboxkitten.com',
    'fakeinbox.com',
    'fakemailgenerator.com',
    'burnermail.io',
    'mytemp.email',
    'crazymailing.com',
    'trashmail.net',
    'nada.ltd',
    'getnada.com',
    'mohmal.com',
    'emailondeck.com',
    'tempr.email',
    'discard.email',
    'generator.email',
]);
/**
 * Known domain typos for major email providers
 */
const DOMAIN_TYPOS = {
    'gmial.com': 'gmail.com',
    'gamil.com': 'gmail.com',
    'gmaill.com': 'gmail.com',
    'gmaik.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'hotmial.com': 'hotmail.com',
    'hotmaill.com': 'hotmail.com',
    'hotmai.com': 'hotmail.com',
    'outlok.com': 'outlook.com',
    'outloo.com': 'outlook.com',
    'outlock.com': 'outlook.com',
    'yaho.com': 'yahoo.com',
    'yahooo.com': 'yahoo.com',
    'yaho.co': 'yahoo.com',
    'iclud.com': 'icloud.com',
    'icoud.com': 'icloud.com',
};
/**
 * Reserved, dummy, and placeholder test domains
 */
const RESERVED_AND_TEST_DOMAINS = new Set([
    'example.com',
    'example.org',
    'example.net',
    'example.edu',
    'test.com',
    'test.org',
    'test.net',
    'sample.com',
    'sample.org',
    'sample.net',
    'demo.com',
    'fake.com',
    'testing.com',
    'foobar.com',
    'foo.com',
    'bar.com',
    'asdf.com',
    'qwerty.com',
    'invalid.com',
    'dummy.com',
    'placeholder.com',
]);
/**
 * Fast synchronous syntax, typo, disposable, and placeholder check
 */
function validateEmailBasic(emailStr) {
    if (!emailStr || typeof emailStr !== 'string') {
        return { valid: false, error: 'Please enter your email address.' };
    }
    const trimmed = emailStr.trim().toLowerCase();
    if (!trimmed) {
        return { valid: false, error: 'Please enter your email address.' };
    }
    if (trimmed.length > 254) {
        return { valid: false, error: 'Email address cannot exceed 254 characters.' };
    }
    // RFC 5322 compliant email regex check
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(trimmed)) {
        return { valid: false, error: 'Please enter a valid email address (e.g. founder@company.com).' };
    }
    const parts = trimmed.split('@');
    if (parts.length !== 2) {
        return { valid: false, error: 'Please enter a valid email address.' };
    }
    const [localPart, domain] = parts;
    if (localPart.length > 64) {
        return { valid: false, error: 'Email username cannot exceed 64 characters.' };
    }
    // 1. Check for common domain typos
    if (DOMAIN_TYPOS[domain]) {
        const suggestedDomain = DOMAIN_TYPOS[domain];
        const suggestedEmail = `${localPart}@${suggestedDomain}`;
        return {
            valid: false,
            error: `Did you mean ${suggestedEmail}? Please check your email spelling.`,
            suggestion: suggestedEmail,
        };
    }
    // 2. Reject reserved, dummy, and placeholder domains (like example.com)
    if (RESERVED_AND_TEST_DOMAINS.has(domain) ||
        domain.endsWith('.example') ||
        domain.endsWith('.test') ||
        domain.endsWith('.invalid') ||
        domain.endsWith('.localhost')) {
        return {
            valid: false,
            error: 'Placeholder and test domains (such as example.com) are not accepted. Please enter your real email address.',
        };
    }
    // 3. Reject disposable / temporary email domains
    if (DISPOSABLE_DOMAINS.has(domain)) {
        return {
            valid: false,
            error: 'Disposable or temporary email addresses are not accepted for executive publications.',
        };
    }
    return { valid: true, email: trimmed };
}
/**
 * Check if domain has active MX records with a fast timeout
 */
async function checkDomainMxRecords(domain) {
    try {
        // 1500ms timeout so DNS check never slows down signup response
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ hasMx: true }), 1500));
        const lookupPromise = (async () => {
            try {
                const mxRecords = await dnsResolver.resolveMx(domain);
                if (!mxRecords || mxRecords.length === 0) {
                    return { hasMx: false, error: 'The email domain has no mail servers configured to receive emails.' };
                }
                return { hasMx: true };
            }
            catch (err) {
                // ENOTFOUND or ENODATA means domain doesn't exist or has no MX
                if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'ESERVFAIL') {
                    return { hasMx: false, error: 'The email domain does not exist or cannot receive emails.' };
                }
                // In local environments or if DNS is blocked (ECONNREFUSED), fail open gracefully
                return { hasMx: true };
            }
        })();
        return await Promise.race([lookupPromise, timeoutPromise]);
    }
    catch {
        return { hasMx: true };
    }
}
/**
 * Comprehensive async email validation:
 * 1. Syntax & RFC checks
 * 2. Typo detector
 * 3. Disposable email blocklist
 * 4. DNS MX record verification (zero cost, built-in)
 */
async function validateNewsletterEmailStrict(emailStr) {
    // Step 1: Basic synchronous format, typo & disposable validation
    const basic = validateEmailBasic(emailStr);
    if (!basic.valid || !basic.email) {
        return basic;
    }
    const domain = basic.email.split('@')[1];
    // Bypass DNS check in test environments
    if (process.env.NODE_ENV === 'test' || domain === 'example.com') {
        return basic;
    }
    // Step 2: DNS MX record check
    const mxResult = await checkDomainMxRecords(domain);
    if (!mxResult.hasMx) {
        return {
            valid: false,
            error: mxResult.error || 'The email domain cannot receive emails. Please verify your address.',
        };
    }
    return basic;
}
