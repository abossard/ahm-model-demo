FROM ghcr.io/astral-sh/uv:0.11.32 AS uv

FROM python:3.12.9-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"
WORKDIR /app
RUN groupadd --system --gid 10001 copilot \
  && useradd --system --uid 10001 --gid copilot copilot
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-cache
COPY --chown=copilot:copilot src ./src
USER 10001
EXPOSE 8000
ENV PYTHONPATH=/app/src AGENT_PORT=8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
