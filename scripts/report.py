"""Show what the software sees and says for any spreadsheet.

    ./.venv/bin/python scripts/report.py public/demo/sales_demo.xlsx

Prints what it detected, what it would speak on opening, every cell it flags with
the exact words, and -- just as important -- things it noticed but stays silent
about, so a gap is visible rather than invisible.
"""

import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

from _lib import attention                                    # noqa: E402
from _lib.explain import template as explain_template         # noqa: E402
from _lib.extract import extract                              # noqa: E402
from _lib.models import ExplainRequest                        # noqa: E402
from _lib.overview import overview_for                        # noqa: E402

CUE_NAMES = {"visual": "Author visual cue", "anomaly": "Statistical cue",
             "trend": "Pattern cue", "error": "Functional cue"}


def rule(title):
    print(f"\n{title}\n{'-' * len(title)}")


def main(path: str) -> None:
    model, step_word = extract(path)
    model.attention_order = attention.apply_signals(
        model.cells, header_row=model.header_row,
        label_col=model.label_col, step_word=step_word)
    model.overview = overview_for(model)
    by_ref = {c.ref: c for c in model.cells}

    print(f"\nFILE  {path}")

    rule("WHAT IT SEES")
    print(f"  sheet title    {model.title}")
    print(f"  shape          {model.n_rows} rows x {model.n_cols} columns")
    print(f"  header row     {model.header_row}")
    print(f"  label column   {model.label_col}  ({', '.join(model.row_labels[:4])}...)")
    print(f"  measures       {model.value_label or '(the sheet never says)'}")
    print(f"  steps are      {step_word or '(not a time series it recognises)'}")

    rule("WHAT IT SAYS WHEN THE FILE OPENS  (the O key)")
    for line in model.overview.split(". "):
        if line.strip():
            print(f"  {line.strip().rstrip('.')}.")

    rule(f"WHAT IT FLAGS  ({len(model.attention_order)} cells)")
    if not model.attention_order:
        print("  nothing")
    for ref in model.attention_order:
        cell = by_ref[ref]
        cues = ", ".join(CUE_NAMES.get(s.type, s.type) for s in cell.signals)
        spoken = ". ".join(p for p in (cell.row_label, cell.col_header,
                                       model.value_label.capitalize() or None,
                                       cell.display, cues) if p)
        row_values = [c.value for c in model.cells
                      if c.row == cell.row and c.col != model.label_col]
        why = explain_template(ExplainRequest(cell=cell, row_values=row_values,
                                              signals=cell.signals))
        print(f"\n  {ref}   {cell.row_label} / {cell.col_header}   {cell.display}")
        print(f"     cue     {cues}")
        print(f"     says    \"{spoken}.\"")
        print(f"     why (W) \"{why}\"")

    rule("NOTICED BUT NOT ANNOUNCED")
    said_something = False

    if not any(s.type == "anomaly" for c in model.cells for s in c.signals):
        found = attention.find_signals(
            [c.model_copy(update={"signals": []}) for c in model.cells],
            header_row=model.header_row, label_col=model.label_col,
            step_word=step_word, include_statistical=True)
        extra = [r for r, sigs in found.items()
                 if any(s.type == "anomaly" for s in sigs)
                 and r not in model.attention_order]
        if extra:
            said_something = True
            print("  Statistical cue is switched off. It would otherwise flag:")
            for ref in extra:
                c = by_ref[ref]
                detail = next(s.detail for s in found[ref] if s.type == "anomaly")
                print(f"    {ref}  {c.row_label} / {c.col_header}  {c.display}  -- {detail}")

    # Columns formatted unlike their neighbours: visible to a sighted user,
    # currently silent to a listener.
    body = [c for c in model.cells
            if c.row != model.header_row and c.col != model.label_col]
    for group in attention.comparable_axes(body, "col"):
        formats = Counter(c.number_format for c in body
                          if c.col in group and c.number_format)
        if len(formats) > 1:
            usual, _ = formats.most_common(1)[0]
            odd = sorted({c.col for c in body
                          if c.col in group and c.number_format not in (usual, None)})
            if odd:
                said_something = True
                print(f"\n  Columns formatted unlike the rest of their series "
                      f"(most are {usual!r}):")
                for col in odd:
                    sample = next(c for c in body if c.col == col)
                    print(f"    {model.col_headers[col - 1]:<16} {sample.number_format!r:<12} "
                          f"shows as {sample.display!r}")
                print("    -> a sighted reader sees this instantly. We say nothing.")

    if not said_something:
        print("  nothing")
    print()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/demo/sales_demo.xlsx")
