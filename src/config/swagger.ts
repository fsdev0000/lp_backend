import swaggerJSDoc from 'swagger-jsdoc';

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

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
