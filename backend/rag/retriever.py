"""
Retrieval over indexed document chunks using pgvector cosine distance.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import List, Optional, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import DocumentChunk, StoredDocument

from .embedder import EmbeddingError, OllamaEmbedder

logger = logging.getLogger(__name__)

DEFAULT_TOP_K = 12
DEFAULT_MAX_CHARS = 30_000
DEFAULT_MIN_SIMILARITY = 0.2


@dataclass
class RetrievedChunk:
    chunk_id: str
    document_id: str
    document_name: str
    chunk_index: int
    heading_path: str
    kind: str
    content: str
    similarity: float

    def to_source(self) -> dict:
        """Minimal payload for the frontend to display retrieved sources."""
        return {
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "document_name": self.document_name,
            "chunk_index": self.chunk_index,
            "heading_path": self.heading_path,
            "kind": self.kind,
            "similarity": round(self.similarity, 4),
            "preview": (self.content[:300] + "…") if len(self.content) > 300 else self.content,
        }


def _coerce_uuids(ids: Sequence[str | UUID]) -> List[UUID]:
    out: List[UUID] = []
    for raw in ids:
        if isinstance(raw, UUID):
            out.append(raw)
            continue
        try:
            out.append(UUID(str(raw)))
        except (ValueError, TypeError):
            continue
    return out


async def retrieve_for_query(
    session: AsyncSession,
    query: str,
    document_ids: Sequence[str | UUID],
    *,
    embedder: Optional[OllamaEmbedder] = None,
    top_k: Optional[int] = None,
    max_chars: Optional[int] = None,
    min_similarity: Optional[float] = None,
) -> List[RetrievedChunk]:
    """
    Embed `query`, retrieve the top-K most-similar chunks restricted to the
    given documents, drop low-similarity matches, and char-budget the result.
    """
    if not query or not query.strip():
        return []

    doc_uuids = _coerce_uuids(document_ids)
    if not doc_uuids:
        return []

    top_k = int(top_k or int(os.getenv("RAG_TOP_K", str(DEFAULT_TOP_K))))
    max_chars = int(max_chars or int(os.getenv("RAG_CONTEXT_MAX_CHARS", str(DEFAULT_MAX_CHARS))))
    min_similarity = float(
        min_similarity
        if min_similarity is not None
        else float(os.getenv("RAG_MIN_SIMILARITY", str(DEFAULT_MIN_SIMILARITY)))
    )

    embedder = embedder or OllamaEmbedder()

    try:
        vectors = await embedder.embed([query.strip()])
    except EmbeddingError as e:
        logger.warning("RAG query embed failed: %s", e)
        raise

    if not vectors:
        return []
    q_vec = vectors[0]

    distance_col = DocumentChunk.embedding.cosine_distance(q_vec)
    stmt = (
        select(
            DocumentChunk.id,
            DocumentChunk.document_id,
            DocumentChunk.chunk_index,
            DocumentChunk.heading_path,
            DocumentChunk.kind,
            DocumentChunk.content,
            distance_col.label("distance"),
            StoredDocument.original_filename,
        )
        .join(StoredDocument, StoredDocument.id == DocumentChunk.document_id)
        .where(DocumentChunk.document_id.in_(doc_uuids))
        .where(DocumentChunk.embedding.is_not(None))
        .order_by(distance_col)
        .limit(top_k)
    )
    rows = (await session.execute(stmt)).all()

    out: List[RetrievedChunk] = []
    used_chars = 0
    for r in rows:
        sim = 1.0 - float(r.distance)
        if sim < min_similarity:
            continue
        if used_chars + len(r.content) > max_chars and out:
            break
        out.append(
            RetrievedChunk(
                chunk_id=str(r.id),
                document_id=str(r.document_id),
                document_name=r.original_filename,
                chunk_index=int(r.chunk_index),
                heading_path=r.heading_path or "",
                kind=r.kind or "text",
                content=r.content,
                similarity=sim,
            )
        )
        used_chars += len(r.content)
    return out


def build_retrieval_context(
    chunks: Sequence[RetrievedChunk],
) -> str:
    """Render retrieved chunks into a single Markdown block for the system prompt."""
    if not chunks:
        return ""
    parts: List[str] = []
    for i, c in enumerate(chunks, start=1):
        header_bits = [f"Source {i}", c.document_name]
        if c.heading_path:
            header_bits.append(c.heading_path)
        header = " — ".join(b for b in header_bits if b)
        parts.append(f"### {header}\n\n{c.content}")
    return "\n\n---\n\n".join(parts)
