.DEFAULT_GOAL := help
SHELL := /bin/bash

WEB_PORT ?= 8080
AGENT_WEB_PORT ?= 3000
AGENT_APP_PORT ?= 8000
WEB_VENV ?= .venv-health-ui
WEB_PYTHON ?= $(WEB_VENV)/bin/python
# Must match the base image in src/web/Dockerfile and src/agent-app/Dockerfile so local runs
# on the same interpreter as the containers.
PYTHON_VERSION ?= 3.14

.PHONY: help env deps ui dev gate

gate:
	@scripts/local-env.sh > /dev/null

help:
	@echo "make dev   start web, agent-web and agent-app locally against the selected azd environment"
	@echo "make ui    build the SPA that web serves from src/web/ui/dist"
	@echo "make env   print the azd environment mapping without starting anything"
	@echo
	@echo "Requires a provisioned environment: run 'azd provision' first, then 'azd env select <name>'."
	@echo "web http://127.0.0.1:$(WEB_PORT), agent surface http://127.0.0.1:$(WEB_PORT)/agent"
	@echo
	@echo "Known local limitation: the request-journey route POST /api/demo-request cannot complete."
	@echo "Its Storage Queue is private-endpoint only (publicNetworkAccess Disabled), so it is"
	@echo "unreachable from a developer machine. Postgres and Azure OpenAI are reachable."
	@echo "'make dev' does not exit when a single service dies; check the log of the failing one."

env:
	@scripts/local-env.sh

deps:
	@set -e; \
	have="$$($(WEB_PYTHON) -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"; \
	want="$$(printf '%s' '$(PYTHON_VERSION)' | cut -d. -f1,2)"; \
	if [ -z "$$have" ]; then \
	  uv venv --python $(PYTHON_VERSION) $(WEB_VENV); \
	elif [ "$$have" != "$$want" ]; then \
	  printf 'VENV_MISMATCH %s is Python %s but PYTHON_VERSION=%s expects %s\n' \
	    '$(WEB_VENV)' "$$have" '$(PYTHON_VERSION)' "$$want" >&2; \
	  printf 'VENV_MISMATCH remove it and re-run: rm -rf %s && make deps\n' '$(WEB_VENV)' >&2; \
	  exit 1; \
	fi; \
	uv pip install --python $(WEB_PYTHON) --quiet --requirement src/web/requirements.txt; \
	[ -d src/web/ui/node_modules ] || npm --prefix src/web/ui ci --no-audit --no-fund; \
	[ -d src/agent-web/node_modules ] || npm --prefix src/agent-web ci --no-audit --no-fund

ui: deps
	@npm --prefix src/web/ui run build

dev: gate ui
	@set -e; \
	vars="$$(scripts/local-env.sh)"; \
	eval "$$vars"; \
	export HEALTH_COPILOT_ENABLED="true"; \
	export AGENT_WEB_ORIGIN="http://127.0.0.1:$(AGENT_WEB_PORT)"; \
	export AGENT_URL="http://127.0.0.1:$(AGENT_APP_PORT)/"; \
	export HEALTH_APP_BASE_URL="http://127.0.0.1:$(WEB_PORT)"; \
	set -m; \
	pids=""; \
	$(WEB_PYTHON) -m uvicorn --app-dir src/web/app \
	  --host 127.0.0.1 --port $(WEB_PORT) main:app & pids="$$pids $$!"; \
	uv run --project src/agent-app --python $(PYTHON_VERSION) --frozen python -m uvicorn \
	  --app-dir src/agent-app/src \
	  --host 127.0.0.1 --port $(AGENT_APP_PORT) main:app & pids="$$pids $$!"; \
	npm --prefix src/agent-web run dev & pids="$$pids $$!"; \
	trap 'for p in $$pids; do kill -- -$$p 2>/dev/null; done' INT TERM; \
	wait
