from __future__ import annotations

import logging
import os
from typing import AsyncGenerator, Optional, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from db.models import EMBEDDING_DIM, Base

logger = logging.getLogger(__name__)


def _async_postgres_url(database_url: str) -> str:
    """
    SQLAlchemy async needs an async driver in the URL. Plain `postgresql://...`
    defaults to psycopg2 (sync); we use asyncpg.
    """
    u = database_url.strip()
    if "+asyncpg" in u.split("://", 1)[0]:
        return u
    if u.startswith("postgres://"):
        return "postgresql+asyncpg://" + u[len("postgres://") :]
    if u.startswith("postgresql://"):
        return "postgresql+asyncpg://" + u[len("postgresql://") :]
    return u


def create_db_engine(database_url: str) -> Tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    if not database_url.startswith("postgres"):
        raise ValueError(
            "Only postgres URLs are supported, e.g. postgresql+asyncpg://user:pass@host:5432/db"
        )
    url = _async_postgres_url(database_url)
    if "+asyncpg" not in url.split("://", 1)[0]:
        raise ValueError(
            "Use asyncpg in DATABASE_URL, e.g. postgresql+asyncpg://user:pass@host:5432/dbname"
        )
    engine = create_async_engine(
        url,
        pool_pre_ping=True,
        echo=os.getenv("SQL_ECHO", "").lower() in ("1", "true", "yes"),
    )
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    return engine, factory


# Idempotent ALTERs for upgrading existing installs to the RAG schema.
# `create_all` does not modify existing tables, so we add new columns
# explicitly here. All statements use IF NOT EXISTS so they are safe to
# run on every startup.
_ADDITIVE_MIGRATIONS = (
    "ALTER TABLE stored_documents ADD COLUMN IF NOT EXISTS embedding_status varchar(32) NOT NULL DEFAULT 'pending'",
    "ALTER TABLE stored_documents ADD COLUMN IF NOT EXISTS embedding_model varchar(128)",
    "ALTER TABLE stored_documents ADD COLUMN IF NOT EXISTS embedding_dim integer",
    "ALTER TABLE stored_documents ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0",
    "ALTER TABLE stored_documents ADD COLUMN IF NOT EXISTS embedding_error text",
    "ALTER TABLE stored_documents ADD COLUMN IF NOT EXISTS embedded_at timestamptz",
    "ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS rag_enabled boolean NOT NULL DEFAULT true",
    "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sources jsonb",
)


async def init_models(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        # pgvector extension must exist before Base.metadata.create_all can
        # create the `embedding vector(N)` column on document_chunks.
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        except Exception as e:  # noqa: BLE001
            logger.error(
                "Could not enable pgvector extension automatically: %s\n"
                "  → Run `CREATE EXTENSION vector;` in your database as a superuser.\n"
                "  → RAG indexing will fail until pgvector is enabled.",
                e,
            )

        for stmt in _ADDITIVE_MIGRATIONS:
            try:
                await conn.execute(text(stmt))
            except Exception as e:  # noqa: BLE001
                logger.warning("Schema migration step failed (%s): %s", stmt, e)

        try:
            await conn.run_sync(Base.metadata.create_all)
        except Exception as e:  # noqa: BLE001
            logger.error(
                "Schema create_all failed: %s\n"
                "  → If this complains about the `vector` type, enable pgvector first.",
                e,
            )
            raise

        # If document_chunks already exists with a different vector dim,
        # the new HNSW index / queries will fail later. Detect and warn.
        try:
            result = await conn.execute(
                text(
                    """
                    SELECT a.atttypmod
                    FROM pg_attribute a
                    JOIN pg_class c ON a.attrelid = c.oid
                    WHERE c.relname = 'document_chunks'
                      AND a.attname = 'embedding'
                    """
                )
            )
            row = result.first()
            if row and row[0] and row[0] != EMBEDDING_DIM:
                logger.warning(
                    "document_chunks.embedding stored dim=%s but EMBEDDING_DIM=%s. "
                    "Drop the table and re-index to switch models.",
                    row[0],
                    EMBEDDING_DIM,
                )
        except Exception:
            pass
