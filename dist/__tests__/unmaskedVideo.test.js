"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const unmaskedPrivate_1 = require("../api/routes/unmaskedPrivate");
const supabaseStorageService_1 = require("../services/supabaseStorageService");
const app = (0, express_1.default)();
app.set('trust proxy', 1);
app.use(express_1.default.json());
app.use('/api/unmasked-private', unmaskedPrivate_1.unmaskedPrivateRouter);
app.use('/api/v1/unmasked-private', unmaskedPrivate_1.unmaskedPrivateRouter);
(0, globals_1.describe)('UNMASKED PRIVATE Video Signed URL API (/api/v1/unmasked-private/video-url)', () => {
    const MOCK_SIGNED_URL = 'https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/sign/unmasked-private/unmasked-private.mp4?token=mock_signed_token_12345';
    let mockCreateSignedUrl;
    (0, globals_1.beforeEach)(() => {
        globals_1.jest.clearAllMocks();
        (0, supabaseStorageService_1.resetSupabaseStorageClient)();
        process.env.SUPABASE_URL = 'https://tpyudbsbzrhhngulxyxp.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key-test-env';
        mockCreateSignedUrl = globals_1.jest.fn().mockImplementation((path, expiresIn) => {
            if (path === supabaseStorageService_1.UNMASKED_VIDEO_OBJECT) {
                return Promise.resolve({
                    data: { signedUrl: MOCK_SIGNED_URL },
                    error: null,
                });
            }
            return Promise.resolve({
                data: null,
                error: { message: 'The resource was not found', status: 404 },
            });
        });
        const mockStorage = {
            from: globals_1.jest.fn().mockImplementation((bucket) => {
                if (bucket === supabaseStorageService_1.UNMASKED_BUCKET) {
                    return { createSignedUrl: mockCreateSignedUrl };
                }
                return {
                    createSignedUrl: globals_1.jest.fn().mockResolvedValue({
                        data: null,
                        error: { message: 'Bucket not found', status: 404 },
                    }),
                };
            }),
        };
        (0, supabaseStorageService_1.setMockSupabaseStorageClient)({ storage: mockStorage });
    });
    (0, globals_1.afterEach)(() => {
        (0, supabaseStorageService_1.resetSupabaseStorageClient)();
    });
    (0, globals_1.it)('1. Generates secure signed video URL with simple GET request (zero parameters required)', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/v1/unmasked-private/video-url');
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(res.body.videoUrl).toBe(MOCK_SIGNED_URL);
        (0, globals_1.expect)(mockCreateSignedUrl).toHaveBeenCalledWith(supabaseStorageService_1.UNMASKED_VIDEO_OBJECT, globals_1.expect.any(Number));
    });
    (0, globals_1.it)('2. Returns secure signed video URL on /unmasked-private/video-url alias', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/unmasked-private/video-url');
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(res.body.videoUrl).toBe(MOCK_SIGNED_URL);
    });
    (0, globals_1.it)('3. Handles missing video file in storage bucket safely with 404', async () => {
        mockCreateSignedUrl.mockResolvedValueOnce({
            data: null,
            error: { message: 'The resource was not found', status: 404 },
        });
        const res = await (0, supertest_1.default)(app).get('/api/v1/unmasked-private/video-url');
        (0, globals_1.expect)(res.status).toBe(404);
        (0, globals_1.expect)(res.body.success).toBe(false);
        (0, globals_1.expect)(res.body.error).toBe('VIDEO_NOT_FOUND');
        (0, globals_1.expect)(res.body.message).toMatch(/not exist/i);
    });
    (0, globals_1.it)('4. Handles generic Supabase storage failure safely with 502 Bad Gateway', async () => {
        mockCreateSignedUrl.mockResolvedValueOnce({
            data: null,
            error: { message: 'Supabase Storage internal server connection failure', status: 500 },
        });
        const res = await (0, supertest_1.default)(app).get('/api/v1/unmasked-private/video-url');
        (0, globals_1.expect)(res.status).toBe(502);
        (0, globals_1.expect)(res.body.success).toBe(false);
        (0, globals_1.expect)(res.body.error).toBe('STORAGE_ERROR');
        (0, globals_1.expect)(JSON.stringify(res.body)).not.toContain('mock-service-role-key');
    });
    (0, globals_1.it)('5. Never exposes service-role keys or internal credentials in API responses', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/v1/unmasked-private/video-url');
        const bodyString = JSON.stringify(res.body);
        (0, globals_1.expect)(bodyString).not.toContain('mock-service-role-key');
        (0, globals_1.expect)(bodyString).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        (0, globals_1.expect)(bodyString).not.toContain('SUPABASE_KEY');
        (0, globals_1.expect)(bodyString).not.toContain('service_role');
    });
});
