"""RAG (retrieval-augmented generation) helpers: chunking, embedding, retrieval."""

from .chunker import Chunk, chunk_markdown
from .embedder import OllamaEmbedder, embedder_from_env
from .indexer import index_document, index_document_background, reset_failed_indexing
from .retriever import RetrievedChunk, retrieve_for_query

__all__ = [
    "Chunk",
    "chunk_markdown",
    "OllamaEmbedder",
    "embedder_from_env",
    "index_document",
    "index_document_background",
    "reset_failed_indexing",
    "RetrievedChunk",
    "retrieve_for_query",
]
