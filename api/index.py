"""The single Vercel serverless function.

Routing note, because this bit is not obvious:

Vercel rewrites every /api/* request to this one function and does NOT preserve
the original path -- the function always sees "/api/index". So vercel.json passes
the real path along as ?__path=<rest> and RestoreApiPath puts it back before
FastAPI routes the request. That keeps every route below declared with the plain
URL the browser actually calls ("/api/health"), and it does not depend on any
Vercel runtime behaviour we can't see.

The server keeps no state. Vercel functions do not share memory between requests,
so the browser holds the SheetModel and sends back whatever context a call needs.
"""

import io
import os
import sys
import urllib.parse
from pathlib import Path

# Vercel imports this file as "api.index" with the project root on sys.path, so
# "_lib" is not importable by default. Put this file's own directory first, which
# makes "from _lib.x import y" work identically here, in tests, and on Vercel.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, File, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from _lib import attention  # noqa: E402
from _lib.explain import explain as explain_cell  # noqa: E402
from _lib.explain import template as explain_template  # noqa: E402
from _lib.extract import extract  # noqa: E402
from _lib.models import ExplainRequest, HealthResponse, OverviewFacts, TextResponse  # noqa: E402
from _lib.overview import overview_for, polish_overview  # noqa: E402

# Vercel rejects request bodies over about 4.5 MB before our code ever runs, so
# say something useful a little before that rather than letting it fail opaquely.
MAX_UPLOAD_BYTES = 4_000_000


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


def _spoken_error(message: str, status: int = 400) -> JSONResponse:
    """Errors are read aloud, so they are sentences, not codes."""
    return JSONResponse({"error": message}, status_code=status)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness check. `llm` says whether an API key is configured, never what it is."""
    return HealthResponse(ok=True, llm=bool(os.environ.get("ANTHROPIC_API_KEY")))


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """A spreadsheet in, a SheetModel out: cells, cues and the spoken overview.

    Nothing here may fail in a way the user cannot hear. Every failure returns a
    sentence the browser can speak, never a stack trace or a bare status code.
    """
    name = (file.filename or "").lower()
    if not name.endswith((".xlsx", ".xlsm")):
        return _spoken_error(
            "That file is not an Excel workbook. Please choose an .xlsx file."
        )

    try:
        contents = await file.read()
    except Exception:
        return _spoken_error("I could not read that file. Please try again.")

    if not contents:
        return _spoken_error("That file is empty.")
    if len(contents) > MAX_UPLOAD_BYTES:
        megabytes = len(contents) / 1_000_000
        return _spoken_error(
            f"That file is {megabytes:.0f} megabytes, which is too large to upload. "
            "The limit is about 4 megabytes.",
            status=413,
        )

    try:
        model, step_word = extract(io.BytesIO(contents))
    except Exception:
        return _spoken_error(
            "I could not open that spreadsheet. It may be password protected, "
            "or saved in an older Excel format. Try re-saving it as .xlsx."
        )

    if not model.cells:
        return _spoken_error("That sheet appears to be empty.")

    try:
        model.attention_order = attention.apply_signals(
            model.cells,
            header_row=model.header_row,
            label_col=model.label_col,
            step_word=step_word,
        )
    except Exception:
        # A sheet we cannot analyse is still a sheet the user can explore.
        model.attention_order = []

    try:
        model.series_cols = attention.main_series_columns(
            model.cells, model.header_row, model.label_col)
    except Exception:
        model.series_cols = []

    try:
        model.overview = overview_for(model)
    except Exception:
        model.overview = f"{model.title}. {model.n_rows} rows by {model.n_cols} columns."

    return model


@app.get("/api/upload")
def upload_hint():
    """A GET here is almost always someone testing the URL by hand."""
    return _spoken_error("Send a spreadsheet to this address with a POST request.", 405)


@app.post("/api/explain", response_model=TextResponse)
def explain(request: ExplainRequest) -> TextResponse:
    """UNDERSTAND: why this cell was flagged, in a sentence or two.

    The browser already holds the SheetModel, so it sends the one cell and its row
    context. Falls back to the template on any failure, including no API key.
    """
    try:
        return explain_cell(request)
    except Exception:
        try:
            return TextResponse(text=explain_template(request), source="template")
        except Exception:
            return TextResponse(text="I cannot explain this cell.", source="template")


@app.post("/api/overview", response_model=TextResponse)
def overview(facts: OverviewFacts) -> TextResponse:
    """ORIENT, polished. The browser already has the template version from upload
    and swaps this in only if it arrives in time."""
    try:
        return polish_overview(facts)
    except Exception:
        return TextResponse(text="", source="template")
