"""mock_sequences.json feeds the UI projection tests; it must match the real script.

Regenerate with: python scripts/gen_fixtures.py
"""

import json

from scripts.gen_fixtures import CASES, build

from .conftest import REPO

FIXTURE = REPO / "packages" / "schemas" / "fixtures" / "mock_sequences.json"


def test_mock_sequence_fixture_in_sync():
    on_disk = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert set(on_disk) == set(CASES)
    assert on_disk == build(), f"stale {FIXTURE.name}: run python scripts/gen_fixtures.py"
