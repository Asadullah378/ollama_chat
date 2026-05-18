from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import Any, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


# Embedding vector dimension. Default 1024 matches `qwen3-embedding:latest` (0.6B).
# Must match the model you configured in `EMBEDDING_MODEL`. Changing this after rows
# are stored requires dropping `document_chunks` (see db/migrate.py).
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "1024"))


class Base(DeclarativeBase):
    pass


class StoredDocument(Base):
    """Parsed document (MinerU Markdown) stored for reuse."""

    __tablename__ = "stored_documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    original_filename: Mapped[str] = mapped_column(String(512))
    content_sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    markdown: Mapped[str] = mapped_column(Text())
    char_count: Mapped[int] = mapped_column(BigInteger)
    source_bytes: Mapped[int] = mapped_column(BigInteger)
    mineru_backend: Mapped[str] = mapped_column(String(32), default="pipeline")
    extra_meta: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    # Token cost of the *full markdown* (estimated via tiktoken cl100k_base).
    # Used by the docs page to show "full-markdown mode cost" up front.
    markdown_token_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Sum of `DocumentChunk.token_estimate` over all chunks — denormalised so
    # the docs page can show the "RAG mode cost ceiling" without aggregating.
    chunks_token_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Timing breakdown for this document, in milliseconds.
    mineru_duration_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    embedding_duration_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    total_processing_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # RAG indexing state. One of: pending | embedding | ready | failed | disabled.
    embedding_status: Mapped[str] = mapped_column(String(32), default="pending", server_default="pending")
    embedding_model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    embedding_dim: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    embedding_error: Mapped[Optional[str]] = mapped_column(Text(), nullable=True)
    embedded_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    chunks: Mapped[list["DocumentChunk"]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        order_by="DocumentChunk.chunk_index",
    )


class DocumentChunk(Base):
    """A single chunk of a stored document with its dense embedding."""

    __tablename__ = "document_chunks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stored_documents.id", ondelete="CASCADE"),
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    heading_path: Mapped[str] = mapped_column(Text(), default="", server_default="")
    kind: Mapped[str] = mapped_column(String(16), default="text", server_default="text")
    content: Mapped[str] = mapped_column(Text())
    char_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    token_estimate: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    embedding: Mapped[Optional[list[float]]] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    document: Mapped["StoredDocument"] = relationship(back_populates="chunks")

    __table_args__ = (
        Index(
            "ix_document_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )


class ChatSession(Base):
    """A chat conversation (sidebar entry)."""

    __tablename__ = "chat_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(512), default="New chat")
    model: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    ollama_history: Mapped[Optional[list[Any]]] = mapped_column(JSONB, nullable=True)
    library_docs: Mapped[Optional[list[Any]]] = mapped_column(JSONB, nullable=True, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.sort_order",
    )


class ChatMessage(Base):
    """One message in a chat session."""

    __tablename__ = "chat_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text(), default="")
    thinking: Mapped[Optional[str]] = mapped_column(Text(), nullable=True)
    images: Mapped[Optional[list[Any]]] = mapped_column(JSONB, nullable=True)
    tool_events: Mapped[Optional[list[Any]]] = mapped_column(JSONB, nullable=True)
    # Retrieved RAG excerpts shown next to the message and used to render the
    # clickable "Source N" pills inside the markdown reply. Stored verbatim
    # (chunk_id, document_id, document_name, chunk_index, heading_path, kind,
    # similarity, preview) so the chat survives a reload with sources intact.
    sources: Mapped[Optional[list[Any]]] = mapped_column(JSONB, nullable=True)
    # Ollama-reported usage for the assistant turn that produced this message.
    # `prompt_tokens` is the entire conversation context Ollama just evaluated
    # (so summed across the chat it represents real context usage), and
    # `completion_tokens` is how many tokens this single reply generated.
    # All `*_duration_ms` fields are converted from Ollama's nanoseconds.
    prompt_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    total_duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    load_duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    prompt_eval_duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    eval_duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    session: Mapped["ChatSession"] = relationship(back_populates="messages")


class ChatPreferences(Base):
    """Singleton UI preferences (active session, default model, sidebar)."""

    __tablename__ = "chat_preferences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    active_session_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("chat_sessions.id", ondelete="SET NULL"),
        nullable=True,
    )
    default_model: Mapped[str] = mapped_column(String(256), default="")
    sidebar_open: Mapped[bool] = mapped_column(Boolean, default=True)
    rag_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )


class ChatArchive(Base):
    """Legacy JSON blob archive (superseded by chat_sessions + chat_messages)."""

    __tablename__ = "chat_archives"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_session_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(512))
    model: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )
