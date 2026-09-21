"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const contact_1 = require("../api/routes/contact");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use('/api', contact_1.contactRouter);
app.use('/api/v1', contact_1.contactRouter);
(0, globals_1.describe)('Contact Us API', () => {
    (0, globals_1.beforeEach)(() => {
        process.env.GHL_BASE = 'https://services.leadconnectorhq.com';
        process.env.GHL_API_KEY = 'pit-mock-test-key';
        process.env.GHL_LOCATION_ID = 'mock-location-id';
    });
    (0, globals_1.describe)('Validation', () => {
        (0, globals_1.it)('should reject requests with missing first name', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please provide your first name.');
        });
        (0, globals_1.it)('should reject requests with invalid email', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/contact')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'invalid-email',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toContain('Please provide a valid email address');
        });
        (0, globals_1.it)('should reject message that is too short', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact-us')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                message: 'Short',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Description must be at least 10 characters.');
        });
        (0, globals_1.it)('should reject requests with missing company', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                role: 'CEO',
                email: 'john@example.com',
                preferred_contact_method: 'Email',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please provide your company or organisation.');
        });
        (0, globals_1.it)('should reject requests with missing role', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                company: 'Acme Corp',
                email: 'john@example.com',
                preferred_contact_method: 'Email',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please provide your role or title.');
        });
        (0, globals_1.it)('should reject requests with first name containing numbers or symbols', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'John123',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('First name can only contain letters, spaces, hyphens, and apostrophes.');
        });
        (0, globals_1.it)('should reject requests with first name under 2 characters', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'J',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('First name must be at least 2 characters.');
        });
        (0, globals_1.it)('should reject requests with missing last name', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'John',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please provide your last name.');
        });
        (0, globals_1.it)('should reject requests with invalid phone characters', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                phone: 'abc-not-phone',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please provide a valid phone number (e.g. +971 50 123 4567).');
        });
        (0, globals_1.it)('should reject requests with invalid preferred contact method', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john@example.com',
                preferred_contact_method: 'Telegram',
                message: 'This is a valid enquiry message for testing.',
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('Please select a valid preferred contact method.');
        });
    });
    (0, globals_1.describe)('Successful submission with GHL mocked', () => {
        const originalFetch = global.fetch;
        (0, globals_1.afterEach)(() => {
            global.fetch = originalFetch;
        });
        (0, globals_1.it)('should accept snake_case payload and process successfully', async () => {
            const mockFetch = globals_1.jest.fn().mockImplementation((url) => {
                const urlStr = String(url);
                if (urlStr.includes('/contacts/upsert')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ contact: { id: 'mock-contact-123' } }),
                    });
                }
                if (url.includes('/conversations/messages')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ messageId: 'mock-msg-123' }),
                    });
                }
                return Promise.reject(new Error('Unknown URL: ' + url));
            });
            global.fetch = mockFetch;
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/contact')
                .send({
                first_name: 'John',
                last_name: 'Doe',
                company: 'Acme Corp',
                role: 'CEO',
                email: 'john.doe@example.com',
                phone: '+971 50 123 4567',
                preferred_contact_method: 'Email',
                message: 'Preparing for global business expansion and leadership realignment.',
            });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body).toEqual({ success: true, contactId: 'mock-contact-123' });
            (0, globals_1.expect)(mockFetch).toHaveBeenCalled();
        });
        (0, globals_1.it)('should accept camelCase payload (from React frontend form) and process successfully', async () => {
            const mockFetch = globals_1.jest.fn().mockImplementation((url) => {
                const urlStr = String(url);
                if (urlStr.includes('/contacts/upsert')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ contact: { id: 'mock-contact-456' } }),
                    });
                }
                if (url.includes('/conversations/messages')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ messageId: 'mock-msg-456' }),
                    });
                }
                return Promise.reject(new Error('Unknown URL: ' + url));
            });
            global.fetch = mockFetch;
            const res = await (0, supertest_1.default)(app)
                .post('/api/contact-us')
                .send({
                firstName: 'Lionel',
                lastName: 'Smith',
                company: 'Enterprise Partners',
                role: 'Managing Director',
                email: 'lionel.smith@example.com',
                phone: '+971 50 987 6543',
                preferredContact: 'phone',
                preparingFor: 'Preparing for board-level strategic restructuring.',
            });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body).toEqual({ success: true, contactId: 'mock-contact-456' });
        });
    });
});
