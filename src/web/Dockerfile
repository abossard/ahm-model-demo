FROM node:26-bookworm-slim AS ui-build
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --requirement requirements.txt \
    && useradd --create-home --uid 10001 app
COPY app ./app
COPY --from=ui-build /ui/dist ./ui/dist
RUN chown -R app:app /app

USER app
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "--app-dir", "app", "--host", "0.0.0.0", "--port", "8080", "main:app"]
