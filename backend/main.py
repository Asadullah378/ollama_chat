"""FastAPI app entrypoint.

NOTE: `load_dotenv(...)` MUST run before any `from db.models …`-style import,
because `db/models.py` reads `EMBEDDING_DIM` from the environment at module
import time. If we load the env later, every module reads the default 1024
even when your .env says otherwise.
"""

from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env FIRST, before any module reads os.getenv at import time.
load_dotenv(Path(__file__).resolve().parent / ".env")

import logging  # noqa: E402
import os  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from ollama import AsyncClient  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

from db.models import StoredDocument  # noqa: E402
from db.session import create_db_engine, init_models  # noqa: E402
from rag import index_document_background  # noqa: E402
from rag.embedder import EmbeddingError, OllamaEmbedder  # noqa: E402
from routers import chats, library, ollama_routes  # noqa: E402

# Make sure our module loggers actually reach stdout under uvicorn. Without this,
# `logger.info(...)`/`logger.warning(...)` in db/, rag/, routers/ are swallowed
# because uvicorn only configures its own loggers, not the root logger.
_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# Tame asyncio chatter when DEBUG is on.
logging.getLogger("asyncio").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


async def _probe_embedding_dim(engine, factory) -> bool:
    """
    Read-only startup probe: call the embedding model once with a short input
    to detect its real output dimension, then compare with the current schema
    (the dim used when `document_chunks.embedding` was created).

    This NEVER mutates the database. It only:
      - logs the detected dim,
      - logs a clear actionable error on mismatch,
      - returns False so the backfill loop is skipped (otherwise every pending
        doc would repeatedly fail with the same dim error on every restart).

    To fix a mismatch, run:
        cd backend && python -m db.migrate --reset-chunks
    after updating EMBEDDING_DIM in backend/.env.
    """
    from db import models as db_models  # local import for current schema dim

    embedder = OllamaEmbedder()
    try:
        sample = await embedder.embed(["probe"])
    except EmbeddingError as e:
        logger.error(
            "RAG probe failed (model=%s, host=%s): %s\n"
            "  → Pull the model with: `ollama pull %s` and restart.",
            embedder.model, embedder.host, e, embedder.model,
        )
        return False
    except Exception as e:  # noqa: BLE001
        logger.error("RAG probe crashed: %s", e)
        return False

    if not sample or not sample[0]:
        logger.error("RAG probe: model %r returned no vectors.", embedder.model)
        return False

    detected = len(sample[0])
    schema_dim = db_models.EMBEDDING_DIM
    logger.info(
        "RAG probe: model=%s → %d-dim vectors (schema EMBEDDING_DIM=%d).",
        embedder.model, detected, schema_dim,
    )

    if detected == schema_dim:
        return True

    # Read-only count of existing chunks so the error message is actionable.
    row_count = -1
    try:
        async with factory() as session:
            res = await session.execute(text("SELECT COUNT(*) FROM document_chunks"))
            row_count = int(res.scalar_one() or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("RAG probe: cannot count document_chunks (%s).", e)

    logger.error(
        "\n"
        "======================================================================\n"
        "  RAG embedding dim mismatch — backfill skipped.\n"
        "    model              : %s\n"
        "    detected dim       : %d\n"
        "    schema column dim  : %d  (EMBEDDING_DIM)\n"
        "    rows in chunks tbl : %s\n"
        "  Fix:\n"
        "    1. Set EMBEDDING_DIM=%d in backend/.env (or switch to a model\n"
        "       whose output matches the current schema dim).\n"
        "    2. Drop & recreate the chunks table:\n"
        "         cd backend && python -m db.migrate --reset-chunks\n"
        "       (or in psql:  DROP TABLE document_chunks;  then restart.)\n"
        "    3. Re-embed your documents from the Docs page (Re-embed button)\n"
        "       or restart — pending docs are scheduled automatically.\n"
        "======================================================================",
        embedder.model, detected, schema_dim,
        row_count if row_count >= 0 else "?",
        detected,
    )
    return False


async def _backfill_pending_embeddings(factory) -> None:
    """Kick off indexing for any documents that are still pending/failed.

    Runs in the background so the API is responsive even if the user has a
    large backlog. Documents with status 'ready' are skipped.
    """
    try:
        async with factory() as session:
            res = await session.execute(
                select(StoredDocument.id).where(
                    StoredDocument.embedding_status.in_(("pending", "failed"))
                )
            )
            doc_ids = [row[0] for row in res.all()]
        for doc_id in doc_ids:
            index_document_background(factory, doc_id)
        if doc_ids:
            logger.info("RAG: scheduled embedding for %d pending document(s)", len(doc_ids))
    except Exception as e:  # noqa: BLE001
        logger.warning("RAG: failed to backfill pending embeddings: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    host = os.getenv("OLLAMA_HOST")
    app.state.ollama = AsyncClient(host=host) if host else AsyncClient()
    app.state.db_engine = None
    app.state.async_session_maker = None

    db_url = os.getenv("DATABASE_URL", "").strip()
    if db_url:
        engine, factory = create_db_engine(db_url)
        await init_models(engine)
        app.state.db_engine = engine
        app.state.async_session_maker = factory

        rag_ok = await _probe_embedding_dim(engine, factory)
        if rag_ok:
            await _backfill_pending_embeddings(factory)

    yield

    if app.state.db_engine is not None:
        await app.state.db_engine.dispose()
    await app.state.ollama.close()


app = FastAPI(title="Ollama Chat API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ollama_routes.router, prefix="/api")
app.include_router(library.router, prefix="/api")
app.include_router(chats.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}


frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if frontend_dist.exists() and frontend_dist.is_dir():
    app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

    @app.get("/{catchall:path}")
    async def serve_frontend(catchall: str):
        # Serve index.html for SPA routing
        return FileResponse(frontend_dist / "index.html")
