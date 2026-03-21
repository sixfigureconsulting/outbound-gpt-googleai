# Use the official Playwright image (includes Chromium + all OS deps)
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Expose port
EXPOSE 3000

# Start the web server
CMD ["node", "dist/server.js"]
