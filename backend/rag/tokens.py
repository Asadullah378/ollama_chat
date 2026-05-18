"""
Lightweight token counting used by the document pipeline and the chat
context-usage UI.

Qwen3 (and most modern open-weights families) don't ship a `tiktoken`
encoding. tiktoken's `cl100k_base` (the GPT-4 family encoding) lines up to
roughly 85–90 % of the real Qwen count for natural-language English and
slightly under-counts CJK / heavy-symbol text. That's good enough for the two
places we use it:

  * Estimating how many tokens a document costs in *full-markdown* mode
    (`StoredDocument.markdown_token_count`).
  * Per-chunk `token_estimate` on `DocumentChunk` rows so the docs page can
    show a *retrieval-mode* total.

For chat usage we never use this — we lift the exact `prompt_eval_count` and
`eval_count` from Ollama's final stream chunk.

If `tiktoken` is missing for any reason (slow CI, restricted env, …) we fall
back to the same ASCII / non-ASCII heuristic Qwen's own tooling uses
(0.25 tok / ASCII char, 1.1 tok / non-ASCII char) so callers never have to
handle `None`.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)

_ENCODER = None
_ENCODER_LOCK = threading.Lock()
_TRIED_LOAD = False


def _load_encoder():
    """Lazily import tiktoken + load cl100k_base. Cached after the first call."""
    global _ENCODER, _TRIED_LOAD
    if _ENCODER is not None or _TRIED_LOAD:
        return _ENCODER
    with _ENCODER_LOCK:
        if _ENCODER is not None or _TRIED_LOAD:
            return _ENCODER
        _TRIED_LOAD = True
        try:
            import tiktoken  # type: ignore

            _ENCODER = tiktoken.get_encoding("cl100k_base")
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "tiktoken not available (%s); using character-based token estimate. "
                "Install tiktoken (`pip install tiktoken`) for closer-to-real counts.",
                e,
            )
            _ENCODER = None
    return _ENCODER


def _fallback_count(text: str) -> int:
    """Mirror Qwen tooling's char-based heuristic: 0.25 tok/ASCII, 1.1 tok/non-ASCII."""
    if not text:
        return 0
    ascii_chars = 0
    other_chars = 0
    for ch in text:
        if ord(ch) < 128:
            ascii_chars += 1
        else:
            other_chars += 1
    return int(ascii_chars * 0.25 + other_chars * 1.1) + (1 if (ascii_chars or other_chars) else 0)


def count_tokens(text: Optional[str]) -> int:
    """Count tokens in `text`. Never raises; returns 0 for empty input."""
    if not text:
        return 0
    enc = _load_encoder()
    if enc is None:
        return _fallback_count(text)
    try:
        return len(enc.encode(text, disallowed_special=()))
    except Exception:  # noqa: BLE001
        return _fallback_count(text)
