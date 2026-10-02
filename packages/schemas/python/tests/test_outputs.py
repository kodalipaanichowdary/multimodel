import json
from pathlib import Path

import pos_schemas
import pytest
from pos_schemas import Draft, ResearchResult
from pydantic import ValidationError

FIX = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "outputs.json").read_text())


@pytest.mark.parametrize(
    "case", FIX["valid"], ids=[f"{c['model']}-{i}" for i, c in enumerate(FIX["valid"])]
)
def test_valid(case):
    getattr(pos_schemas, case["model"]).model_validate(case["data"])


@pytest.mark.parametrize("case", FIX["invalid"], ids=[c["why"] for c in FIX["invalid"]])
def test_invalid(case):
    with pytest.raises(ValidationError):
        getattr(pos_schemas, case["model"]).model_validate(case["data"])


def test_research_sources_must_be_fetched():
    raw = json.dumps({"summary": "s", "sources": [{"url": "https://made.up/x"}], "confidence": 0.5})
    ResearchResult.model_validate_json(raw)  # no context: shape only
    with pytest.raises(ValidationError, match="not fetched"):
        ResearchResult.model_validate_json(raw, context={"fetched_urls": {"https://real.org/a"}})


def test_draft_citations_and_markers_checked_against_context():
    ctx = {"source_urls": {"https://a.org/1", "https://b.org/2"}, "n_sources": 2}
    Draft.model_validate_json(
        json.dumps({"answer": "X is Y [1]. Z [2].", "citations": ["https://a.org/1"]}), context=ctx
    )
    with pytest.raises(ValidationError, match="unknown"):
        Draft.model_validate_json(
            json.dumps({"answer": "X [1].", "citations": ["https://elsewhere.org"]}), context=ctx
        )
    with pytest.raises(ValidationError, match="out of range"):
        Draft.model_validate_json(
            json.dumps({"answer": "X [3].", "citations": ["https://a.org/1"]}), context=ctx
        )


def test_json_schema_is_exportable_for_constrained_decoding():
    for m in (pos_schemas.Plan, ResearchResult, Draft, pos_schemas.Verdict):
        s = m.model_json_schema()
        assert s["type"] == "object" and s.get("additionalProperties") is False
