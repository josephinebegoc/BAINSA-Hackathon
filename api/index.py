"""The single Vercel serverless function.

vercel.json rewrites every /api/* path here, and the original path survives the
rewrite, so routes are declared with their full "/api/..." prefix.

Phase 0 is deliberately just /api/health: get a green light on the live URL
before anything else is built on top of it.
"""

import os

from fastapi import FastAPI

from _lib.models import HealthResponse

app = FastAPI(title="Accessible Attention for Excel")


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness check. `llm` says whether an API key is configured, never what it is."""
    return HealthResponse(ok=True, llm=bool(os.environ.get("ANTHROPIC_API_KEY")))
