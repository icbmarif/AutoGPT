"""Tests for the GoogleDriveFile pydantic model.

Pins the fix for SECRT-2269 (API / UI mismatch): the spreadsheet field
previously rejected a bare string ID when submitted via the API, while
the UI picker sent the full object. The before-validator now promotes
strings to {id: <str>} so both entry points succeed.
"""

import pytest
from pydantic import ValidationError

from backend.blocks.google._drive import GoogleDriveFile


def test_accepts_bare_string_as_file_id():
    """API callers send just the spreadsheet ID. The model promotes
    that to a full GoogleDriveFile so downstream code can keep treating
    the value as an object."""
    file = GoogleDriveFile.model_validate(
        "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
    )

    assert file.id == "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
    assert file.name is None
    assert file.mime_type is None
    assert file.credentials_id is None


def test_accepts_picker_object_with_credentials_id():
    """The UI picker sends the full object including ``_credentials_id``.
    That path must keep working — the API-side string-promotion fix
    must not break the picker's existing contract."""
    file = GoogleDriveFile.model_validate(
        {
            "id": "file-id-123",
            "name": "My Spreadsheet",
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "_credentials_id": "cred-abc-def",
        }
    )

    assert file.id == "file-id-123"
    assert file.name == "My Spreadsheet"
    assert file.mime_type == "application/vnd.google-apps.spreadsheet"
    assert file.credentials_id == "cred-abc-def"


def test_rejects_non_string_non_dict_values():
    """Non-string, non-dict values (e.g. integers, lists) must still
    fail loudly. Silent coercion would hide real validation errors."""
    with pytest.raises(ValidationError):
        GoogleDriveFile.model_validate(42)

    with pytest.raises(ValidationError):
        GoogleDriveFile.model_validate(["file-id"])
