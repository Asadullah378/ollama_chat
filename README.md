# Ollama Studio

A local-first chat UI for [Ollama](https://ollama.com) with first-class document
support: drop in a PDF / DOCX / image-heavy report, the backend parses it with
[MinerU](https://github.com/opendatalab/mineru), embeds it with
[`qwen3-embedding`](https://ollama.com/library/qwen3-embedding) into a pgvector
table, and your chat model can either receive the **full markdown** or
**retrieved excerpts** depending on a per-chat toggle.

Everything — chats, sessions, documents, embeddings, preferences — lives in
PostgreSQL, so it survives reloads and restarts.

## Highlights

- **Local LLMs only.** Talks to a local Ollama instance over HTTP; no cloud API
  keys, no telemetry.
- **Two grounding modes per chat.**
  - *Full markdown:* attaches the whole parsed document to the prompt.
  - *RAG:* embeds the question, pulls the top-K matching chunks via pgvector
    cosine distance, and injects just those.
- **Smart Markdown chunking.** Headings preserved, fenced code and Markdown
  tables kept atomic, oversize blocks split with overlap.
- **Inline source citations.** When RAG is on, every `Source N` mention in the
  reply becomes a clickable cyan pill that scrolls to + highlights the matching
  excerpt in a collapsible panel.
- **Reasoning toggle.** Switch the Ollama `think=` flag on/off per chat. When
  on, the reasoning stream is shown in a collapsed accordion.
- **Light & dark themes** with FOUC-free initial paint and persisted choice.
- **Per-message persistence.** Content, reasoning, tool events, retrieved
  sources, attached library docs and `ollamaHistory` are all stored in
  PostgreSQL so reloads are lossless.

## Architecture

```
┌─────────────────┐     /api/* (proxy)     ┌──────────────────────────┐
│  React + Vite   │  ───────────────────►  │   FastAPI (Uvicorn)      │
│   (port 5173)   │                        │     (port 8000)          │
└─────────────────┘                        │                          │
                                           │  ┌──── routers/ ────┐    │
                                           │  │  chats / library │    │
                                           │  │  ollama_routes   │    │
                                           │  └──────────────────┘    │
                                           │  ┌──── rag/ ─────────┐   │
                                           │  │  chunker          │   │
                                           │  │  embedder (httpx) │   │
                                           │  │  indexer          │   │
                                           │  │  retriever        │   │
                                           │  └───────────────────┘   │
                                           └─────┬──────────┬─────────┘
                                                 │          │
                              SQLAlchemy + asyncpg│          │  httpx
                                                 ▼          ▼
                                       ┌──────────────┐  ┌──────────────┐
                                       │  PostgreSQL  │  │   Ollama     │
                                       │  + pgvector  │  │ (port 11434) │
                                       └──────────────┘  └──────────────┘
```

| Layer       | Tech                                                                  |
| ----------- | --------------------------------------------------------------------- |
| Frontend    | React 19, Vite 8, Tailwind v4, Zustand, react-markdown, lucide-react  |
| Backend     | FastAPI, async SQLAlchemy 2.x, asyncpg, httpx, python-dotenv          |
| Database    | PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector)  |
| Models      | Ollama (any chat model + a `qwen3-embedding` variant for retrieval)   |
| Parsing     | [MinerU](https://github.com/opendatalab/mineru) (invoked as a CLI)    |

## Repository layout

```
ollama_chat/
├── README.md
├── .gitignore
├── backend/
│   ├── main.py                # FastAPI entrypoint, lifespan, env loading
│   ├── requirements.txt
│   ├── .env.example           # Annotated configuration template
│   ├── mineru_runner.py       # Subprocess wrapper around `python -m mineru`
│   ├── document_text.py
│   ├── db/
│   │   ├── models.py          # StoredDocument, DocumentChunk, ChatSession, ChatMessage, …
│   │   ├── session.py         # Engine + idempotent additive migrations
│   │   └── migrate.py         # CLI: bootstrap / --reset-chunks / --reembed-all
│   ├── rag/
│   │   ├── chunker.py         # Heading-aware Markdown chunker
│   │   ├── embedder.py        # /api/embed client (Matryoshka `dimensions`)
│   │   ├── indexer.py         # Background indexing pipeline
│   │   └── retriever.py       # Top-K cosine retrieval + budgeted context
│   └── routers/
│       ├── chats.py           # /api/chats/* (sessions, messages, preferences)
│       ├── library.py         # /api/documents/* (upload, list, reindex)
│       └── ollama_routes.py   # /api/chat (SSE), /api/tags, /api/embed, …
└── frontend/
    ├── package.json
    ├── vite.config.js         # Dev proxy /api → http://127.0.0.1:8000
    ├── index.html             # FOUC-free theme bootstrap
    └── src/
        ├── App.jsx
        ├── components/        # ChatPage, DocumentsPage, MarkdownMessage, …
        ├── store/             # Zustand: chat, toasts, theme
        └── lib/               # api, theme, models, chatSync
```

## Prerequisites

- **Python 3.11+** (3.13 recommended)
- **Node.js 20+** and npm
- **PostgreSQL 14+** with the `vector` extension available
- **[Ollama](https://ollama.com/download)** running locally

> Apple Silicon users: MinerU pulls in PyTorch as a transitive dependency.
> Allow ~15 minutes for the first `pip install`.

### Pull the models you'll use

```bash
# A chat model (any of these works; pick what your machine can run)
ollama pull qwen3:8b           # or: llama3.2:3b, mistral, gpt-oss:20b, …

# The embedding model. 0.6b is the recommended default — it returns 1024-dim
# vectors natively, which fits pgvector's HNSW index limit.
ollama pull qwen3-embedding:0.6b
# (Or use any qwen3-embedding variant — the backend asks for 1024 dim via
# Matryoshka, so :latest / :4b / :8b also work.)
```

Make sure the daemon is running:

```bash
ollama serve   # or just open the Ollama menu-bar app
```

### Set up PostgreSQL + pgvector

```bash
# 1. Install pgvector for your Postgres distribution.
#    macOS (Homebrew): brew install pgvector
#    Ubuntu/Debian:    sudo apt install postgresql-XX-pgvector
#    Docker:           use the `pgvector/pgvector:pg16` image

# 2. Create a database and (optionally) a dedicated role.
psql -U postgres <<'SQL'
CREATE USER ollama WITH PASSWORD 'ollama';
CREATE DATABASE ollama_chat OWNER ollama;
SQL
```

The backend enables the `vector` extension itself on first startup (via
`CREATE EXTENSION IF NOT EXISTS vector`). If your role can't create extensions,
run this once as a superuser:

```bash
psql -U postgres -d ollama_chat -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

## Backend setup

```bash
cd backend

# 1. Virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Dependencies (this pulls PyTorch via mineru[all] — see note above)
pip install --upgrade pip
pip install -r requirements.txt

# 3. Configuration. Edit DATABASE_URL + EMBEDDING_MODEL if you changed defaults.
cp .env.example .env

# 4. (Optional) bootstrap the schema explicitly. The same migration runs
#    automatically on every API startup, so this step is only needed if you
#    want to verify things before launching the server.
python -m db.migrate

# 5. Run the API
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

On startup the backend will:

1. Load `backend/.env`.
2. Create tables (`stored_documents`, `document_chunks`, `chat_sessions`,
   `chat_messages`, `chat_preferences`) if they don't exist and apply any
   pending additive migrations.
3. Probe the configured embedding model and log its real output dimension. If
   it doesn't match the `document_chunks.embedding` column dimension you'll
   get an actionable log line — see *Troubleshooting* below.
4. Kick off background re-embedding for any documents whose status is
   `pending` or `failed`.

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to
`http://127.0.0.1:8000` (see `frontend/vite.config.js`), so you don't need to
fiddle with CORS during development.

### Production build

```bash
cd frontend
npm run build       # outputs static assets to frontend/dist/
npm run preview     # serve the built bundle locally for smoke-testing
```

In production you can either serve `frontend/dist/` from any static host (then
point it at the backend with a reverse proxy that forwards `/api/*`) or copy
the build output into a path that FastAPI serves itself.

## Configuration reference

Every option lives in `backend/.env`. Highlights:

| Variable                          | Default                                                          | Notes                                                                                  |
| --------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | `postgresql+asyncpg://ollama:ollama@127.0.0.1:5432/ollama_chat`  | Plain `postgresql://…` is rewritten to asyncpg on startup.                             |
| `OLLAMA_HOST`                     | `http://127.0.0.1:11434`                                         | Used by both the chat proxy and the embedder.                                          |
| `CORS_ORIGINS`                    | Vite dev origin                                                  | Comma-separated.                                                                       |
| `EMBEDDING_MODEL`                 | `qwen3-embedding:latest`                                         | Any Qwen3-Embedding tag works (Matryoshka).                                            |
| `EMBEDDING_DIM`                   | `1024`                                                           | Schema-defining. Must be ≤ 2000 for the HNSW index. Recreate chunks after changing it. |
| `EMBEDDING_BATCH_SIZE`            | `16`                                                             | How many chunks per `/api/embed` call.                                                 |
| `EMBEDDING_TIMEOUT_SEC`           | `180`                                                            | Per-batch timeout for the embedder client.                                             |
| `RAG_TOP_K`                       | `12`                                                             | Maximum number of chunks fetched per query.                                            |
| `RAG_CONTEXT_MAX_CHARS`           | `30000`                                                          | Characters of retrieved context injected into the prompt.                              |
| `RAG_MIN_SIMILARITY`              | `0.2`                                                            | Floor for cosine similarity (1 − distance).                                            |
| `DOC_UPLOAD_MAX_MB`               | `80`                                                             | Document upload cap.                                                                   |
| `DOC_STORE_MAX_CHARS`             | `2000000`                                                        | Per-document Markdown cap.                                                             |
| `DOC_CONTEXT_MAX_CHARS`           | `200000`                                                         | Full-markdown attach cap (RAG-off mode).                                               |
| `DOC_CHAT_DISABLE_THINK_FOR_QWEN` | `true`                                                           | Disables `think=` when Qwen sees attached docs.                                        |
| `MINERU_BACKEND`                  | `pipeline`                                                       | `pipeline` (CPU), `hybrid`, `vlm`, …                                                   |
| `MINERU_TIMEOUT_SEC`              | `900`                                                            | MinerU subprocess timeout.                                                             |
| `LOG_LEVEL`                       | `INFO`                                                           | `DEBUG` is great for chasing embed/index issues.                                       |

See `backend/.env.example` for the annotated full list.

## Useful commands

```bash
# Apply any pending additive migrations (also runs automatically on startup).
cd backend && python -m db.migrate

# Drop & recreate document_chunks at the current EMBEDDING_DIM. Use this when
# you change the embedding model dimension or want to wipe vectors clean.
cd backend && python -m db.migrate --reset-chunks

# Flip every stored document to embedding_status='pending' so the API
# re-embeds them on next start. Combine with --reset-chunks for a full rebuild.
cd backend && python -m db.migrate --reset-chunks --reembed-all

# Lint the frontend
cd frontend && npm run lint
```

## Day-to-day usage

1. Open the app → light theme, RAG enabled, reasoning off by default.
2. Pick a chat model from the dropdown. Embedding models (`qwen3-embedding`,
   `nomic-embed`, `bge-*`, `e5-*`, …) are filtered out automatically.
3. (Optional) Click the **paperclip** to upload or attach existing documents.
4. Toggle:
   - **Brain** icon → Ollama `think=` flag (model reasoning).
   - **Database** icon → RAG. On = retrieved chunks injected. Off = full
     document markdown injected.
5. Send. Streaming reply appears in real time; if RAG was used you'll see a
   "Retrieved N excerpts" panel + clickable `Source N` pills.
6. **Double-click** a chat title (header or sidebar) to rename it.
7. The theme switcher in the top-right persists your choice in `localStorage`.

## Troubleshooting

**`embed failed: column cannot have more than 2000 dimensions for hnsw index`**
You raised `EMBEDDING_DIM` past 2000. Drop it back to ≤ 2000 (1024 is
recommended) and run `python -m db.migrate --reset-chunks`.

**`document_chunks.embedding stored dim=X but EMBEDDING_DIM=Y`**
The schema and the runtime config disagree. After changing `EMBEDDING_DIM`
in `.env`, run:

```bash
cd backend
python -m db.migrate --reset-chunks --reembed-all
```

**`Embedding model 'qwen3-embedding:…' is not available on Ollama`**
Pull it: `ollama pull qwen3-embedding:0.6b` (or whichever tag you set in
`EMBEDDING_MODEL`).

**`Model X does not support embeddings`**
You pointed `EMBEDDING_MODEL` at a chat model. Set it to an embedding model
(any `qwen3-embedding` tag, `nomic-embed-text`, `bge-m3`, etc.).

**The chat dropdown only shows "Select model"**
Either `/api/tags` returned an empty list (no models pulled yet) or every
model you have is recognised as an embedding model. Pull a chat model with
`ollama pull qwen3:8b` (or similar).

**A document is stuck on "Embedding…"**
Check the API logs — every step from chunking → batching → vector insert
prints under the `rag.*` loggers. Set `LOG_LEVEL=DEBUG` in `.env` for more
detail.

## License

This project is intended for personal / internal use. Bring your own license
file if you fork it.
