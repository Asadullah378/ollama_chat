"""
Document indexing pipeline: chunk → embed → persist into pgvector.

`index_document` updates the `StoredDocument` row's status as it progresses,
so the UI can show "Embedding…" / "Ready" / "Failed" badges.

`index_document_background` schedules indexing without blocking the upload
response. We hold a tiny in-process registry to prevent concurrent re-indexing
of the same document.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Iterable, Optional
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from db import models as db_models  # read EMBEDDING_DIM lazily (may be patched at runtime)
from db.models import DocumentChunk, StoredDocument

from .chunker import Chunk, chunk_markdown, embed_text_for
from .embedder import EmbeddingError, OllamaEmbedder

logger = logging.getLogger(__name__)


_in_flight: set[UUID] = set()
_lock = asyncio.Lock()


async def _try_claim(doc_id: UUID) -> bool:
    async with _lock:
        if doc_id in _in_flight:
            return False
        _in_flight.add(doc_id)
        return True


async def _release(doc_id: UUID) -> None:
    async with _lock:
        _in_flight.discard(doc_id)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def _set_status(
    session: AsyncSession,
    doc_id: UUID,
    *,
    status: str,
    error: Optional[str] = None,
    chunk_count: Optional[int] = None,
    embedding_model: Optional[str] = None,
    embedding_dim: Optional[int] = None,
    embedded_at: Optional[datetime] = None,
) -> None:
    values: dict = {"embedding_status": status, "embedding_error": error}
    if chunk_count is not None:
        values["chunk_count"] = chunk_count
    if embedding_model is not None:
        values["embedding_model"] = embedding_model
    if embedding_dim is not None:
        values["embedding_dim"] = embedding_dim
    if embedded_at is not None:
        values["embedded_at"] = embedded_at
    await session.execute(
        update(StoredDocument).where(StoredDocument.id == doc_id).values(**values)
    )
    await session.commit()


def _trim(msg: str, limit: int = 800) -> str:
    msg = (msg or "").strip()
    if len(msg) > limit:
        return msg[:limit] + "…"
    return msg


async def index_document(
    session_maker: async_sessionmaker[AsyncSession],
    doc_id: UUID,
    *,
    embedder: Optional[OllamaEmbedder] = None,
    force: bool = False,
) -> dict:
    """
    Chunk, embed, and persist a document's chunks. Returns a small summary dict.

    `force=True` will re-embed even if status is already 'ready'.
    """
    embedder = embedder or OllamaEmbedder()

    if not await _try_claim(doc_id):
        return {"ok": False, "skipped": True, "reason": "already_in_flight"}

    try:
        async with session_maker() as session:
            row = await session.get(StoredDocument, doc_id)
            if row is None:
                return {"ok": False, "reason": "not_found"}

            if not force and row.embedding_status == "ready" and (row.chunk_count or 0) > 0:
                return {
                    "ok": True,
                    "skipped": True,
                    "reason": "already_ready",
                    "chunk_count": row.chunk_count,
                }

            await _set_status(
                session,
                doc_id,
                status="embedding",
                error=None,
                embedding_model=embedder.model,
            )

            markdown = row.markdown or ""
            chunks: list[Chunk] = chunk_markdown(markdown, source_name=row.original_filename)

        if not chunks:
            async with session_maker() as session:
                await session.execute(
                    delete(DocumentChunk).where(DocumentChunk.document_id == doc_id)
                )
                await _set_status(
                    session,
                    doc_id,
                    status="ready",
                    chunk_count=0,
                    embedding_model=embedder.model,
                    embedding_dim=0,
                    embedded_at=_utc_now(),
                )
            return {"ok": True, "chunk_count": 0}

        logger.info(
            "RAG: embedding %s (%d chunks) with model=%s",
            doc_id, len(chunks), embedder.model,
        )

        texts = [embed_text_for(c) for c in chunks]
        try:
            vectors = await embedder.embed(texts)
        except EmbeddingError as e:
            msg = _trim(str(e))
            async with session_maker() as session:
                await _set_status(session, doc_id, status="failed", error=msg)
            logger.error("RAG: embedding failed for %s: %s", doc_id, msg)
            return {"ok": False, "error": msg}

        if len(vectors) != len(chunks):
            msg = (
                f"Embedding count mismatch: got {len(vectors)} vectors for {len(chunks)} chunks."
            )
            async with session_maker() as session:
                await _set_status(session, doc_id, status="failed", error=msg)
            logger.error("RAG: %s for doc %s", msg, doc_id)
            return {"ok": False, "error": msg}

        dim = len(vectors[0]) if vectors else 0
        schema_dim = db_models.EMBEDDING_DIM
        if dim and dim != schema_dim:
            msg = (
                f"Embedding dim mismatch: model {embedder.model!r} returned {dim}-dim vectors "
                f"but document_chunks.embedding is vector({schema_dim}). "
                f"Set EMBEDDING_DIM={dim} in backend/.env and drop the document_chunks table, "
                f"then restart so it can be recreated with the correct dimension."
            )
            async with session_maker() as session:
                await _set_status(session, doc_id, status="failed", error=msg)
            logger.error("RAG: %s", msg)
            return {"ok": False, "error": msg}

        try:
            async with session_maker() as session:
                await session.execute(
                    delete(DocumentChunk).where(DocumentChunk.document_id == doc_id)
                )
                for c, v in zip(chunks, vectors):
                    session.add(
                        DocumentChunk(
                            document_id=doc_id,
                            chunk_index=c.index,
                            heading_path=c.heading_path,
                            kind=c.kind,
                            content=c.content,
                            char_count=c.char_count,
                            token_estimate=c.token_estimate,
                            embedding=v,
                        )
                    )
                await _set_status(
                    session,
                    doc_id,
                    status="ready",
                    chunk_count=len(chunks),
                    embedding_model=embedder.model,
                    embedding_dim=dim,
                    embedded_at=_utc_now(),
                )
        except Exception as e:  # noqa: BLE001
            # Most common cause: pgvector extension missing or dim mismatch on
            # an existing column. Surface a clear message instead of a stacktrace.
            msg = _trim(str(e))
            hint = ""
            low = msg.lower()
            if "type \"vector\" does not exist" in low or "extension \"vector\"" in low:
                hint = (
                    " Run `CREATE EXTENSION vector;` in PostgreSQL as a superuser, "
                    "then click Re-embed."
                )
            elif "expected " in low and "dimensions" in low:
                hint = (
                    " The embedding model returned a different vector length than "
                    f"EMBEDDING_DIM={db_models.EMBEDDING_DIM}. Update .env and drop document_chunks."
                )
            async with session_maker() as session:
                await _set_status(session, doc_id, status="failed", error=(msg + hint)[:800])
            logger.exception("RAG: failed to persist chunks for %s", doc_id)
            return {"ok": False, "error": msg + hint}

        logger.info(
            "RAG: %s indexed (%d chunks, dim=%d) with %s",
            doc_id, len(chunks), dim, embedder.model,
        )
        return {
            "ok": True,
            "chunk_count": len(chunks),
            "embedding_model": embedder.model,
            "embedding_dim": dim,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("RAG indexing crashed for %s", doc_id)
        try:
            async with session_maker() as session:
                await _set_status(session, doc_id, status="failed", error=_trim(str(e)))
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": str(e)}
    finally:
        await _release(doc_id)


def index_document_background(
    session_maker: async_sessionmaker[AsyncSession],
    doc_id: UUID,
    *,
    embedder: Optional[OllamaEmbedder] = None,
    force: bool = False,
) -> asyncio.Task:
    """Fire-and-forget wrapper that returns the task for tests."""
    return asyncio.create_task(
        index_document(session_maker, doc_id, embedder=embedder, force=force)
    )


async def reset_failed_indexing(
    session: AsyncSession, doc_ids: Iterable[UUID]
) -> None:
    ids = list(doc_ids)
    if not ids:
        return
    await session.execute(
        update(StoredDocument)
        .where(StoredDocument.id.in_(ids))
        .values(embedding_status="pending", embedding_error=None)
    )
