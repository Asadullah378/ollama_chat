"""Normalize MinerU / HTML-heavy document text for LLM context."""

from __future__ import annotations

import re
from html import unescape
from typing import List, Tuple

_DOC_MARKER = "--- DOCUMENT (Markdown) ---"
_RT = "redacted_thinking"
_THINK_BLOCK_RE = re.compile(
    rf"<{_RT}[^>]*>.*?</{_RT}>\s*"
    rf"|`</{_RT}>.*?`</{_RT}>\s*",
    re.DOTALL | re.IGNORECASE,
)
_THINKING_PROCESS_RE = re.compile(
    r"(?:^|\n)\s*(?:Thinking Process:|Analyze the Request:)\s*",
    re.IGNORECASE,
)


def _clean_cell(html_fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html_fragment or "")
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_html_table_rows(table_html: str) -> List[List[str]]:
    rows: List[List[str]] = []
    for row_m in re.finditer(r"<tr[^>]*>(.*?)</tr>", table_html, re.DOTALL | re.IGNORECASE):
        cells = re.findall(
            r"<t[dh][^>]*>(.*?)</t[dh]>",
            row_m.group(1),
            re.DOTALL | re.IGNORECASE,
        )
        cleaned = [_clean_cell(c) for c in cells if _clean_cell(c)]
        if cleaned:
            rows.append(cleaned)
    return rows


def html_tables_to_markdown(text: str) -> str:
    """Turn MinerU HTML tables into pipe tables so models can read key/value rows."""

    def _replace_table(match: re.Match[str]) -> str:
        rows = _parse_html_table_rows(match.group(0))
        if not rows:
            return match.group(0)
        width = max(len(r) for r in rows)
        padded = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(r) + " |" for r in padded]
        if len(lines) >= 1:
            lines.insert(1, "| " + " | ".join(["---"] * width) + " |")
        return "\n".join(lines) + "\n"

    return re.sub(r"<table\b[^>]*>.*?</table>", _replace_table, text, flags=re.DOTALL | re.IGNORECASE)


def extract_document_control_summary(text: str, max_scan: int = 25000) -> str:
    """
    Surface Document Control fields (ApprovedBy, PreparedBy, etc.) at the top.
    MinerU often puts these in the first HTML table; models miss them in long HTML.
    """
    head = text[:max_scan]
    pairs: List[Tuple[str, str]] = []
    for rows in re.finditer(r"<table\b[^>]*>.*?</table>", head, re.DOTALL | re.IGNORECASE):
        for row in _parse_html_table_rows(rows.group(0)):
            if len(row) == 2:
                pairs.append((row[0], row[1]))
            elif len(row) >= 4 and len(row) % 2 == 0:
                for i in range(0, len(row), 2):
                    pairs.append((row[i], row[i + 1]))

    if "|" in head:
        for line in head.splitlines():
            if line.count("|") < 3 or re.match(r"^\|\s*[-:]+\s*\|", line):
                continue
            parts = [p.strip() for p in line.strip("|").split("|") if p.strip()]
            if len(parts) == 2:
                pairs.append((parts[0], parts[1]))
            elif len(parts) >= 4 and len(parts) % 2 == 0:
                for i in range(0, len(parts), 2):
                    pairs.append((parts[i], parts[i + 1]))

    keywords = (
        "approved",
        "prepared",
        "reviewed",
        "document no",
        "version",
        "effective",
        "product",
        "batch size",
    )
    lines: List[str] = []
    seen: set[str] = set()
    for key, val in pairs:
        norm = re.sub(r"\s+", "", key.lower())
        if not val or norm in seen:
            continue
        if any(kw in norm for kw in keywords):
            seen.add(norm)
            lines.append(f"- **{key}:** {val}")

    if not lines:
        return ""
    return "## Document control (extracted)\n\n" + "\n".join(lines)


def normalize_document_for_llm(text: str) -> str:
    if not text or not str(text).strip():
        return text or ""
    out = html_tables_to_markdown(str(text))
    summary = extract_document_control_summary(out)
    if summary:
        out = summary + "\n\n---\n\n" + out
    return out


def build_document_system_content(doc_markdown: str) -> str:
    return (
        "You are a helpful assistant. The user attached document(s) below (Markdown, often from PDF tables).\n"
        "Rules:\n"
        "- Answer ONLY from the document for factual questions. Quote or name the field (e.g. ApprovedBy) when possible.\n"
        "- Check **Document control (extracted)** and the first tables for metadata (ApprovedBy, PreparedBy, ReviewedBy, etc.).\n"
        "- Tables may use `|` columns; read row labels and the cell beside them.\n"
        "- If the answer is not in the document, say so briefly. Do not invent names or values.\n"
        "- Give a short direct answer first (one or two sentences), then optional detail.\n"
        "- Do not repeat your reasoning in the final answer.\n\n"
        f"{_DOC_MARKER}\n"
        f"{doc_markdown}\n"
        "--- END DOCUMENT ---"
    )


def message_has_document_context(msg: dict) -> bool:
    if msg.get("role") != "system":
        return False
    content = msg.get("content") or ""
    return _DOC_MARKER in content or "DOCUMENT (Markdown)" in content


def strip_prior_document_system_messages(messages: List[dict]) -> List[dict]:
    return [m for m in messages if not message_has_document_context(m)]


def sanitize_leaked_thinking_content(content: str, thinking: str = "") -> str:
    """
    Qwen3 / Qwen3.5 sometimes streams reasoning into `content` when think=true.
    Only call on the full assembled message (never per stream chunk — chunk strip
    would delete space-only tokens and glue words together).
    """
    if not content:
        return content
    text = _THINK_BLOCK_RE.sub("", content)
    if thinking and _THINKING_PROCESS_RE.search(text):
        text = _THINKING_PROCESS_RE.split(text, maxsplit=1)[-1].lstrip()
    elif len(text) > 4000 and _THINKING_PROCESS_RE.search(text):
        text = _THINKING_PROCESS_RE.split(text, maxsplit=1)[-1].lstrip()
    for marker in (
        "\n\nAnswer:\n",
        "\n\nAnswer:\n\n",
        "**Answer:**",
        "Final Answer:",
        "Final answer:",
    ):
        idx = text.rfind(marker)
        if idx != -1:
            tail = text[idx + len(marker) :].strip()
            if 20 < len(tail) < len(text) * 0.85:
                return tail
    return text
