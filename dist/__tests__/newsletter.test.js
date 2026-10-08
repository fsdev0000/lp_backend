"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const newsletter_1 = require("../api/routes/newsletter");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use('/api/newsletter', newsletter_1.newsletterRouter);
(0, globals_1.describe)('Newsletter Subscription API', () => {
    globals_1.jest.setTimeout(15000);
    (0, globals_1.describe)('Email Validator Helper', () => {
        (0, globals_1.it)('should reject null or undefined email', () => {
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)(undefined).valid).toBe(false);
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)(null).valid).toBe(false);
        });
        (0, globals_1.it)('should reject empty or whitespace-only email', () => {
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)('').valid).toBe(false);
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)('   ').valid).toBe(false);
        });
        (0, globals_1.it)('should reject invalid email formats', () => {
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)('not-an-email').valid).toBe(false);
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)('john@').valid).toBe(false);
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)('@domain.com').valid).toBe(false);
            (0, globals_1.expect)((0, newsletter_1.validateNewsletterEmail)('john@domain').valid).toBe(false);
        });
        (0, globals_1.it)('should accept valid email formats and sanitize input', () => {
            const res = (0, newsletter_1.validateNewsletterEmail)('  FOUNDER@Company.Com  ');
            (0, globals_1.expect)(res.valid).toBe(true);
            (0, globals_1.expect)(res.email).toBe('founder@company.com');
        });
    });
    (0, globals_1.describe)('POST /api/newsletter/subscribe', () => {
        (0, globals_1.it)('should return 400 for empty request payload', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .send({});
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please enter your email address.');
        });
        (0, globals_1.it)('should return 400 for invalid email format', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .send({ email: 'invalid-email-address' });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toContain('Please enter a valid email address');
        });
        (0, globals_1.it)('should process a valid email subscription successfully', async () => {
            const testEmail = `test.founder.${Date.now()}@leadersperformance.ae`;
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: testEmail, consent: true });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.alreadySubscribed).toBe(false);
            (0, globals_1.expect)(res.body.message).toContain('Thank you for subscribing');
        });
        (0, globals_1.it)('should reject test/dummy domains like example.com', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: 'fake.user@example.com', consent: true });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toContain('Placeholder and test domains (such as example.com) are not accepted');
        });
        (0, globals_1.it)('should reject disposable/temporary email addresses', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: 'spammer@mailinator.com', consent: true });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toContain('Disposable or temporary email');
        });
        (0, globals_1.it)('should catch common domain typos and suggest correction', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: 'founder@gmial.com', consent: true });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toContain('Did you mean founder@gmail.com');
            (0, globals_1.expect)(res.body.suggestion).toBe('founder@gmail.com');
        });
        (0, globals_1.it)('should handle duplicate subscription gracefully without erroring out', async () => {
            const duplicateEmail = `duplicate.${Date.now()}@leadersperformance.ae`;
            // Initial subscription
            const res1 = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: duplicateEmail, consent: true });
            (0, globals_1.expect)(res1.status).toBe(200);
            (0, globals_1.expect)(res1.body.alreadySubscribed).toBe(false);
            // Duplicate subscription
            const res2 = await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: duplicateEmail, consent: true });
            (0, globals_1.expect)(res2.status).toBe(200);
            (0, globals_1.expect)(res2.body.success).toBe(true);
            (0, globals_1.expect)(res2.body.alreadySubscribed).toBe(true);
            (0, globals_1.expect)(res2.body.message).toContain('already subscribed');
        });
    });
    (0, globals_1.describe)('Unsubscribe API', () => {
        (0, globals_1.it)('should process unsubscribe request successfully', async () => {
            const unsubEmail = `unsub.${Date.now()}@leadersperformance.ae`;
            // First subscribe
            await (0, supertest_1.default)(app)
                .post('/api/newsletter/subscribe')
                .set('x-test-rate-limit', 'bypass')
                .send({ email: unsubEmail, consent: true });
            // Then unsubscribe
            const res = await (0, supertest_1.default)(app)
                .post('/api/newsletter/unsubscribe')
                .send({ email: unsubEmail });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.message).toContain('unsubscribed');
        });
    });
    (0, globals_1.describe)('Welcome Email Template', () => {
        (0, globals_1.it)('should verify welcome newsletter HTML template exists and contains required tags', () => {
            const templatePath = path_1.default.join(__dirname, '../../templates/welcome-newsletter.html');
            (0, globals_1.expect)(fs_1.default.existsSync(templatePath)).toBe(true);
            const content = fs_1.default.readFileSync(templatePath, 'utf8');
            (0, globals_1.expect)(content).toContain('The Founder Performance Newsletter');
            (0, globals_1.expect)(content).toContain('{{unsubscribe_url}}');
            (0, globals_1.expect)(content).toContain('Leaders Performance Management Consultancies');
        });
    });
});
