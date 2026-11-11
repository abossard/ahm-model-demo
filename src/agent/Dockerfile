# syntax=docker/dockerfile:1

FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

FROM python:3.14-slim-bookworm
ENV PYTHONNOUSERSITE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/session --shell /bin/bash session
WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock .python-version ./
RUN UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 uv sync --frozen --no-dev --no-cache
COPY src ./src
COPY skills ./skills
USER session
EXPOSE 8088
CMD ["python", "src/main.py"]
