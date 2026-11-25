# Build context: src/playground. The host server runs its TypeScript with tsx, the page is built into host/dist.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json tsconfig.base.json ./
COPY contracts/package.json contracts/
COPY mcp/package.json mcp/
COPY host/package.json host/
COPY views/package.json views/
COPY e2e/package.json e2e/
RUN npm ci --no-audit --no-fund
COPY contracts contracts
COPY host host
RUN npm run build -w @playground/host
ENV NODE_ENV=production PORT=8080 WEB_DIR=/app/host/dist
EXPOSE 8080
USER node
CMD ["node_modules/.bin/tsx", "host/src/server/main.ts"]
