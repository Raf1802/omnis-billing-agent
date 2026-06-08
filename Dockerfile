# Official Playwright image — ships Chromium + all system libs Playwright needs.
# Tag MUST match the playwright version in package.json (yours: 1.60.0), or
# Playwright can't locate browser executables at runtime.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install deps first for better build caching.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the app.
COPY . .

# Railway injects PORT at runtime; index.js reads process.env.PORT.
EXPOSE 3000

# Start the HTTP server (the consolidated index.js), NOT a test script.
CMD ["node", "src/index.js"]