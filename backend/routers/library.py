from __future__ import annotations

import asyncio
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import ChatArchive, DocumentChunk, StoredDocument
from document_text import normalize_document_for_llm
from mineru_runner import parse_file_with_mineru, sha256_file
from rag import count_tokens, index_document_background

router = APIRouter()

ALLOWED_SUFFIXES = frozenset(
    {
        ".pdf",
        ".docx",
        ".pptx",
        ".ppt",
        ".xlsx",
        ".xls",
        ".html",
        ".htm",
        ".txt",
        ".text",
        ".md",
        ".markdown",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".tif",
        ".tiff",
        ".csv",
        ".json",
    }
)


def _get_session_maker(request: Request):
    maker = getattr(request.app.state, "async_session_maker", None)
    if maker is None:
        raise HTTPException(
            status_code=503,
            detail="PostgreSQL is not configured. Set DATABASE_URL (e.g. postgresql+asyncpg://ollama:ollama@127.0.0.1:5432/ollama_chat) and run migrations/create tables.",
        )
    return maker


async def get_db(request: Request) -> AsyncSession:
    maker = _get_session_maker(request)
    async with maker() as session:
        yield session


class DocumentListItem(BaseModel):
    id: str
    original_filename: str
    char_count: int
    source_bytes: int
    mineru_backend: str
    embedding_status: str = "pending"
    embedding_model: Optional[str] = None
    chunk_count: int = 0
    embedding_error: Optional[str] = None
    markdown_token_count: int = 0
    chunks_token_count: int = 0
    mineru_duration_ms: int = 0
    embedding_duration_ms: int = 0
    total_processing_ms: int = 0
    created_at: Any


class DocumentDetail(BaseModel):
    id: str
    original_filename: str
    char_count: int
    source_bytes: int
    mineru_backend: str
    markdown: str
    extra_meta: Optional[dict] = None
    embedding_status: str = "pending"
    embedding_model: Optional[str] = None
    embedding_dim: Optional[int] = None
    chunk_count: int = 0
    embedding_error: Optional[str] = None
    markdown_token_count: int = 0
    chunks_token_count: int = 0
    mineru_duration_ms: int = 0
    embedding_duration_ms: int = 0
    total_processing_ms: int = 0
    embedded_at: Any = None
    created_at: Any


def _document_summary(row: StoredDocument) -> dict:
    return {
        "id": str(row.id),
        "original_filename": row.original_filename,
        "char_count": int(row.char_count),
        "source_bytes": int(row.source_bytes),
        "mineru_backend": row.mineru_backend,
        "embedding_status": row.embedding_status or "pending",
        "embedding_model": row.embedding_model,
        "chunk_count": int(row.chunk_count or 0),
        "embedding_error": row.embedding_error,
        "markdown_token_count": int(row.markdown_token_count or 0),
        "chunks_token_count": int(row.chunks_token_count or 0),
        "mineru_duration_ms": int(row.mineru_duration_ms or 0),
        "embedding_duration_ms": int(row.embedding_duration_ms or 0),
        "total_processing_ms": int(row.total_processing_ms or 0),
        "created_at": row.created_at,
    }


class ChatArchiveBody(BaseModel):
    title: str = Field(default="Chat", max_length=512)
    model: Optional[str] = None
    payload: dict = Field(description="Arbitrary JSON: messages, ollamaHistory, libraryDocumentIds, etc.")


@router.get("/documents", response_model=dict)
async def list_documents(
    request: Request,
    q: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(StoredDocument).order_by(StoredDocument.created_at.desc()).limit(limit).offset(offset)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = select(StoredDocument).where(StoredDocument.original_filename.ilike(like))
        stmt = stmt.order_by(StoredDocument.created_at.desc()).limit(limit).offset(offset)

    res = await db.execute(stmt)
    rows = res.scalars().all()

    count_stmt = select(func.count()).select_from(StoredDocument)
    if q and q.strip():
        like = f"%{q.strip()}%"
        count_stmt = select(func.count()).select_from(StoredDocument).where(
            StoredDocument.original_filename.ilike(like)
        )
    total = (await db.execute(count_stmt)).scalar_one()

    return {
        "items": [_document_summary(r) for r in rows],
        "total": int(total),
        "limit": limit,
        "offset": offset,
    }


@router.get("/documents/{doc_id}", response_model=DocumentDetail)
async def get_document(doc_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(StoredDocument, doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentDetail(
        id=str(row.id),
        original_filename=row.original_filename,
        char_count=int(row.char_count),
        source_bytes=int(row.source_bytes),
        mineru_backend=row.mineru_backend,
        markdown=row.markdown,
        extra_meta=row.extra_meta,
        embedding_status=row.embedding_status or "pending",
        embedding_model=row.embedding_model,
        embedding_dim=row.embedding_dim,
        chunk_count=int(row.chunk_count or 0),
        embedding_error=row.embedding_error,
        markdown_token_count=int(row.markdown_token_count or 0),
        chunks_token_count=int(row.chunks_token_count or 0),
        mineru_duration_ms=int(row.mineru_duration_ms or 0),
        embedding_duration_ms=int(row.embedding_duration_ms or 0),
        total_processing_ms=int(row.total_processing_ms or 0),
        embedded_at=row.embedded_at,
        created_at=row.created_at,
    )


@router.post("/documents", response_model=dict)
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type {suffix!r}. Allowed: {', '.join(sorted(ALLOWED_SUFFIXES))}",
        )

    max_bytes = int(os.getenv("DOC_UPLOAD_MAX_MB", "80")) * 1024 * 1024
    tmp_path: Optional[Path] = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = Path(tmp.name)
            total = 0
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large (max {max_bytes // (1024 * 1024)} MB)",
                    )
                tmp.write(chunk)

        digest = sha256_file(tmp_path)

        existing = await db.execute(select(StoredDocument).where(StoredDocument.content_sha256 == digest))
        hit = existing.scalar_one_or_none()
        if hit:
            return {
                "id": str(hit.id),
                "original_filename": hit.original_filename,
                "char_count": int(hit.char_count),
                "deduplicated": True,
                "message": "Same file already processed; returning existing record.",
            }

        mineru_started = time.perf_counter()
        try:
            markdown, meta = await asyncio.to_thread(parse_file_with_mineru, tmp_path)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        mineru_duration_ms = int((time.perf_counter() - mineru_started) * 1000)

        markdown = normalize_document_for_llm(markdown)

        max_store = int(os.getenv("DOC_STORE_MAX_CHARS", "2_000_000"))
        truncated_note = ""
        if len(markdown) > max_store:
            markdown = markdown[:max_store] + "\n\n[… truncated at storage limit …]"
            truncated_note = "truncated"

        # Estimate the token cost of attaching the full markdown to a chat. The
        # actual count is approximate (tiktoken cl100k_base ≈ Qwen) but stable
        # enough to power the docs page + context-budget UI.
        markdown_tokens = count_tokens(markdown)

        row = StoredDocument(
            original_filename=file.filename,
            content_sha256=digest,
            markdown=markdown,
            char_count=len(markdown),
            source_bytes=total,
            mineru_backend=os.getenv("MINERU_BACKEND", "pipeline"),
            extra_meta={**meta, "truncated_storage": bool(truncated_note)},
            embedding_status="pending",
            markdown_token_count=markdown_tokens,
            mineru_duration_ms=mineru_duration_ms,
            # `embedding_duration_ms` and `total_processing_ms` are filled in
            # by the indexer once it finishes embedding chunks.
        )
        db.add(row)
        try:
            await db.commit()
            await db.refresh(row)
        except IntegrityError:
            await db.rollback()
            existing2 = await db.execute(
                select(StoredDocument).where(StoredDocument.content_sha256 == digest)
            )
            hit2 = existing2.scalar_one()
            # Schedule indexing in case the existing copy was never embedded
            # (or previously failed). It's a no-op if already 'ready'.
            maker = _get_session_maker(request)
            index_document_background(maker, hit2.id)
            return {
                "id": str(hit2.id),
                "original_filename": hit2.original_filename,
                "char_count": int(hit2.char_count),
                "deduplicated": True,
                "embedding_status": hit2.embedding_status or "pending",
                "message": "Same file was stored concurrently; returning existing record.",
            }

        maker = _get_session_maker(request)
        index_document_background(maker, row.id)

        return {
            "id": str(row.id),
            "original_filename": row.original_filename,
            "char_count": int(row.char_count),
            "source_bytes": int(row.source_bytes),
            "mineru_backend": row.mineru_backend,
            "embedding_status": row.embedding_status or "pending",
            "markdown_token_count": int(row.markdown_token_count or 0),
            "mineru_duration_ms": int(row.mineru_duration_ms or 0),
            "deduplicated": False,
        }
    finally:
        if tmp_path and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


@router.post("/documents/{doc_id}/reindex")
async def reindex_document(
    doc_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(StoredDocument, doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    row.embedding_status = "pending"
    row.embedding_error = None
    await db.commit()
    maker = _get_session_maker(request)
    index_document_background(maker, row.id, force=True)
    return {
        "ok": True,
        "id": str(doc_id),
        "embedding_status": "pending",
    }


@router.get("/documents/{doc_id}/embedding")
async def document_embedding_status(doc_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(StoredDocument, doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return {
        "id": str(row.id),
        "embedding_status": row.embedding_status or "pending",
        "embedding_model": row.embedding_model,
        "embedding_dim": row.embedding_dim,
        "chunk_count": int(row.chunk_count or 0),
        "embedding_error": row.embedding_error,
        "markdown_token_count": int(row.markdown_token_count or 0),
        "chunks_token_count": int(row.chunks_token_count or 0),
        "mineru_duration_ms": int(row.mineru_duration_ms or 0),
        "embedding_duration_ms": int(row.embedding_duration_ms or 0),
        "total_processing_ms": int(row.total_processing_ms or 0),
        "embedded_at": row.embedded_at,
    }


@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(StoredDocument, doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True, "id": str(doc_id)}


# --- Chat archive (optional server backup) ---


@router.put("/chats/archive/{client_session_id}")
async def upsert_chat_archive(
    client_session_id: str,
    body: ChatArchiveBody,
    db: AsyncSession = Depends(get_db),
):
    if len(client_session_id) > 80:
        raise HTTPException(status_code=400, detail="client_session_id too long")
    res = await db.execute(select(ChatArchive).where(ChatArchive.client_session_id == client_session_id))
    row = res.scalar_one_or_none()
    if row:
        row.title = body.title
        row.model = body.model
        row.payload = body.payload
    else:
        row = ChatArchive(
            client_session_id=client_session_id,
            title=body.title,
            model=body.model,
            payload=body.payload,
        )
        db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"ok": True, "id": str(row.id), "client_session_id": client_session_id}


@router.get("/chats/archive/{client_session_id}")
async def get_chat_archive(client_session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(ChatArchive).where(ChatArchive.client_session_id == client_session_id))
    row = res.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="No archive for this session id")
    return {
        "id": str(row.id),
        "client_session_id": row.client_session_id,
        "title": row.title,
        "model": row.model,
        "payload": row.payload,
        "updated_at": row.updated_at,
    }


@router.get("/chats/archives")
async def list_chat_archives(
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(
        select(ChatArchive).order_by(ChatArchive.updated_at.desc()).limit(limit).offset(offset)
    )
    rows = res.scalars().all()
    total = (await db.execute(select(func.count()).select_from(ChatArchive))).scalar_one()
    return {
        "items": [
            {
                "id": str(r.id),
                "client_session_id": r.client_session_id,
                "title": r.title,
                "model": r.model,
                "updated_at": r.updated_at,
            }
            for r in rows
        ],
        "total": int(total),
    }


async def markdown_from_saved_ids(db: AsyncSession, ids: Optional[List[str]]) -> str:
    if not ids:
        return ""
    parts: list[str] = []
    for raw in ids:
        try:
            uid = uuid.UUID(str(raw))
        except ValueError:
            continue
        row = await db.get(StoredDocument, uid)
        if row:
            parts.append(f"### {row.original_filename}\n\n{row.markdown}")
    return "\n\n---\n\n".join(parts)
