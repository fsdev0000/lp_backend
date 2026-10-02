"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerBasicAuth = swaggerBasicAuth;
/**
 * HTTP Basic Authentication Middleware for Swagger Documentation (/api-docs)
 *
 * Protects API documentation from public exposure.
 * Configurable via SWAGGER_USER and SWAGGER_PASSWORD environment variables.
 */
function swaggerBasicAuth(req, res, next) {
    // Allow test suites to bypass unless auth header is explicitly provided
    if (process.env.NODE_ENV === 'test' && !req.headers.authorization) {
        return next();
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Leaders Performance API Documentation"');
        return res.status(401).send('Authentication required to access API documentation.');
    }
    try {
        const base64Credentials = authHeader.split(' ')[1];
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const separatorIndex = credentials.indexOf(':');
        if (separatorIndex === -1) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Leaders Performance API Documentation"');
            return res.status(401).send('Invalid credentials format.');
        }
        const username = credentials.substring(0, separatorIndex);
        const password = credentials.substring(separatorIndex + 1);
        const expectedUser = process.env.SWAGGER_USER || 'admin';
        const expectedPassword = process.env.SWAGGER_PASSWORD || 'Leaders2026!';
        if (username === expectedUser && password === expectedPassword) {
            return next();
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="Leaders Performance API Documentation"');
        return res.status(401).send('Invalid credentials.');
    }
    catch (err) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Leaders Performance API Documentation"');
        return res.status(401).send('Authentication parsing error.');
    }
}
