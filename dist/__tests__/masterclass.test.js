"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const masterclass_1 = require("../api/routes/masterclass");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use('/masterclass', masterclass_1.masterclassRouter);
app.use('/api/v1/masterclass', masterclass_1.masterclassRouter);
(0, globals_1.describe)('Masterclass API & Recognition Endpoints', () => {
    (0, globals_1.beforeEach)(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_mock_stripe_key';
        process.env.FRONTEND_URL = 'https://leadersperformance.ae';
    });
    (0, globals_1.describe)('Stage 1: Identification, Validation & Registration', () => {
        (0, globals_1.it)('should reject identify request when email is missing or invalid', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/auth/identify')
                .send({ email: 'not-an-email' });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
        });
        (0, globals_1.it)('should reject session creation with missing required fields', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/create-session')
                .send({
                email: 'alexander@example.com',
                // missing fullName & company
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
            (0, globals_1.expect)(res.body.details).toHaveProperty('fullName');
            (0, globals_1.expect)(res.body.details).toHaveProperty('company');
        });
        (0, globals_1.it)('should require session_id in verify-payment endpoint', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/masterclass/verify-payment');
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('MISSING_SESSION_ID');
        });
        (0, globals_1.it)('should require session_id in payment-status endpoint', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/masterclass/payment-status');
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('MISSING_SESSION_ID');
        });
    });
    (0, globals_1.describe)('Stage 2: Curriculum & Draft Auto-Saving', () => {
        (0, globals_1.it)('should return masterclass modules curriculum and structure', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/masterclass/modules');
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.totalModules).toBe(4);
            (0, globals_1.expect)(res.body.modules).toHaveLength(4);
            (0, globals_1.expect)(res.body.modules[0].stageNumber).toBe(1);
            (0, globals_1.expect)(res.body.modules[0].title).toBe('Define the Next Stage');
            (0, globals_1.expect)(res.body.modules[3].stageNumber).toBe(4);
            (0, globals_1.expect)(res.body.modules[3].title).toBe('Your Next Move');
        });
        (0, globals_1.it)('should reject saving draft with missing email or invalid stage', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/save-draft')
                .send({
                email: 'not-valid',
                currentStage: 99, // exceeds 4
                formData: {},
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
        });
        (0, globals_1.it)('should reject draft fetch when email parameter is missing', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/masterclass/draft');
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('MISSING_EMAIL');
        });
        (0, globals_1.it)('should reject draft save when an answer exceeds 1,000 characters', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/save-draft')
                .send({
                email: 'alexander@example.com',
                currentStage: 1,
                formData: {
                    stage1_nextStage: 'A'.repeat(1001),
                },
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
        });
    });
    (0, globals_1.describe)('Stage 3: Workbook Submission & Storage Validation', () => {
        (0, globals_1.it)('should reject workbook submission when required fields are missing', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/submit-workbook')
                .send({
                participantDetails: {
                    fullName: 'Alexander Wright',
                    email: 'alexander@example.com',
                    company: 'Apex Dynamics',
                },
                formData: {
                    // Missing all stage 1-4 fields
                    stage1_nextStage: '',
                },
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
        });
        (0, globals_1.it)('should reject workbook submission when an answer exceeds 1,000 characters', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/submit-workbook')
                .send({
                participantDetails: {
                    fullName: 'Alexander Wright',
                    email: 'alexander@example.com',
                    company: 'Apex Dynamics',
                },
                formData: {
                    stage1_nextStage: 'A'.repeat(1005),
                    stage1_possibility: 'Valid unlock',
                    stage1_strength: 'Valid strength',
                    stage2_changes: 'Valid changes',
                    stage2_demand1: 'Valid demand',
                    stage2_investment: 'Valid investment',
                    stage3_founderStrength: 'Valid standard',
                    stage3_teamStrength: 'Valid team standard',
                    stage3_orgStrength: 'Valid org standard',
                    stage4_priority90Days: 'Valid priority',
                    stage4_action7Days: 'Valid action',
                    stage4_evidence: 'Valid evidence',
                },
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
        });
    });
    (0, globals_1.describe)('Stage 4: 1-on-1 Strategic Review Available Slots & Booking', () => {
        (0, globals_1.it)('should return available strategic review slots and timezones', async () => {
            const res = await (0, supertest_1.default)(app)
                .get('/api/v1/masterclass/available-slots')
                .query({ timezone: 'GST (UTC+4)' });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.timezone).toBe('GST (UTC+4)');
            (0, globals_1.expect)(Array.isArray(res.body.availableSlots)).toBe(true);
            (0, globals_1.expect)(res.body.availableSlots.length).toBeGreaterThan(0);
            (0, globals_1.expect)(Array.isArray(res.body.timezones)).toBe(true);
        });
        (0, globals_1.it)('should reject booking slot when participant info is missing', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/book-slot')
                .send({
                email: 'alexander@example.com',
                // missing fullName, company, selectedSlot
            });
            (0, globals_1.expect)(res.status).toBe(400);
            (0, globals_1.expect)(res.body.success).toBe(false);
            (0, globals_1.expect)(res.body.error).toBe('VALIDATION_ERROR');
            (0, globals_1.expect)(res.body.details).toHaveProperty('fullName');
            (0, globals_1.expect)(res.body.details).toHaveProperty('company');
            (0, globals_1.expect)(res.body.details).toHaveProperty('selectedSlot');
        });
    });
    (0, globals_1.describe)('Stage 2: Dynamic Config, 4-Stage Questions & 6 Private Videos', () => {
        (0, globals_1.it)('should return masterclass dynamic config with 4 stages and 6 videos', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/masterclass/config');
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(Array.isArray(res.body.stages)).toBe(true);
            (0, globals_1.expect)(res.body.stages.length).toBe(4);
            (0, globals_1.expect)(Array.isArray(res.body.videos)).toBe(true);
            (0, globals_1.expect)(res.body.videos.length).toBe(6);
            (0, globals_1.expect)(res.body.stages[0]).toHaveProperty('questions');
        });
        (0, globals_1.it)('should allow POST /config with email', async () => {
            const res = await (0, supertest_1.default)(app)
                .post('/api/v1/masterclass/config')
                .send({ email: 'newfounder@company.com' });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.userExists).toBe(false);
            (0, globals_1.expect)(Array.isArray(res.body.videos)).toBe(true);
            (0, globals_1.expect)(Array.isArray(res.body.stages)).toBe(true);
        });
        (0, globals_1.it)('should return 6 video objects with private signed URLs from GET /videos', async () => {
            const res = await (0, supertest_1.default)(app).get('/api/v1/masterclass/videos');
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.totalVideos).toBe(6);
            (0, globals_1.expect)(res.body.videos).toHaveLength(6);
            (0, globals_1.expect)(res.body.videos[1].fileName).toBe('STAGE-01.mp4');
            (0, globals_1.expect)(res.body.videos[1].signedUrl).toContain('supabase.co');
        });
        (0, globals_1.it)('should allow updating masterclass questions via PUT /config/questions', async () => {
            const res = await (0, supertest_1.default)(app)
                .put('/api/v1/masterclass/config/questions')
                .send({ reflectionPauseDurationSeconds: 45 });
            (0, globals_1.expect)(res.status).toBe(200);
            (0, globals_1.expect)(res.body.success).toBe(true);
            (0, globals_1.expect)(res.body.config.reflectionPauseDurationSeconds).toBe(45);
        });
    });
});
