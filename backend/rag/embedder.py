"""
Ollama embedding client (HTTP).

We call `/api/embed` directly with `httpx` instead of the `ollama` SDK so we can
control batching, timeouts, and friendly error messages. The default model is
`qwen3-embedding:latest` (1024 dim) and is overridable via `EMBEDDING_MODEL`.
"""

from __future__ import annotations

import os
from typing import List, Optional

import httpx


DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:latest"


class EmbeddingError(RuntimeError):
    """Raised when Ollama returns an error or unexpected response shape."""


class OllamaEmbedder:
    def __init__(
        self,
        *,
        model: Optional[str] = None,
        host: Optional[str] = None,
        batch_size: Optional[int] = None,
        timeout_sec: Optional[float] = None,
        dimensions: Optional[int] = None,
    ) -> None:
        self.model = (model or os.getenv("EMBEDDING_MODEL") or DEFAULT_EMBEDDING_MODEL).strip()
        self.host = (host or os.getenv("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
        self.batch_size = int(batch_size or int(os.getenv("EMBEDDING_BATCH_SIZE", "16")))
        self.timeout_sec = float(timeout_sec or float(os.getenv("EMBEDDING_TIMEOUT_SEC", "180")))

        # Optional Matryoshka dimension request. Qwen3-Embedding (0.6B/4B/8B)
        # honours this and returns vectors of the requested length, which lets
        # us keep the same EMBEDDING_DIM regardless of model size. Defaults to
        # EMBEDDING_DIM (the schema dim) so we never request a vector that
        # won't fit the document_chunks.embedding column.
        if dimensions is not None:
            self.dimensions: Optional[int] = int(dimensions)
        else:
            env_dim = os.getenv("EMBEDDING_REQUEST_DIM") or os.getenv("EMBEDDING_DIM")
            self.dimensions = int(env_dim) if env_dim and env_dim.strip() else None

    async def embed(self, inputs: List[str]) -> List[List[float]]:
        """Embed a list of strings. Returns same-length list of float vectors."""
        if not inputs:
            return []
        out: List[List[float]] = []
        timeout = httpx.Timeout(self.timeout_sec)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for i in range(0, len(inputs), self.batch_size):
                batch = inputs[i : i + self.batch_size]
                payload: dict = {"model": self.model, "input": batch}
                if self.dimensions:
                    payload["dimensions"] = self.dimensions
                try:
                    resp = await client.post(
                        f"{self.host}/api/embed",
                        json=payload,
                    )
                except httpx.HTTPError as e:
                    raise EmbeddingError(
                        f"Could not reach Ollama at {self.host}: {e}. "
                        f"Make sure the Ollama daemon is running."
                    ) from e

                if resp.status_code >= 400:
                    snippet = (resp.text or "").strip()
                    body = snippet
                    if len(body) > 240:
                        body = body[:240] + "…"
                    if resp.status_code == 404 or "not found" in snippet.lower():
                        raise EmbeddingError(
                            f"Embedding model {self.model!r} is not available on Ollama. "
                            f"Pull it once with: ollama pull {self.model}"
                        )
                    if "does not support" in snippet.lower() and "embed" in snippet.lower():
                        raise EmbeddingError(
                            f"Model {self.model!r} does not support embeddings. "
                            f"Use a dedicated embedding model, e.g. qwen3-embedding:latest."
                        )
                    raise EmbeddingError(
                        f"Ollama embed failed ({resp.status_code}): {body or resp.reason_phrase}"
                    )

                try:
                    data = resp.json()
                except ValueError as e:
                    raise EmbeddingError(
                        f"Ollama embed returned non-JSON response: {e}"
                    ) from e

                vectors = data.get("embeddings")
                # Some older Ollama builds use the singular `embedding` for /api/embed.
                if vectors is None and "embedding" in data:
                    single = data.get("embedding")
                    if isinstance(single, list) and single and isinstance(single[0], (int, float)):
                        vectors = [single] * 1 if len(batch) == 1 else None

                if not isinstance(vectors, list) or len(vectors) != len(batch):
                    err = data.get("error") if isinstance(data, dict) else None
                    detail = f": {err}" if err else ""
                    raise EmbeddingError(
                        f"Ollama embed returned {len(vectors) if isinstance(vectors, list) else 'no'} vectors "
                        f"for {len(batch)} inputs (model={self.model!r}){detail}."
                    )
                out.extend(vectors)
        return out


def embedder_from_env() -> OllamaEmbedder:
    return OllamaEmbedder()
