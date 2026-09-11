from __future__ import annotations

import sys

import pytest

from kb.cli import main


def test_reprocess_command_is_removed(capsys: pytest.CaptureFixture[str]) -> None:
    sys.argv = ["kb", "--help"]
    with pytest.raises(SystemExit) as exc_info:
        main()

    assert exc_info.value.code == 0
    assert "reprocess" not in capsys.readouterr().out
