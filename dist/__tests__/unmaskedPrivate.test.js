"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const unmaskedPrivate_1 = require("../api/routes/unmaskedPrivate");
const unmaskedPrivateService_1 = require("../services/unmaskedPrivateService");
const app = (0, express_1.default)();
app.set('trust proxy', 1);
app.use(express_1.default.json());
app.use('/api/unmasked-private', unmaskedPrivate_1.unmaskedPrivateRouter);
app.use('/api/v1/unmasked-private', unmaskedPrivate_1.unmaskedPrivateRouter);
(0, globals_1.describe)('UNMASKED PRIVATE API & Dynamic Questionnaire (/api/unmasked-private)', () => {
    const originalFetch = global.fetch;
    (0, globals_1.beforeEach)(() => {
        (0, unmaskedPrivateService_1.clearRecentSubmissions)();
        (0, unmaskedPrivateService_1.clearQuestionnaireCache)();
        globals_1.jest.clearAllMocks();
        process.env.GHL_BASE = 'https://services.leadconnectorhq.com';
        process.env.GHL_API_KEY = 'pit-mock-test-key';
        process.env.GHL_LOCATION_ID = 'mock-location-id';
        const mockFetch = globals_1.jest.fn().mockImplementation((url) => {
            const urlStr = String(url);
            if (urlStr.includes('/contacts/upsert')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ contact: { id: 'mock-contact-123' } }),
                });
            }
            if (urlStr.includes('/conversations/messages')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ messageId: 'mock-msg-123' }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            });
        });
        global.fetch = mockFetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });
    const validQualifiedPayload = {
        step1: {
            fullName: 'Alexander Vance',
            email: 'a.vance@example.com',
            phone: '+971 50 123 4567',
            companyName: 'Vance Holding Ltd',
            companyWebsite: 'https://vanceholding.com',
            role: 'Managing Director',
            cityAndCountry: 'Dubai, United Arab Emirates',
        },
        step2: {
            businessResult: 'Decoupling founder dependency and establishing operational governance.',
            attentionNow: 'Expanding to secondary markets requires autonomous operational cadence.',
            outcome90Days: 'Executive team takes 100% ownership of operating margins and hiring.',
            attemptedAlready: 'Appointed general manager but decision bottlenecks persisted.',
        },
        step3: {
            decisionInfluence: 'Tendency to micromanage tactical deliveries during high-pressure cycles.',
            challengeView: 'CTO proposed architectural shift which I initially resisted then endorsed.',
            authorityToAct: 'Yes',
            investmentReadiness: 'FROM_15K_TO_20K',
            availableForCall: 'Yes',
        },
        consent: {
            privacyConsent: true,
            privacyPolicyVersion: '2026.1',
        },
        tracking: {
            utm_source: 'linkedin',
            utm_medium: 'ad',
            utm_campaign: 'q1_private',
        },
    };
    (0, globals_1.describe)('1. Dynamic Questionnaire Endpoint (GET & PUT /questions)', () => {
        (0, globals_1.it)('should return 200 OK and concise Step 2 and Step 3 questionnaire definition from DB', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/unmasked-private/questions');
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.questionnaire).toBeDefined();
            // Verify Step 1 is NOT in the database questionnaire (it is rendered statically on frontend)
            (0, globals_1.expect)(res.body.questionnaire.step1).toBeUndefined();
            // Verify Step 2 (Your Result)
            const step2 = res.body.questionnaire.step2;
            (0, globals_1.expect)(step2).toBeDefined();
            (0, globals_1.expect)(step2.title).toBe('Your Result');
            const step2QuestionIds = step2.questions.map((q) => q.id);
            (0, globals_1.expect)(step2QuestionIds).toEqual([
                'businessResult',
                'attentionNow',
                'outcome90Days',
                'attemptedAlready',
            ]);
            // Verify Step 3 (Your Readiness)
            const step3 = res.body.questionnaire.step3;
            (0, globals_1.expect)(step3).toBeDefined();
            (0, globals_1.expect)(step3.title).toBe('Your Readiness');
            const step3QuestionIds = step3.questions.map((q) => q.id);
            (0, globals_1.expect)(step3QuestionIds).toEqual([
                'decisionInfluence',
                'challengeView',
                'authorityToAct',
                'investmentReadiness',
                'availableForCall',
            ]);
            // Verify investment readiness options in Step 3
            const invQuestion = step3.questions.find((q) => q.id === 'investmentReadiness');
            (0, globals_1.expect)(invQuestion.options).toHaveLength(6);
            (0, globals_1.expect)(invQuestion.options[0].value).toBe('UP_TO_5K');
            (0, globals_1.expect)(invQuestion.options[5].value).toBe('VALUE_DEPENDENT');
        });
        (0, globals_1.it)('should also be accessible via /api/v1/unmasked-private/questions', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/unmasked-private/questions');
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.questionnaire.step2).toBeDefined();
            (0, globals_1.expect)(res.body.questionnaire.step3).toBeDefined();
        });
    });
    (0, globals_1.describe)('2. Success Responses & Routing Logic (/apply)', () => {
        (0, globals_1.it)('should return 200 OK and PENDING_PERSONAL_REVIEW for qualified investment (AED 15k - 20k)', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/unmasked-private/apply')
                .send(validQualifiedPayload);
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.outcome).toBe('PENDING_PERSONAL_REVIEW');
            (0, globals_1.expect)(res.body.redirectUrl).toBe('/unmasked-private/thank-you');
            (0, globals_1.expect)(res.body.referenceNumber).toMatch(/^UNM-\d{4}-\d{4}$/);
            (0, globals_1.expect)(res.body.applicationId).toMatch(/^unm_app_/);
        });
        (0, globals_1.it)('should return 200 OK and PENDING_PERSONAL_REVIEW for VALUE_DEPENDENT answer', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: {
                    ...validQualifiedPayload.step1,
                    email: 'value.dependent@example.com',
                },
                step3: {
                    ...validQualifiedPayload.step3,
                    investmentReadiness: 'VALUE_DEPENDENT',
                },
            };
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/unmasked-private/apply')
                .send(payload);
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.outcome).toBe('PENDING_PERSONAL_REVIEW');
            (0, globals_1.expect)(res.body.redirectUrl).toBe('/unmasked-private/thank-you');
        });
        (0, globals_1.it)('should accept human-readable string for investment option and route properly', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: {
                    ...validQualifiedPayload.step1,
                    email: 'human.readable@example.com',
                },
                step3: {
                    ...validQualifiedPayload.step3,
                    investmentReadiness: 'AED 20,000 or more',
                },
            };
            const res = await (0, supertest_1.default)(app)
                .post('/api/unmasked-private/apply')
                .send(payload);
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.outcome).toBe('PENDING_PERSONAL_REVIEW');
        });
        (0, globals_1.it)('should return 200 OK and BELOW_INVESTMENT_THRESHOLD for UP_TO_5K', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: {
                    ...validQualifiedPayload.step1,
                    email: 'budget@example.com',
                },
                step3: {
                    ...validQualifiedPayload.step3,
                    investmentReadiness: 'UP_TO_5K',
                },
            };
            const res = await (0, supertest_1.default)(app)
                .post('/api/unmasked-private/apply')
                .send(payload);
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.outcome).toBe('BELOW_INVESTMENT_THRESHOLD');
            (0, globals_1.expect)(res.body.redirectUrl).toBe('/unmasked-private/not-ready-yet');
            (0, globals_1.expect)(res.body.referenceNumber).toMatch(/^UNM-\d{4}-\d{4}$/);
        });
        (0, globals_1.it)('should return 200 OK and BELOW_INVESTMENT_THRESHOLD for FROM_5K_TO_10K', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: {
                    ...validQualifiedPayload.step1,
                    email: 'under10k@example.com',
                },
                step3: {
                    ...validQualifiedPayload.step3,
                    investmentReadiness: 'FROM_5K_TO_10K',
                },
            };
            const res = await (0, supertest_1.default)(app)
                .post('/api/unmasked-private/apply')
                .send(payload);
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.outcome).toBe('BELOW_INVESTMENT_THRESHOLD');
            (0, globals_1.expect)(res.body.redirectUrl).toBe('/unmasked-private/not-ready-yet');
        });
    });
    (0, globals_1.describe)('3. Exact Validation Error Messages (400 Bad Request)', () => {
        (0, globals_1.it)('should reject when fullName is missing or too short', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, fullName: 'A' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
            (0, globals_1.expect)(res.body.fields['step1.fullName']).toBe('Please enter your full name.');
        });
        (0, globals_1.it)('should reject when email is invalid', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, email: 'not-an-email' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step1.email']).toBe('Please enter your work email.');
        });
        (0, globals_1.it)('should reject when phone is missing or too short', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, phone: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step1.phone']).toBe('Please enter your mobile or WhatsApp number.');
        });
        (0, globals_1.it)('should reject when companyName is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, companyName: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step1.companyName']).toBe('Please enter your company name.');
        });
        (0, globals_1.it)('should reject when role is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, role: '', roleTitle: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step1.role']).toBe('Please enter your role.');
        });
        (0, globals_1.it)('should reject when cityAndCountry is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, cityAndCountry: '', location: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step1.cityAndCountry']).toBe('Please enter your city and country.');
        });
        (0, globals_1.it)('should reject when Step 2 businessResult is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step2: { ...validQualifiedPayload.step2, businessResult: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step2.businessResult']).toBe('This field is required.');
        });
        (0, globals_1.it)('should reject when Step 2 attentionNow is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step2: { ...validQualifiedPayload.step2, attentionNow: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step2.attentionNow']).toBe('This field is required.');
        });
        (0, globals_1.it)('should reject when Step 2 outcome90Days is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step2: { ...validQualifiedPayload.step2, outcome90Days: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step2.outcome90Days']).toBe('This field is required.');
        });
        (0, globals_1.it)('should reject when Step 3 decisionInfluence is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step3: { ...validQualifiedPayload.step3, decisionInfluence: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step3.decisionInfluence']).toBe('This field is required.');
        });
        (0, globals_1.it)('should reject when Step 3 challengeView is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step3: { ...validQualifiedPayload.step3, challengeView: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step3.challengeView']).toBe('This field is required.');
        });
        (0, globals_1.it)('should reject when Step 3 authorityToAct is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step3: { ...validQualifiedPayload.step3, authorityToAct: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step3.authorityToAct']).toBe('Please select an option.');
        });
        (0, globals_1.it)('should reject when Step 3 investmentReadiness is invalid', async () => {
            const payload = {
                ...validQualifiedPayload,
                step3: { ...validQualifiedPayload.step3, investmentReadiness: 'INVALID_INVESTMENT' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step3.investmentReadiness']).toBe('Please select an option.');
        });
        (0, globals_1.it)('should reject when Step 3 availableForCall is missing', async () => {
            const payload = {
                ...validQualifiedPayload,
                step3: { ...validQualifiedPayload.step3, availableForCall: '' },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['step3.availableForCall']).toBe('Please select an option.');
        });
        (0, globals_1.it)('should reject when privacyConsent is false', async () => {
            const payload = {
                ...validQualifiedPayload,
                consent: { privacyConsent: false },
            };
            const res = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.fields['consent.privacyConsent']).toBe('Please confirm your consent to continue.');
        });
    });
    (0, globals_1.describe)('4. Duplicate Submission Detection (409 Conflict)', () => {
        (0, globals_1.it)('should reject duplicate submission within the 24-hour window', async () => {
            const email = 'duplicate.check@example.com';
            const payload = {
                ...validQualifiedPayload,
                step1: { ...validQualifiedPayload.step1, email },
            };
            // First submission: Success
            const res1 = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res1.status).toBe(200);
            // Second submission with same email: 409 Conflict
            const res2 = await (0, supertest_1.default)(app).post('/api/unmasked-private/apply').send(payload);
            (0, globals_1.expect)(res2.status).toBe(409);
            (0, globals_1.expect)(res2.body.success).toBe(false);
            (0, globals_1.expect)(res2.body.error).toBe('DUPLICATE_SUBMISSION');
            (0, globals_1.expect)(res2.body.message).toBe('An application with this email has already been received and is currently under review.');
        });
    });
    (0, globals_1.describe)('5. Rate Limiting Protection (429 Too Many Requests)', () => {
        (0, globals_1.it)('should allow up to 5 requests per IP and block the 6th with 429', async () => {
            const testIp = '198.51.100.77';
            // Send 5 valid requests with distinct emails from same IP
            for (let i = 1; i <= 5; i++) {
                const payload = {
                    ...validQualifiedPayload,
                    step1: {
                        ...validQualifiedPayload.step1,
                        email: `executive_${i}@enterprise.ae`,
                    },
                };
                const res = await (0, supertest_1.default)(app)
                    .post('/api/unmasked-private/apply')
                    .set('x-forwarded-for', testIp)
                    .send(payload);
                (0, globals_1.expect)(res.status).toBe(200);
            }
            // 6th request from same IP within the hour: 429 Too Many Requests
            const payload6 = {
                ...validQualifiedPayload,
                step1: {
                    ...validQualifiedPayload.step1,
                    email: 'executive_6@enterprise.ae',
                },
            };
            const res6 = await (0, supertest_1.default)(app)
                .post('/api/unmasked-private/apply')
                .set('x-forwarded-for', testIp)
                .send(payload6);
            (0, globals_1.expect)(res6.status).toBe(429);
            (0, globals_1.expect)(res6.body.error).toBe('TOO_MANY_REQUESTS');
        });
    });
    (0, globals_1.describe)('6. Email Template Generator (buildUnmaskedBriefingEmail)', () => {
        (0, globals_1.it)('should correctly format and populate all questionnaire fields in executive HTML briefing email', () => {
            const { subject, html } = (0, unmaskedPrivateService_1.buildUnmaskedBriefingEmail)({
                participantName: 'Alexander Vance',
                email: 'a.vance@example.com',
                phone: '+971 50 123 4567',
                companyName: 'Vance Holding Ltd',
                companyWebsite: 'https://vanceholding.com',
                roleTitle: 'Managing Director',
                cityAndCountry: 'Dubai, UAE',
                investmentReadiness: 'FROM_15K_TO_20K',
                referenceNumber: 'UNM-2026-9999',
                submittedAt: '02 Oct 2026 14:00 GST',
                reviewUrl: 'https://app.gohighlevel.com/contact/123',
                businessResult: 'Decoupling founder dependency and operational scale',
                attentionNow: 'Expanding to regional markets',
                outcome90Days: 'Autonomous management team ownership',
                attemptedAlready: 'Previous management hire was insufficient',
                decisionInfluence: 'Tendency to hold all strategic approvals',
                challengeView: 'CTO altered core product roadmap after debate',
                authorityToAct: 'Yes',
                availableForCall: 'Yes',
            });
            (0, globals_1.expect)(subject).toContain('Alexander Vance');
            (0, globals_1.expect)(subject).toContain('Vance Holding Ltd');
            (0, globals_1.expect)(subject).toContain('UNM-2026-9999');
            // Verify HTML content
            (0, globals_1.expect)(html).toContain('Alexander Vance');
            (0, globals_1.expect)(html).toContain('a.vance@example.com');
            (0, globals_1.expect)(html).toContain('+971 50 123 4567');
            (0, globals_1.expect)(html).toContain('Vance Holding Ltd');
            (0, globals_1.expect)(html).toContain('https://vanceholding.com');
            (0, globals_1.expect)(html).toContain('Managing Director');
            (0, globals_1.expect)(html).toContain('Dubai, UAE');
            (0, globals_1.expect)(html).toContain('Decoupling founder dependency and operational scale');
            (0, globals_1.expect)(html).toContain('Expanding to regional markets');
            (0, globals_1.expect)(html).toContain('Autonomous management team ownership');
            (0, globals_1.expect)(html).toContain('Tendency to hold all strategic approvals');
            (0, globals_1.expect)(html).toContain('CTO altered core product roadmap after debate');
            (0, globals_1.expect)(html).toContain('AED 15,000');
        });
    });
});
