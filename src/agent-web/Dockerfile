FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV COPILOTKIT_TELEMETRY_DISABLED=true
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production COPILOTKIT_TELEMETRY_DISABLED=true
WORKDIR /app
RUN groupadd --system --gid 10001 copilot \
  && useradd --system --uid 10001 --gid copilot copilot
COPY --from=build --chown=copilot:copilot /app/.next/standalone ./
COPY --from=build --chown=copilot:copilot /app/.next/static ./.next/static
USER 10001
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
