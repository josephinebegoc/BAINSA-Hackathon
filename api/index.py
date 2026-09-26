"""The single Vercel serverless function.

vercel.json rewrites every /api/* path here, and the original path survives the
rewrite, so routes are declared with their full "/api/..." prefix.

Phase 0 is deliberately just /api/health: get a green light on the live URL
before anything else is built on top of it.
"""

import os
import sys
from pathlib import Path

# Vercel imports this file as "api.index" with the project root on sys.path, so
# "_lib" is not importable by default. Put this file's own directory first, which
# makes "from _lib.x import y" work identically here, in tests, and on Vercel.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _lib.models import HealthResponse  # noqa: E402  (needs the path above)

from fastapi import FastAPI  # noqa: E402

app = FastAPI(title="Accessible Attention for Excel")


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness check. `llm` says whether an API key is configured, never what it is."""
    return HealthResponse(ok=True, llm=bool(os.environ.get("ANTHROPIC_API_KEY")))
