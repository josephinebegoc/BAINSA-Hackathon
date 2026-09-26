"""The single Vercel serverless function.

Routing note, because this bit is not obvious:

Vercel rewrites every /api/* request to this one function and does NOT preserve
the original path -- the function always sees "/api/index". So vercel.json passes
the real path along as ?__path=<rest> and RestoreApiPath puts it back before
FastAPI routes the request. That keeps every route below declared with the plain
URL the browser actually calls ("/api/health"), and it does not depend on any
Vercel runtime behaviour we can't see.

Phase 0 is deliberately just /api/health: get a green light on the live URL
before anything else is built on top of it.
"""

import os
import sys
import urllib.parse
from pathlib import Path

# Vercel imports this file as "api.index" with the project root on sys.path, so
# "_lib" is not importable by default. Put this file's own directory first, which
# makes "from _lib.x import y" work identically here, in tests, and on Vercel.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI  # noqa: E402  (needs the path above)

from _lib.models import HealthResponse  # noqa: E402


class RestoreApiPath:
    """Put the original /api/... path back on the request before routing."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            params = urllib.parse.parse_qs(scope.get("query_string", b"").decode())
            sub = params.pop("__path", [None])[0]
            if sub is not None:
                scope["path"] = "/api/" + sub.lstrip("/")
                scope["raw_path"] = scope["path"].encode()
                scope["query_string"] = urllib.parse.urlencode(params, doseq=True).encode()
        await self.app(scope, receive, send)


app = FastAPI(title="Accessible Attention for Excel")
app.add_middleware(RestoreApiPath)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness check. `llm` says whether an API key is configured, never what it is."""
    return HealthResponse(ok=True, llm=bool(os.environ.get("ANTHROPIC_API_KEY")))
