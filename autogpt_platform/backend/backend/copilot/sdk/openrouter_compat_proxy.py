"""Tiny in-process HTTP middleware that makes the Claude Code CLI work
against OpenRouter on **any** ``claude-agent-sdk`` version.

Background
----------
We've been pinned at ``claude-agent-sdk==0.1.45`` (bundled CLI 2.1.63)
since `PR #12294`_ because every newer CLI version sends one of two
features that OpenRouter rejects:

1. **`tool_reference` content blocks** in ``tool_result.content`` —
   introduced in CLI 2.1.69. OpenRouter's stricter Zod validation
   refuses requests containing them with::

        messages[N].content[0].content: Invalid input: expected string, received array

2. **`context-management-2025-06-27` beta header** — sent in either the
   request body's ``betas`` array or the ``anthropic-beta`` HTTP header.
   OpenRouter responds::

        400 No endpoints available that support Anthropic's context
        management features (context-management-2025-06-27).

   Tracked upstream at `claude-agent-sdk-python#789`_.

This module starts a tiny aiohttp server that:

* listens on ``127.0.0.1:RANDOM_PORT``,
* receives every CLI request that would normally go to
  ``ANTHROPIC_BASE_URL``,
* strips the two forbidden patterns from the body and headers,
* forwards the cleaned request to the real upstream
  (``proxy_target_base_url``, e.g. ``https://openrouter.ai/api/v1``),
* streams the response back to the CLI unchanged.

The proxy is wired via :class:`backend.copilot.config.ChatConfig.claude_agent_use_compat_proxy`.
When the flag is on, :mod:`backend.copilot.sdk.service` starts a proxy
per session, sets ``ANTHROPIC_BASE_URL`` in the SDK's ``env`` to point
at the proxy, then tears it down after the session ends.

Why a separate proxy instead of a custom HTTP transport in the SDK?
-------------------------------------------------------------------
The Python SDK delegates **all** HTTP traffic to the bundled Claude
Code CLI subprocess. Once the CLI is spawned, the only seam left is
the network — there is no in-process hook for "modify outgoing
request before it leaves the CLI". The proxy lives at that seam.

This module is intentionally orthogonal to the
:attr:`ChatConfig.claude_agent_cli_path` override:

* ``cli_path`` lets us swap **which CLI binary** we run.
* this proxy lets us **rewrite what any CLI binary sends**.

The two can be combined or used independently.

.. _PR #12294: https://github.com/Significant-Gravitas/AutoGPT/pull/12294
.. _claude-agent-sdk-python#789: https://github.com/anthropics/claude-agent-sdk-python/issues/789
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp
from aiohttp import web

logger = logging.getLogger(__name__)

# Header values OpenRouter rejects.  We strip exactly these tokens from
# the comma-separated ``anthropic-beta`` header value (preserving any
# other betas the CLI requests).
_FORBIDDEN_BETA_TOKENS: frozenset[str] = frozenset(
    {
        "context-management-2025-06-27",
    }
)

# Hop-by-hop headers we must NOT forward through the proxy.  Per
# RFC 7230 §6.1, these are connection-specific and must be regenerated
# by each intermediary.  ``host`` is also stripped because aiohttp
# generates the correct ``Host`` header for the upstream URL itself.
#
# The canonical header name defined in RFC 7230 §4.4 is ``Trailer``
# (singular); some SDKs / legacy proxies also emit the plural
# ``Trailers`` so we accept both forms just in case.  Intermediaries
# must additionally drop every header name listed in the incoming
# ``Connection`` field value (§6.1 "extension hop-by-hop headers") —
# that's handled dynamically by :func:`clean_request_headers`.
_HOP_BY_HOP_HEADERS: frozenset[str] = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
        # ``content-length`` is stripped because we may rewrite the
        # body — aiohttp will recompute it on the upstream request.
        "content-length",
    }
)


# ---------------------------------------------------------------------------
# Pure helpers — exported so the unit tests can drive them directly without
# spinning up a server.
# ---------------------------------------------------------------------------


def strip_tool_reference_blocks(payload: Any) -> Any:
    """Recursively remove ``tool_reference`` content blocks from
    *payload*, returning the cleaned structure.

    The CLI's built-in ``ToolSearch`` tool emits these as part of
    ``tool_result.content``::

        {"type": "tool_reference", "tool_name": "mcp__copilot__find_block"}

    OpenRouter's stricter Zod validation rejects them.  Removing them
    is safe — they are metadata about which tools were searched, not
    real model-visible content.  The CLI's *internal* state still
    contains them; only the wire format is rewritten.
    """
    if isinstance(payload, dict):
        # Drop the dict entirely if it IS a tool_reference block.  The
        # caller (a list comprehension below) discards None entries so
        # we can return None to signal "remove me".
        if payload.get("type") == "tool_reference":
            return None
        cleaned_dict: dict[str, Any] = {}
        for key, value in payload.items():
            cleaned_value = strip_tool_reference_blocks(value)
            # If a dict-valued child WAS a tool_reference block,
            # drop the key entirely rather than writing `null` —
            # otherwise schema-strict upstreams still reject the
            # payload.  Only applies when the original value was a
            # dict; genuine None values in the input are preserved.
            if cleaned_value is None and isinstance(value, dict):
                continue
            cleaned_dict[key] = cleaned_value
        return cleaned_dict
    if isinstance(payload, list):
        cleaned_list: list[Any] = []
        for item in payload:
            cleaned_item = strip_tool_reference_blocks(item)
            if cleaned_item is None and isinstance(item, dict):
                # Item was a tool_reference block — drop it from the
                # list rather than leaving a None hole.
                continue
            cleaned_list.append(cleaned_item)
        return cleaned_list
    return payload


def strip_forbidden_betas_from_body(payload: Any) -> Any:
    """Remove forbidden tokens from the ``betas`` array of an
    Anthropic Messages API request body, if present.

    Returns a shallow copy with the ``betas`` key cleaned — the input
    dict is never mutated.

    The Messages API accepts a top-level ``betas: list[str]`` parameter
    used to opt into beta features.  We drop tokens in
    :data:`_FORBIDDEN_BETA_TOKENS` so OpenRouter's check passes.
    """
    if not isinstance(payload, dict):
        return payload
    betas = payload.get("betas")
    if not isinstance(betas, list):
        return payload
    cleaned_betas = [b for b in betas if b not in _FORBIDDEN_BETA_TOKENS]
    result = {k: v for k, v in payload.items() if k != "betas"}
    if cleaned_betas:
        result["betas"] = cleaned_betas
    return result


def strip_forbidden_anthropic_beta_header(value: str | None) -> str | None:
    """Return *value* with forbidden tokens removed.

    The ``anthropic-beta`` HTTP header is a comma-separated list of
    feature flags.  We strip exactly the forbidden tokens, preserving
    any others.  Returns ``None`` if nothing remains (so the caller
    can drop the header entirely).
    """
    if not value:
        return value
    tokens = [token.strip() for token in value.split(",")]
    kept = [token for token in tokens if token and token not in _FORBIDDEN_BETA_TOKENS]
    if not kept:
        return None
    return ", ".join(kept)


def clean_request_body_bytes(body_bytes: bytes) -> bytes:
    """Apply both body-level strippers to *body_bytes*, returning the
    cleaned JSON.  Falls back to the original bytes when the body
    isn't valid JSON (the CLI shouldn't be sending non-JSON to the
    Messages API, but be defensive)."""
    if not body_bytes:
        return body_bytes
    try:
        payload = json.loads(body_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body_bytes
    payload = strip_tool_reference_blocks(payload)
    payload = strip_forbidden_betas_from_body(payload)
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def _parse_connection_tokens(headers: dict[str, str]) -> set[str]:
    """Extract hop-by-hop header names from the ``Connection`` field."""
    connection_header = next(
        (value for name, value in headers.items() if name.lower() == "connection"),
        "",
    )
    return {
        token.strip().lower() for token in connection_header.split(",") if token.strip()
    }


def clean_request_headers(headers: dict[str, str]) -> dict[str, str]:
    """Drop hop-by-hop headers and rewrite ``anthropic-beta`` to remove
    forbidden tokens.  Returns a fresh dict the caller can pass through
    to the upstream client without further mutation.

    Per RFC 7230 section 6.1, intermediaries must drop the static hop-by-hop
    set above **and** every header name listed in the incoming
    ``Connection`` field value (case-insensitive).  The latter is how
    extension hop-by-hop headers are signalled per-connection.

    Callers should pass an already-materialised ``dict`` (e.g.
    ``dict(request.headers)``) so this function stays simple.
    """
    connection_tokens = _parse_connection_tokens(headers)

    cleaned: dict[str, str] = {}
    for name, value in headers.items():
        lower_name = name.lower()
        if lower_name in _HOP_BY_HOP_HEADERS or lower_name in connection_tokens:
            continue
        if lower_name == "anthropic-beta":
            stripped = strip_forbidden_anthropic_beta_header(value)
            if stripped is None:
                continue
            cleaned[name] = stripped
            continue
        cleaned[name] = value
    return cleaned


def clean_response_headers(
    headers: "Any",
) -> list[tuple[str, str]]:
    """Like :func:`clean_request_headers` but preserves multi-valued
    headers (e.g. ``Set-Cookie``).  Accepts any mapping-like object
    whose ``.items()`` yields ``(name, value)`` pairs — including
    aiohttp's ``CIMultiDictProxy`` which can have duplicate keys.

    Returns a list of ``(name, value)`` tuples suitable for passing
    to ``web.StreamResponse(headers=...)`` via ``CIMultiDict``.
    """
    connection_tokens: set[str] = set()
    for name, value in headers.items():
        if name.lower() == "connection":
            connection_tokens = {
                t.strip().lower() for t in value.split(",") if t.strip()
            }
            break

    cleaned: list[tuple[str, str]] = []
    for name, value in headers.items():
        lower_name = name.lower()
        if lower_name in _HOP_BY_HOP_HEADERS or lower_name in connection_tokens:
            continue
        if lower_name == "anthropic-beta":
            stripped = strip_forbidden_anthropic_beta_header(value)
            if stripped is None:
                continue
            cleaned.append((name, stripped))
            continue
        cleaned.append((name, value))
    return cleaned


# ---------------------------------------------------------------------------
# The proxy server
# ---------------------------------------------------------------------------


class OpenRouterCompatProxy:
    """In-process HTTP proxy that rewrites Claude Code CLI requests on
    the way to OpenRouter (or any other Anthropic-compatible gateway).

    Usage::

        proxy = OpenRouterCompatProxy(target_base_url="https://openrouter.ai/api/v1")
        await proxy.start()
        try:
            # Spawn the CLI with ANTHROPIC_BASE_URL=proxy.local_url
            ...
        finally:
            await proxy.stop()
    """

    def __init__(
        self,
        target_base_url: str,
        *,
        bind_host: str = "127.0.0.1",
        request_timeout: float = 600.0,
    ) -> None:
        self._target_base_url = target_base_url.rstrip("/")
        self._bind_host = bind_host
        self._request_timeout = request_timeout
        self._runner: web.AppRunner | None = None
        self._client: aiohttp.ClientSession | None = None
        self._port: int | None = None

    @property
    def local_url(self) -> str:
        """The ``http://host:port`` URL that the CLI should use as
        ``ANTHROPIC_BASE_URL``.  Raises if :meth:`start` has not been
        called yet."""
        if self._port is None:
            raise RuntimeError("Proxy is not running — call start() first.")
        return f"http://{self._bind_host}:{self._port}"

    @property
    def target_base_url(self) -> str:
        """The upstream URL the proxy is forwarding to."""
        return self._target_base_url

    async def start(self) -> None:
        """Bind to a random local port and start serving.

        Cleans up the ``ClientSession`` and the ``AppRunner`` on any
        failure during setup so a partially-initialised proxy never
        leaves resources dangling (covers the
        ``runner.setup() / site.start()`` raise paths in addition to
        the explicit bind-failure branches below).
        """
        if self._runner is not None:
            return  # already started
        # Use sock_connect + sock_read instead of total so long-lived
        # SSE / streaming responses aren't killed after request_timeout.
        # total=None means no cumulative limit; sock_read is the per-chunk
        # idle timeout (time between data arriving on the socket).
        client = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(
                total=None,
                sock_connect=self._request_timeout,
                sock_read=self._request_timeout,
            )
        )
        app = web.Application()
        # Catch every method + path so we can also forward GETs
        # (the CLI may probe profile / model endpoints).
        app.router.add_route("*", "/{tail:.*}", self._handle)
        runner = web.AppRunner(app)
        runner_setup = False
        try:
            await runner.setup()
            runner_setup = True
            site = web.TCPSite(runner, self._bind_host, 0)
            await site.start()
            server = site._server
            if server is None:
                raise RuntimeError("Failed to bind compat proxy server.")
            sockets = getattr(server, "sockets", None)
            if not sockets:
                raise RuntimeError("Compat proxy server has no listening sockets.")
            self._port = sockets[0].getsockname()[1]
        except BaseException:
            # Best-effort teardown — swallow secondary errors so the
            # caller sees the original exception.
            if runner_setup:
                try:
                    await runner.cleanup()
                except Exception:  # pragma: no cover - cleanup-only path
                    logger.exception("compat proxy runner cleanup failed")
            try:
                await client.close()
            except Exception:  # pragma: no cover - cleanup-only path
                logger.exception("compat proxy client close failed")
            raise
        # Only publish the attributes after everything is wired up so
        # ``stop()`` and ``local_url`` observe a consistent state.
        self._client = client
        self._runner = runner
        # Deliberately log only the local bind port — never the
        # upstream URL or any derived component. CodeQL's
        # `py/clear-text-logging-sensitive-data` taint analysis traces
        # everything that originates from a config-supplied URL as
        # potentially-sensitive even after parsing, and the upstream
        # endpoint is anyway discoverable from the config the operator
        # already has access to. The detailed upstream is exposed via
        # the ``target_base_url`` property for callers that need it.
        logger.info(
            "OpenRouter compat proxy listening on %s:%d",
            self._bind_host,
            self._port,
        )

    async def stop(self) -> None:
        """Stop accepting connections and release the port."""
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._client is not None:
            await self._client.close()
            self._client = None
        self._port = None

    async def __aenter__(self) -> "OpenRouterCompatProxy":
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.stop()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        """Forward *request* to the upstream after stripping forbidden
        features.  Streams the upstream response back to the caller
        chunk-by-chunk so SSE / streamed responses work."""
        if self._client is None:
            raise web.HTTPInternalServerError(reason="proxy client missing")

        # Build the upstream URL.  ``request.path_qs`` includes the
        # query string verbatim.  ``request.path`` for ``/v1/messages``
        # is just ``/v1/messages`` — we strip a leading slash and
        # concat with the target base URL.
        upstream_path = request.path_qs
        if not upstream_path.startswith("/"):
            upstream_path = "/" + upstream_path
        # Allow the target_base_url to itself contain a path (e.g.
        # ``https://openrouter.ai/api/v1``).  In that case requests to
        # ``/v1/messages`` need to become ``/api/v1/messages``, not
        # ``/api/v1/v1/messages``.  Strip a leading ``/v1`` from the
        # incoming path if the target already ends with ``/v1`` (or
        # similar API-version segment).
        # Deduplicate API version prefix: if the target URL already
        # contains a versioned path segment (e.g. ``/api/v1``) and the
        # incoming request path starts with the same segment, strip it
        # to avoid ``/api/v1/v1/messages``.
        from urllib.parse import urlparse

        target_base = self._target_base_url
        target_path = urlparse(target_base).path.rstrip("/")
        if target_path and upstream_path.startswith(target_path + "/"):
            upstream_path = upstream_path[len(target_path) :]
        elif target_path and upstream_path == target_path:
            upstream_path = "/"
        upstream_url = f"{target_base}{upstream_path}"

        body_bytes = await request.read()
        cleaned_body = clean_request_body_bytes(body_bytes)
        cleaned_headers = clean_request_headers(dict(request.headers))

        try:
            upstream_response = await self._client.request(
                method=request.method,
                url=upstream_url,
                data=cleaned_body if cleaned_body else None,
                headers=cleaned_headers,
                allow_redirects=False,
            )
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            # ``aiohttp.ClientTimeout`` raises ``asyncio.TimeoutError``
            # (not ``aiohttp.ClientError``) on hung upstreams, so both
            # must be caught here to surface the explicit 502 failure
            # mode this proxy guarantees.
            #
            # Log the detailed error for ops, but return a generic
            # message to the caller — exception strings can leak
            # internal hostnames, ports, or stack frames (CodeQL
            # `py/stack-trace-exposure`).
            logger.warning(
                "OpenRouter compat proxy upstream error: %s", type(e).__name__
            )
            return web.Response(status=502, text="upstream error")

        # Stream the response back unchanged (apart from hop-by-hop
        # header filtering).  Use clean_response_headers to preserve
        # multi-valued headers like Set-Cookie that dict() would drop.
        from multidict import CIMultiDict

        downstream = web.StreamResponse(
            status=upstream_response.status,
            headers=CIMultiDict(clean_response_headers(upstream_response.headers)),
        )
        await downstream.prepare(request)
        # Track whether the stream terminated cleanly.  A mid-stream
        # ``aiohttp.ClientError`` means the upstream died before
        # finishing; calling ``write_eof()`` on that partial response
        # would signal "complete stream" to the downstream client and
        # silently corrupt the body.  Skip the EOF on the error path
        # so the client's connection is dropped instead, surfacing the
        # failure correctly.
        cancelled = False
        stream_error: aiohttp.ClientError | None = None
        try:
            async for chunk in upstream_response.content.iter_any():
                await downstream.write(chunk)
        except asyncio.CancelledError:
            # Never suppress cancellation — since Python 3.8 it's a
            # ``BaseException`` subclass precisely so catching
            # ``Exception`` won't accidentally swallow it.  Release
            # the upstream body and re-raise so the asyncio task
            # cooperatively unwinds (avoids hanging shutdowns /
            # stuck request handlers).
            cancelled = True
            upstream_response.release()
            raise
        except aiohttp.ClientError as e:
            stream_error = e
            logger.warning(
                "OpenRouter compat proxy stream interrupted: %s", type(e).__name__
            )
        finally:
            if not cancelled:
                upstream_response.release()

        if stream_error is not None:
            # Do NOT call ``write_eof`` or return the prepared
            # ``downstream`` here — aiohttp finalises a returned
            # StreamResponse (writing the terminating chunk /
            # content-length / EOF) even if we skipped ``write_eof``
            # ourselves, which would signal a clean end of stream to
            # the client on top of the truncated body.  Instead abort
            # the underlying transport directly so the client's
            # parser surfaces a ``ClientPayloadError`` /
            # ``ServerDisconnectedError`` and the caller can retry /
            # surface the failure instead of silently consuming a
            # corrupt body.
            try:
                downstream.force_close()
            except Exception:  # pragma: no cover - defensive on transport
                pass
            transport = request.transport
            if transport is not None:
                try:
                    transport.abort()
                except Exception:  # pragma: no cover - defensive on transport
                    pass
            # Re-raise the original stream error so aiohttp treats
            # this handler as having failed; the transport is
            # already aborted above so the client sees an abrupt
            # disconnect either way.
            raise stream_error

        await downstream.write_eof()
        return downstream
