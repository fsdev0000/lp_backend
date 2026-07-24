# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies using BuildKit cache
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy Prisma schema
COPY prisma ./prisma/

# Generate Prisma client
RUN npx prisma generate

# Copy only required source files
COPY src ./src
COPY tsconfig.json ./

# Build the backend
RUN npm run build

# Production dependencies stage
FROM node:22-alpine AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies using BuildKit cache
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Copy Prisma schema
COPY prisma ./prisma/

# Generate Prisma client for production (using npx without prompt)
RUN npx --yes prisma generate

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy production dependencies and generated Prisma client
COPY --from=deps /app/node_modules ./node_modules

# Copy built code from builder
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# Copy Prisma schema for migrations or runtime reference
COPY prisma ./prisma/

# Set environment to production
ENV NODE_ENV=production
# Application reads PORT from environment
ENV PORT=4000

# Expose the application port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start the application
CMD ["npm", "start"]
