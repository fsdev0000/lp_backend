"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerSpec = void 0;
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Leaders Performance API',
            version: '1.0.0',
            description: 'API documentation for the Leaders Performance Backend Middleware.',
        },
        servers: [
            {
                url: '/api/v1',
                description: 'V1 API',
            },
        ],
    },
    apis: process.env.NODE_ENV === 'production'
        ? ['./dist/api/routes/*.js']
        : ['./src/api/routes/*.ts'], // Scan src in dev, dist only in production
};
exports.swaggerSpec = (0, swagger_jsdoc_1.default)(swaggerOptions);
