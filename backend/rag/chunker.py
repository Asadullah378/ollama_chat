"""
Markdown-aware document chunker for RAG.

Goals (in order):
  1. Never split inside a fenced code block.
  2. Never split inside a Markdown table mid-row (table rows are atomic).
  3. Carry the heading hierarchy (`H1 > H2 > H3`) onto every chunk.
  4. Keep chunks under `max_chars` while staying close to natural boundaries
     (heading > blank line > paragraph > sentence > line > char).
  5. Allow small overlap between adjacent text chunks so cross-boundary
     sentences are still retrievable.
  6. Split oversize tables / code blocks safely:
       - oversize table  → emit one chunk per row group, repeating the header.
       - oversize code   → emit raw chunks bounded by line breaks.

The output `Chunk.content` is the *exact* text that will be passed to the
embedder AND inserted into the LLM context. `heading_path` is stored
separately so the retriever can build a labelled context block.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Tuple

DEFAULT_MAX_CHARS = 2800
DEFAULT_MIN_CHARS = 400
DEFAULT_OVERLAP = 250
HARD_MAX_CHARS = 6000


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_TABLE_ROW_RE = re.compile(r"^\s*\|.+\|\s*$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*(?::?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[\.\?\!])\s+(?=[A-Z\(\[\"'])")


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass
class Chunk:
    """A chunk produced by `chunk_markdown`."""

    index: int
    heading_path: str
    kind: str  # 'text' | 'table' | 'code'
    content: str

    @property
    def char_count(self) -> int:
        return len(self.content)

    @property
    def token_estimate(self) -> int:
        # ~4 chars / token is a reasonable rough estimate for English-ish text.
        return max(1, len(self.content) // 4)


# ---------------------------------------------------------------------------
# Block parser
# ---------------------------------------------------------------------------


@dataclass
class _Block:
    kind: str  # 'heading' | 'table' | 'code' | 'text' | 'blank'
    text: str
    heading_level: int = 0
    heading_title: str = ""


def _parse_blocks(markdown: str) -> List[_Block]:
    """Split markdown into ordered semantic blocks."""
    lines = markdown.splitlines()
    blocks: List[_Block] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]

        # Fenced code block — atomic.
        fence_m = _FENCE_RE.match(line)
        if fence_m:
            fence = fence_m.group(1)
            buf = [line]
            i += 1
            while i < n:
                buf.append(lines[i])
                if lines[i].lstrip().startswith(fence):
                    i += 1
                    break
                i += 1
            blocks.append(_Block(kind="code", text="\n".join(buf)))
            continue

        # Markdown table — consume contiguous pipe rows + separator.
        if _TABLE_ROW_RE.match(line):
            # Look ahead — confirm by either a separator next line or
            # another pipe row, so a single inline pipe is not treated as a table.
            next_line = lines[i + 1] if i + 1 < n else ""
            if _TABLE_SEP_RE.match(next_line) or _TABLE_ROW_RE.match(next_line):
                buf = [line]
                i += 1
                while i < n and (
                    _TABLE_ROW_RE.match(lines[i]) or _TABLE_SEP_RE.match(lines[i])
                ):
                    buf.append(lines[i])
                    i += 1
                blocks.append(_Block(kind="table", text="\n".join(buf)))
                continue

        # ATX heading.
        h = _HEADING_RE.match(line)
        if h:
            blocks.append(
                _Block(
                    kind="heading",
                    text=line,
                    heading_level=len(h.group(1)),
                    heading_title=h.group(2).strip(),
                )
            )
            i += 1
            continue

        if not line.strip():
            blocks.append(_Block(kind="blank", text=""))
            i += 1
            continue

        # Regular paragraph — accumulate until blank line / heading / table / code.
        buf = [line]
        i += 1
        while i < n:
            cur = lines[i]
            if not cur.strip():
                break
            if _HEADING_RE.match(cur):
                break
            if _FENCE_RE.match(cur):
                break
            if _TABLE_ROW_RE.match(cur):
                break
            buf.append(cur)
            i += 1
        blocks.append(_Block(kind="text", text="\n".join(buf)))

    return blocks


# ---------------------------------------------------------------------------
# Heading hierarchy
# ---------------------------------------------------------------------------


def _heading_path_after(stack: List[Tuple[int, str]]) -> str:
    return " > ".join(title for _, title in stack)


def _push_heading(stack: List[Tuple[int, str]], level: int, title: str) -> None:
    while stack and stack[-1][0] >= level:
        stack.pop()
    stack.append((level, title))


def _is_only_headings(body: str) -> bool:
    """True if every non-blank line in `body` is an ATX heading."""
    saw_any = False
    for line in body.splitlines():
        if not line.strip():
            continue
        saw_any = True
        if not _HEADING_RE.match(line):
            return False
    return saw_any


# ---------------------------------------------------------------------------
# Oversize table / code splitting
# ---------------------------------------------------------------------------


def _split_oversize_table(table_md: str, max_chars: int) -> List[str]:
    """Split a wide table into row groups, repeating the header row each time."""
    rows = table_md.splitlines()
    if not rows:
        return [table_md]

    header_lines: List[str] = []
    body_start = 0
    if rows and _TABLE_ROW_RE.match(rows[0]):
        header_lines.append(rows[0])
        body_start = 1
        if len(rows) > 1 and _TABLE_SEP_RE.match(rows[1]):
            header_lines.append(rows[1])
            body_start = 2

    header_text = "\n".join(header_lines)
    header_overhead = len(header_text) + 1 if header_text else 0
    body = rows[body_start:]

    chunks: List[str] = []
    buf: List[str] = []
    buf_len = 0
    for row in body:
        row_len = len(row) + 1
        if buf and buf_len + row_len + header_overhead > max_chars:
            chunks.append(
                (header_text + "\n" if header_text else "") + "\n".join(buf)
            )
            buf = [row]
            buf_len = row_len
        else:
            buf.append(row)
            buf_len += row_len
    if buf:
        chunks.append(
            (header_text + "\n" if header_text else "") + "\n".join(buf)
        )

    return chunks if chunks else [table_md]


def _split_oversize_code(code_md: str, max_chars: int) -> List[str]:
    """Split a long fenced code block line-wise, repeating the open/close fence."""
    lines = code_md.splitlines()
    if not lines:
        return [code_md]

    open_fence = lines[0] if _FENCE_RE.match(lines[0]) else "```"
    close_fence = "```"
    if _FENCE_RE.match(lines[-1]):
        close_fence = lines[-1]
        body = lines[1:-1]
    else:
        body = lines[1:]

    chunks: List[str] = []
    buf: List[str] = []
    buf_len = 0
    overhead = len(open_fence) + len(close_fence) + 2
    for ln in body:
        ln_len = len(ln) + 1
        if buf and buf_len + ln_len + overhead > max_chars:
            chunks.append(open_fence + "\n" + "\n".join(buf) + "\n" + close_fence)
            buf = [ln]
            buf_len = ln_len
        else:
            buf.append(ln)
            buf_len += ln_len
    if buf:
        chunks.append(open_fence + "\n" + "\n".join(buf) + "\n" + close_fence)
    return chunks


def _split_long_text(text: str, max_chars: int, overlap: int) -> List[str]:
    """Paragraph -> sentence -> hard-char fallback."""
    if len(text) <= max_chars:
        return [text]

    paragraphs = re.split(r"\n{2,}", text)
    out: List[str] = []
    buf = ""
    for para in paragraphs:
        para = para.strip("\n")
        if not para:
            continue
        candidate = (buf + "\n\n" + para) if buf else para
        if len(candidate) <= max_chars:
            buf = candidate
            continue
        if buf:
            out.append(buf)
            tail = buf[-overlap:] if overlap and len(buf) > overlap else ""
            buf = (tail + "\n\n" + para) if tail else para
        else:
            buf = para
        if len(buf) > max_chars:
            # paragraph itself too big: sentence split
            sentences = _SENTENCE_SPLIT_RE.split(buf)
            buf = ""
            for sent in sentences:
                sent = sent.strip()
                if not sent:
                    continue
                candidate = (buf + " " + sent) if buf else sent
                if len(candidate) <= max_chars:
                    buf = candidate
                    continue
                if buf:
                    out.append(buf)
                    tail = buf[-overlap:] if overlap and len(buf) > overlap else ""
                    buf = (tail + " " + sent) if tail else sent
                else:
                    # single sentence > max_chars: hard char split
                    start = 0
                    while start < len(sent):
                        end = min(start + max_chars, len(sent))
                        out.append(sent[start:end])
                        if end >= len(sent):
                            break
                        start = end - overlap if overlap else end
                    buf = ""
    if buf:
        out.append(buf)
    return [c for c in out if c.strip()]


# ---------------------------------------------------------------------------
# Main chunker
# ---------------------------------------------------------------------------


def chunk_markdown(
    markdown: str,
    *,
    max_chars: int = DEFAULT_MAX_CHARS,
    min_chars: int = DEFAULT_MIN_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP,
    source_name: Optional[str] = None,
) -> List[Chunk]:
    """
    Produce a list of chunks suitable for embedding and retrieval.

    `source_name` is currently unused for chunk text but reserved for future use
    (e.g. citing the source filename in chunk content).
    """
    del source_name  # reserved

    if not markdown or not markdown.strip():
        return []

    max_chars = max(800, int(max_chars))
    min_chars = max(80, min(min_chars, max_chars // 2))
    overlap_chars = max(0, min(overlap_chars, max_chars // 4))

    blocks = _parse_blocks(markdown)
    heading_stack: List[Tuple[int, str]] = []

    chunks: List[Chunk] = []
    pending: List[str] = []  # text/table/code blocks awaiting flush
    pending_kinds: List[str] = []
    pending_len = 0
    pending_heading = ""

    def flush() -> None:
        nonlocal pending, pending_kinds, pending_len, pending_heading
        if not pending:
            return
        body = "\n\n".join(p for p in pending if p)
        if body.strip() and not _is_only_headings(body):
            # Determine effective kind: if any non-text block is present, prefer it.
            kinds_set = set(pending_kinds)
            if kinds_set == {"text"}:
                kind = "text"
            elif "table" in kinds_set:
                kind = "table"
            elif "code" in kinds_set:
                kind = "code"
            else:
                kind = "text"
            chunks.append(
                Chunk(
                    index=len(chunks),
                    heading_path=pending_heading,
                    kind=kind,
                    content=body.strip(),
                )
            )
        pending = []
        pending_kinds = []
        pending_len = 0

    def emit_atomic(kind: str, text: str, heading_path: str) -> None:
        # Atomic block that already exceeds limits — flush whatever is queued.
        flush()
        chunks.append(
            Chunk(
                index=len(chunks),
                heading_path=heading_path,
                kind=kind,
                content=text.strip(),
            )
        )

    def add_block(kind: str, text: str) -> None:
        nonlocal pending, pending_kinds, pending_len, pending_heading
        if not text.strip():
            return
        heading_path = _heading_path_after(heading_stack)

        # Heading changed → flush so chunks group naturally under sections.
        if pending and heading_path != pending_heading:
            flush()

        block_len = len(text)
        if block_len > max_chars:
            if kind == "table":
                pieces = _split_oversize_table(text, max_chars)
                for p in pieces:
                    emit_atomic("table", p, heading_path)
                return
            if kind == "code":
                pieces = _split_oversize_code(text, max_chars)
                for p in pieces:
                    emit_atomic("code", p, heading_path)
                return
            # long text — recursive paragraph/sentence split
            pieces = _split_long_text(text, max_chars, overlap_chars)
            for p in pieces:
                emit_atomic("text", p, heading_path)
            return

        # Block fits — try to fold into pending.
        prospective = pending_len + (2 if pending else 0) + block_len
        if not pending or prospective <= max_chars:
            if not pending:
                pending_heading = heading_path
            pending.append(text)
            pending_kinds.append(kind)
            pending_len = prospective
        else:
            flush()
            pending_heading = heading_path
            pending.append(text)
            pending_kinds.append(kind)
            pending_len = block_len

    for block in blocks:
        if block.kind == "heading":
            # Flush current chunk so a new section starts fresh.
            flush()
            _push_heading(heading_stack, block.heading_level, block.heading_title)
            # Keep the heading text inside the next chunk so the LLM sees structure.
            heading_path = _heading_path_after(heading_stack)
            pending_heading = heading_path
            pending.append(block.text.strip())
            pending_kinds.append("text")
            pending_len = len(block.text)
        elif block.kind == "blank":
            continue
        else:
            add_block(block.kind, block.text)

    flush()

    # Merge undersized neighbouring text chunks under the same heading to
    # reduce noise (keep min_chars guideline).
    merged: List[Chunk] = []
    for ch in chunks:
        if (
            merged
            and ch.kind == "text"
            and merged[-1].kind == "text"
            and merged[-1].heading_path == ch.heading_path
            and len(merged[-1].content) < min_chars
            and len(merged[-1].content) + 2 + len(ch.content) <= max_chars
        ):
            merged[-1] = Chunk(
                index=merged[-1].index,
                heading_path=merged[-1].heading_path,
                kind="text",
                content=merged[-1].content + "\n\n" + ch.content,
            )
        else:
            merged.append(ch)

    # Re-index after merge.
    return [
        Chunk(
            index=i,
            heading_path=c.heading_path,
            kind=c.kind,
            content=c.content,
        )
        for i, c in enumerate(merged)
    ]


def embed_text_for(chunk: Chunk) -> str:
    """
    Produce the string that will be passed to the embedding model. We prepend
    the heading path so the embedding captures topical structure, which
    measurably improves retrieval on long structured documents.
    """
    if chunk.heading_path:
        return f"{chunk.heading_path}\n\n{chunk.content}"
    return chunk.content


def iter_chunks(chunks: Iterable[Chunk]) -> Iterable[Tuple[Chunk, str]]:
    for c in chunks:
        yield c, embed_text_for(c)
