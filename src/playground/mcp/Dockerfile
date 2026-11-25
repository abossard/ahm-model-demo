# Build context: src/playground. The MCP server runs its TypeScript with tsx and serves the Views built here.
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
COPY views views
COPY mcp mcp
RUN npm run build -w @playground/views
ENV NODE_ENV=production PORT=8080 VIEWS_DIR=/app/views/dist
EXPOSE 8080
USER node
CMD ["node_modules/.bin/tsx", "mcp/src/main.ts"]
