"""
Create or update the PostgreSQL schema.

Usage:

    # Apply pending schema (idempotent; runs on API startup too):
    cd backend && python -m db.migrate

    # Drop and recreate `document_chunks` with the current EMBEDDING_DIM
    # (use this whenever you change EMBEDDING_MODEL/EMBEDDING_DIM):
    cd backend && python -m db.migrate --reset-chunks

    # Re-flag every existing document so the API re-embeds them on next start
    # (combine with --reset-chunks for a full RAG rebuild):
    cd backend && python -m db.migrate --reset-chunks --reembed-all
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

# IMPORTANT: load .env BEFORE importing db.models, because db/models.py reads
# EMBEDDING_DIM from the environment at module import time. Loading the env
# afterwards has no effect — the model column dim would silently fall back to
# the default and you'd recreate the table with the wrong vector(N).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import argparse  # noqa: E402
import asyncio  # noqa: E402
import os  # noqa: E402

from sqlalchemy import text  # noqa: E402

from db.models import EMBEDDING_DIM, Base, DocumentChunk  # noqa: E402
from db.session import create_db_engine, init_models  # noqa: E402


async def reset_chunks(engine) -> None:
    """Drop document_chunks (and its HNSW index) and recreate it cleanly.

    Uses the model's current `Vector(EMBEDDING_DIM)` so the new column matches
    your active embedding model. All existing chunks are discarded.
    """
    print(
        f"Dropping document_chunks (any indexed embeddings will be lost) and "
        f"recreating with embedding vector({EMBEDDING_DIM})..."
    )
    async with engine.begin() as conn:
        await conn.execute(text("DROP INDEX IF EXISTS ix_document_chunks_embedding_hnsw"))
        await conn.execute(text("DROP TABLE IF EXISTS document_chunks CASCADE"))
        # Recreate via the SQLAlchemy model so column types + indexes stay
        # in sync with db/models.py — this includes the HNSW index.
        await conn.run_sync(
            lambda sync_conn: DocumentChunk.__table__.create(sync_conn, checkfirst=False)
        )
    print("document_chunks dropped and recreated.")


async def reembed_all(engine) -> None:
    """Mark every stored document as `pending` so the API re-embeds on next start."""
    print("Marking all stored_documents as embedding_status='pending'...")
    async with engine.begin() as conn:
        result = await conn.execute(
            text(
                "UPDATE stored_documents "
                "SET embedding_status='pending', embedding_error=NULL, "
                "    chunk_count=0, embedding_dim=NULL, embedded_at=NULL"
            )
        )
        print(f"Marked {result.rowcount} document(s) for re-embedding.")


async def run_migrate(reset: bool = False, reembed: bool = False) -> None:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is not set. Configure backend/.env first.")
    engine, _ = create_db_engine(url)
    try:
        # Always make sure the base schema + pgvector extension are in place.
        await init_models(engine)

        if reset:
            await reset_chunks(engine)
        if reembed:
            await reembed_all(engine)

        if not reset and not reembed:
            print(
                "Database schema is up to date "
                "(stored_documents, document_chunks, chat_sessions, "
                "chat_messages, chat_preferences, …)."
            )
        else:
            print("Restart the API so pending documents are re-embedded.")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset-chunks",
        action="store_true",
        help="DROP and recreate the document_chunks table with the current EMBEDDING_DIM.",
    )
    parser.add_argument(
        "--reembed-all",
        action="store_true",
        help="Mark every stored document as pending so the API re-embeds them.",
    )
    args = parser.parse_args()
    asyncio.run(run_migrate(reset=args.reset_chunks, reembed=args.reembed_all))


if __name__ == "__main__":
    main()
