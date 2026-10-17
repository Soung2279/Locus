"""Read immutable screenshot spatial data without expanding it into model context."""
from __future__ import annotations

import math
from typing import Any, TYPE_CHECKING
from ._scope import workspace_payload
if TYPE_CHECKING:
    from ._client import Client


def _coordinates(value: Any, length: int, label: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise ValueError(f"{label} requires {length} normalized coordinates")
    if any(isinstance(n, bool) or not isinstance(n, (float, int)) or not math.isfinite(n) or not 0 <= n <= 1 for n in value):
        raise ValueError(f"{label} coordinates must be finite numbers within [0, 1]")
    if length == 4 and (value[0] >= value[2] or value[1] >= value[3]):
        raise ValueError("rect must have positive width and height")
    return list(value)


def _fields(value: Any, allowed: set[str]) -> list[str]:
    if not isinstance(value, (tuple, list)) or not value or any(not isinstance(f, str) or f not in allowed for f in value):
        raise ValueError(f"fields must select from {sorted(allowed)}")
    return list(dict.fromkeys(value))


class Capture:
    """Small handle. Coordinates are normalized, with origin at image top-left."""
    def __init__(self, client: Client, capture_id: str, workspace_ref: dict[str, Any], spatial: bool) -> None:
        self._client, self.id, self._workspace_ref, self.spatial = client, capture_id, workspace_ref, spatial

    def __repr__(self) -> str:
        return f"Capture(id={self.id!r}, spatial={self.spatial})"

    async def _read(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return await self._client.rpc(f"captures.{method}", {
            "captureId": self.id, "sessionId": self._client.current_session_id,
            "workspaceRef": self._workspace_ref, **params,
        })

    async def pick(self, *, uv: tuple[float, float], fields: list[str] | tuple[str, ...] = ("object", "world")) -> dict[str, Any]:
        """Read requested fields at a point. Background returns {hit: False}."""
        return await self._read("pick", {"uv": _coordinates(uv, 2, "uv"), "fields": _fields(fields, {"object", "world", "depth"})})

    async def objects(self, *, rect: tuple[float, float, float, float] = (0, 0, 1, 1),
                      fields: list[str] | tuple[str, ...] = ("ref", "name"), limit: int = 8, offset: int = 0) -> dict[str, Any]:
        """List visible objects in a region, with explicit bounded pagination."""
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 32:
            raise ValueError("limit must be an integer within [1, 32]")
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 100_000:
            raise ValueError("offset must be a non-negative bounded integer")
        return await self._read("objects", {"rect": _coordinates(rect, 4, "rect"), "fields": _fields(fields, {"ref", "name", "path", "bounds"}), "limit": limit, "offset": offset})


class Captures:
    def __init__(self, client: Client) -> None:
        self._client = client

    async def get(self, capture_id: str, *, workspace_ref: Any = None) -> Capture:
        """Open a capture attached to the current session; never chooses latest."""
        if not isinstance(capture_id, str) or not capture_id or len(capture_id) > 64:
            raise ValueError("An exact capture ID is required")
        if not self._client.current_session_id:
            raise ValueError("Capture access requires the current session")
        reference = workspace_payload(workspace_ref)
        result = await self._client.rpc("captures.get", {"captureId": capture_id,
            "sessionId": self._client.current_session_id, "workspaceRef": reference})
        return Capture(self._client, result["id"], reference, bool(result["spatial"]))
