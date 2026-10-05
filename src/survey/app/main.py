from contextlib import asynccontextmanager
from pathlib import Path
import time

import psycopg
from azure.core.exceptions import AzureError
from fastapi import FastAPI, Header
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .model import BallotPatch, Definition, Edit, SurveyError
from .telemetry import Telemetry


def create_app(storage=None, telemetry=None, static_dir=None):
    @asynccontextmanager
    async def lifespan(app):
        if storage is not None:
            yield
            return
        from .config import Config
        from .storage import Storage
        from .telemetry import configure
        config = Config.load()
        connect, database_credential = config.connection_factory()
        provider, monitor_credential = configure(config)
        app.state.storage = Storage(connect)
        app.state.telemetry = Telemetry(provider)
        try:
            yield
        finally:
            provider.shutdown()
            database_credential.close()
            monitor_credential.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.storage = storage
    app.state.telemetry = telemetry or Telemetry()

    @app.middleware("http")
    async def headers(request, call_next):
        started = time.time_ns()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
        finally:
            endpoint = request.scope.get("endpoint")
            operation = getattr(endpoint, "__name__", "invalid_route")
            app.state.telemetry.record(operation, status, started, time.time_ns())
        response.headers.update({
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        })
        return response

    @app.exception_handler(SurveyError)
    async def domain_error(request, error):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_payload(request, error):
        return JSONResponse({"error": {"code": "invalid_payload", "message": "Invalid survey payload. Check statements, IDs, versions and integer answers (0-100)."}}, status_code=422)

    @app.exception_handler(psycopg.Error)
    @app.exception_handler(AzureError)
    async def database_error(request, error):
        return JSONResponse({"error": {"code": "storage_unavailable", "message": "Survey storage is unavailable. Retain your key and retry."}}, status_code=503)

    @app.post("/api/surveys", status_code=201)
    def author_save(definition: Definition, authorization: str | None = Header(default=None)):
        return app.state.storage.create(definition, authorization)

    @app.get("/api/surveys/{code}")
    def join_read(code: str):
        return app.state.storage.read(code)

    @app.get("/api/surveys/{code}/editor")
    def author_read(code: str, authorization: str | None = Header(default=None)):
        return app.state.storage.read(code, authorization, editor=True)

    @app.put("/api/surveys/{code}")
    def author_save_update(code: str, definition: Edit, authorization: str | None = Header(default=None)):
        return app.state.storage.edit(code, definition, authorization)

    @app.get("/api/surveys/{code}/ballot")
    def ballot_read(code: str, authorization: str | None = Header(default=None)):
        return app.state.storage.ballot(code, authorization)

    @app.put("/api/surveys/{code}/ballot")
    def ballot_save(code: str, patch: BallotPatch, authorization: str | None = Header(default=None)):
        return app.state.storage.save(code, patch, authorization)

    @app.get("/api/surveys/{code}/results")
    def results_read(code: str):
        return app.state.storage.results(code)

    @app.get("/api/ready")
    def readiness():
        app.state.storage.ready()
        return {"ready": True}

    directory = Path(static_dir) if static_dir else Path(__file__).resolve().parents[1] / "ui/dist"
    if (directory / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=directory / "assets"), name="assets")

    @app.get("/{path:path}")
    def static(path: str):
        if path.startswith("api/"):
            return JSONResponse({"error": {"code": "not_found", "message": "Endpoint not found."}}, status_code=404)
        if not (directory / "index.html").is_file():
            return JSONResponse({"error": {"code": "ui_unavailable", "message": "Build the survey UI before serving it."}}, status_code=503)
        return FileResponse(directory / "index.html")

    return app


app = create_app()
