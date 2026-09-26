"""The shared contract.

Every part of the app agrees on these shapes: the engine produces a SheetModel,
the browser holds it, and /api/explain receives one cell out of it.

Only Margaux edits this file. If you need a new field, ask her.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

SignalType = Literal["visual", "anomaly", "trend", "error"]
Severity = Literal["high", "medium", "low"]


class Signal(BaseModel):
    """One reason a cell deserves attention.

    `detail` is a short human phrase, already spoken-English ready, because the
    template fallback for UNDERSTAND simply joins these together.
    """

    type: SignalType
    severity: Severity
    detail: str


class Cell(BaseModel):
    """One spreadsheet cell, including everything needed to speak it aloud."""

    ref: str                      # "G3"
    row: int                      # 1-based, matches Excel
    col: int                      # 1-based, matches Excel

    value: Any = None             # number, string, or None for empty
    display: str = ""             # "€82,400" — what we say and show

    row_label: str | None = None  # "Italy"
    col_header: str | None = None # "Jun"

    # The author's visual vocabulary. All of it is captured, whether or not our
    # rules flag the cell, because the user is entitled to ask about any of it.
    fill: str | None = None       # "FFFF0000", "unknown-non-default", or None
    font_color: str | None = None # "FFFF0000" when the author recoloured the text
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strike: bool = False
    bordered: bool = False        # any deliberate border on any side
    conditional: bool = False     # covered by a conditional formatting rule
    comment: str | None = None    # a sighted user sees the little marker

    number_format: str | None = None   # "General", "0.0%", '"€"#,##0'
    formula: str | None = None    # "=(M3-L3)/L3"
    error: str | None = None      # "#DIV/0!"

    signals: list[Signal] = Field(default_factory=list)


class SheetModel(BaseModel):
    """A whole worksheet, ready for the browser to render and narrate."""

    id: str
    title: str

    n_rows: int
    n_cols: int
    header_row: int               # 1-based row holding the column headers
    label_col: int                # 1-based column holding the row labels

    col_headers: list[str]        # includes the label column's own header
    row_labels: list[str]         # data rows only, in sheet order

    overview: str                 # ORIENT text, template version

    cells: list[Cell]
    attention_order: list[str]    # refs, severity first then reading order


# --- API request/response bodies -------------------------------------------
# The server is stateless, so the browser sends whatever context a call needs.


class ExplainRequest(BaseModel):
    """UNDERSTAND: one cell plus enough row context to explain it."""

    cell: Cell
    row_label: str | None = None
    col_header: str | None = None
    row_values: list[Any] = Field(default_factory=list)
    signals: list[Signal] = Field(default_factory=list)


class OverviewFacts(BaseModel):
    """ORIENT: computed facts only. The LLM never sees the raw grid."""

    title: str
    n_data_rows: int
    n_cols: int
    row_label_kind: str = "rows"          # "countries"
    first_col_header: str = ""
    last_col_header: str = ""
    direction: str = "stay flat"          # "rise" | "fall" | "stay flat"
    signal_counts: dict[str, int] = Field(default_factory=dict)


class TextResponse(BaseModel):
    """Both /api/explain and /api/overview answer with one spoken sentence."""

    text: str
    source: Literal["llm", "template"] = "template"


class HealthResponse(BaseModel):
    ok: bool = True
    llm: bool = False
