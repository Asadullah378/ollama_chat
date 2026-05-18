/**
 * Heuristics for telling apart chat-capable LLMs from embedding-only models in
 * the local Ollama library.
 *
 * Ollama's `/api/tags` does not expose a `capabilities` field, so we rely on
 * two strong signals:
 *
 *   1. The model name (e.g. `qwen3-embedding`, `nomic-embed-text`,
 *      `mxbai-embed-large`, `bge-m3`, `e5-large`, `gte-small`,
 *      `arctic-embed`, `snowflake-arctic-embed`, `paraphrase-multilingual`,
 *      `multilingual-e5-*`, `all-minilm`, `stella`, `granite-embedding`,
 *      `sfr-embedding`, `instructor`, `text-embedding-*`).
 *   2. The model family/families reported in `details.families` — pure
 *      encoder families (`bert`, `xlm-roberta`, `jina-bert`, `t5`) are almost
 *      always embedding models in the Ollama ecosystem.
 *
 * Anything that fails both checks is treated as a chat model.
 */

const EMBEDDING_NAME_RE =
  /(?:^|[/_:.\-])(?:embed(?:ding)?|nomic-embed|mxbai-embed|bge[\-_]|e5[\-_]|gte[\-_]|arctic-embed|snowflake-arctic-embed|stella|paraphrase[\-_]|multilingual-e5|all[\-_]minilm|granite-embedding|sfr-embedding|instructor[\-_]|text-embedding)/i

const EMBEDDING_FAMILY_RE = /^(?:bert|xlm-roberta|jina-bert|t5|nomic-bert)$/i

/**
 * @param {{ model?: string, name?: string, details?: { family?: string, families?: string[] } }} m
 */
export function isEmbeddingModel(m) {
  if (!m) return false
  const name = String(m.model || m.name || '')
  if (EMBEDDING_NAME_RE.test(name)) return true
  const fam = m.details?.family
  if (fam && EMBEDDING_FAMILY_RE.test(String(fam))) return true
  const fams = m.details?.families
  if (Array.isArray(fams) && fams.some((f) => EMBEDDING_FAMILY_RE.test(String(f)))) {
    return true
  }
  return false
}

/**
 * Keep only models that can reasonably be used for chat (everything that is
 * not detected as embedding-only).
 *
 * @template T
 * @param {T[]} models
 * @returns {T[]}
 */
export function chatModelsOnly(models) {
  if (!Array.isArray(models)) return []
  return models.filter((m) => !isEmbeddingModel(m))
}
