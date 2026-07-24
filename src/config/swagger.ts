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
  apis: ['./src/api/routes/*.ts'], // Path to the API docs
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
