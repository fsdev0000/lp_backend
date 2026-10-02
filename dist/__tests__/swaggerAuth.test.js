"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const swaggerAuth_1 = require("../middleware/swaggerAuth");
const app = (0, express_1.default)();
app.use('/test-protected', swaggerAuth_1.swaggerBasicAuth, (req, res) => {
    res.status(200).json({ access: 'granted' });
});
(0, globals_1.describe)('Swagger HTTP Basic Auth Middleware', () => {
    const originalUser = process.env.SWAGGER_USER;
    const originalPassword = process.env.SWAGGER_PASSWORD;
    beforeEach(() => {
        process.env.SWAGGER_USER = 'admin';
        process.env.SWAGGER_PASSWORD = 'Leaders2026!';
    });
    afterAll(() => {
        process.env.SWAGGER_USER = originalUser;
        process.env.SWAGGER_PASSWORD = originalPassword;
    });
    (0, globals_1.it)('should return 401 Unauthorized with WWW-Authenticate header when credentials are provided but invalid', async () => {
        const wrongAuth = 'Basic ' + Buffer.from('admin:wrongpassword').toString('base64');
        const res = await (0, supertest_1.default)(app)
            .get('/test-protected')
            .set('Authorization', wrongAuth);
        (0, globals_1.expect)(res.status).toBe(401);
        (0, globals_1.expect)(res.headers['www-authenticate']).toContain('Basic realm="Leaders Performance API Documentation"');
        (0, globals_1.expect)(res.text).toBe('Invalid credentials.');
    });
    (0, globals_1.it)('should return 200 OK when valid Basic Auth credentials are supplied', async () => {
        const validAuth = 'Basic ' + Buffer.from('admin:Leaders2026!').toString('base64');
        const res = await (0, supertest_1.default)(app)
            .get('/test-protected')
            .set('Authorization', validAuth);
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(res.body).toEqual({ access: 'granted' });
    });
    (0, globals_1.it)('should reject malformed base64 headers gracefully', async () => {
        const res = await (0, supertest_1.default)(app)
            .get('/test-protected')
            .set('Authorization', 'Basic malformed-without-colon');
        (0, globals_1.expect)(res.status).toBe(401);
        (0, globals_1.expect)(res.text).toBe('Invalid credentials format.');
    });
});
