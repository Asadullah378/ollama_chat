import json
import os
from typing import Any, AsyncIterator, Dict, List, Literal, Optional, Sequence, Tuple, Union

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from ollama import ResponseError
from pydantic import BaseModel, ConfigDict, Field

from document_text import (
    build_document_system_content,
    normalize_document_for_llm,
    sanitize_leaked_thinking_content,
    strip_prior_document_system_messages,
)
from rag import OllamaEmbedder, retrieve_for_query
from rag.embedder import EmbeddingError
from rag.retriever import build_retrieval_context
from routers.library import markdown_from_saved_ids

router = APIRouter()

DEFAULT_WEATHER_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "get_current_weather",
        "description": "Return plausible mock weather for a location (demo tool).",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City and region, e.g. San Francisco, CA",
                }
            },
            "required": ["location"],
        },
    },
}


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"


def _ollama_base_url() -> str:
    return os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


def _parse_args(raw: Any) -> dict:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return {}


def _run_mock_weather(args: dict) -> str:
    loc = args.get("location") or args.get("city") or "Unknown"
    payload = {
        "location": loc,
        "temperature_c": 21,
        "conditions": "Partly cloudy",
        "humidity_pct": 58,
        "source": "mock_tool",
    }
    return json.dumps(payload)


def _dispatch_tool(name: str, args: dict) -> str:
    if name == "get_current_weather":
        return _run_mock_weather(args)
    return json.dumps({"error": f"Unknown tool: {name}"})


class ChatMessageIn(BaseModel):
    role: str
    content: Optional[str] = None
    images: Optional[List[str]] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_name: Optional[str] = None


class ChatBody(BaseModel):
    model: str
    messages: List[ChatMessageIn]
    options: Optional[Dict[str, Any]] = None
    tools: Optional[List[Dict[str, Any]]] = None
    enable_default_tools: bool = Field(
        default=False,
        description="When true, registers get_current_weather unless tools are provided.",
    )
    images: Optional[List[str]] = Field(
        default=None,
        description="If set, merges into the last user message as base64 strings.",
    )
    document_context: Optional[str] = Field(
        default=None,
        description="Optional extra Markdown prepended as a system message (e.g. pasted notes).",
    )
    saved_document_ids: Optional[List[str]] = Field(
        default=None,
        description="UUIDs of documents stored in PostgreSQL (/api/documents); Markdown is loaded server-side.",
    )
    think: Optional[Union[bool, Literal["low", "medium", "high"]]] = Field(
        default=True,
        description="When true, Ollama may stream extended thinking/reasoning for supported models.",
    )
    rag_enabled: Optional[bool] = Field(
        default=None,
        description=(
            "If true and saved_document_ids are attached, retrieve top-K chunks from pgvector "
            "instead of stuffing entire markdown. If false (or null), the legacy "
            "full-markdown approach is used. Has no effect without attached documents."
        ),
    )


class GenerateBody(BaseModel):
    model: str
    prompt: str
    options: Optional[Dict[str, Any]] = None
    images: Optional[List[str]] = None
    system: Optional[str] = None
    template: Optional[str] = None
    raw: Optional[bool] = None


class EmbedBody(BaseModel):
    model: str
    input: Union[str, List[str]]
    truncate: Optional[bool] = None
    options: Optional[Dict[str, Any]] = None
    dimensions: Optional[int] = None


class ShowBody(BaseModel):
    model: str


class PullBody(BaseModel):
    model: str
    insecure: Optional[bool] = False


class PushBody(BaseModel):
    model: str
    insecure: Optional[bool] = False
    stream: bool = True


class CreateBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(description="New model name")
    modelfile: Optional[str] = None
    from_: Optional[str] = Field(default=None, alias="from")
    system: Optional[str] = None
    template: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None
    stream: bool = True


class CopyBody(BaseModel):
    source: str
    destination: str


def _messages_to_ollama(msgs: Sequence[ChatMessageIn]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for m in msgs:
        d: Dict[str, Any] = {"role": m.role}
        if m.content is not None:
            d["content"] = m.content
        if m.images:
            d["images"] = m.images
        if m.tool_calls is not None:
            d["tool_calls"] = m.tool_calls
        if m.tool_name is not None:
            d["tool_name"] = m.tool_name
        out.append(d)
    return out


async def _raw_create_stream(name: str, modelfile: str) -> AsyncIterator[dict]:
    url = f"{_ollama_base_url()}/api/create"
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            url,
            json={"name": name, "modelfile": modelfile, "stream": True},
        ) as resp:
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                text = await e.response.aread()
                raise HTTPException(status_code=e.response.status_code, detail=text.decode() or str(e))
            async for line in resp.aiter_lines():
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


async def _merged_document_context(request: Request, body: ChatBody) -> Optional[str]:
    parts: List[str] = []
    if body.document_context and str(body.document_context).strip():
        parts.append(str(body.document_context).strip())
    if body.saved_document_ids:
        maker = getattr(request.app.state, "async_session_maker", None)
        if maker is None:
            raise HTTPException(
                status_code=503,
                detail="Saved documents require DATABASE_URL (PostgreSQL). Configure the database to attach library documents.",
            )
        async with maker() as session:
            md = await markdown_from_saved_ids(session, body.saved_document_ids)
        if md:
            parts.append(md)
    if not parts:
        return None
    return "\n\n---\n\n".join(parts)


def _last_user_text(messages: List[Dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
    return ""


def _build_rag_system_prompt(retrieved_md: str, extra_context: Optional[str]) -> str:
    head_extra = ""
    if extra_context and str(extra_context).strip():
        head_extra = (
            "Additional notes provided by the user:\n\n"
            f"{str(extra_context).strip()}\n\n---\n\n"
        )
    return (
        "You are a helpful assistant. The user attached document(s) and the most "
        "relevant excerpts (retrieved via embeddings) are included below.\n"
        "Rules:\n"
        "- Answer ONLY from the provided excerpts. Cite the source (e.g. \"Source 2\") when useful.\n"
        "- If the information is not present in the excerpts, say so briefly and suggest the user "
        "  re-ask or disable RAG to use the full document.\n"
        "- Tables may use `|` columns; read row labels and the cell beside them.\n"
        "- Give a short direct answer first, then optional detail. Do not repeat your reasoning.\n\n"
        f"{head_extra}"
        "--- RETRIEVED CONTEXT (Markdown) ---\n"
        f"{retrieved_md}\n"
        "--- END RETRIEVED CONTEXT ---"
    )


async def _retrieve_rag_context(
    request: Request,
    body: ChatBody,
    working_messages: List[Dict[str, Any]],
) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    """
    If RAG is enabled and saved docs are attached, embed the latest user query,
    retrieve top-K chunks, and return (system_prompt, source_payloads). Falls
    back to (None, []) so the caller can use the full-doc path.
    """
    if not body.saved_document_ids:
        return None, []
    if not body.rag_enabled:
        return None, []

    query = _last_user_text(working_messages)
    if not query:
        return None, []

    maker = getattr(request.app.state, "async_session_maker", None)
    if maker is None:
        raise HTTPException(
            status_code=503,
            detail="RAG requires DATABASE_URL (PostgreSQL).",
        )

    embedder = OllamaEmbedder()
    try:
        async with maker() as session:
            chunks = await retrieve_for_query(
                session,
                query,
                body.saved_document_ids,
                embedder=embedder,
            )
    except EmbeddingError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not generate query embedding ({e}). Check that the embedding "
            f"model is pulled (`ollama pull {embedder.model}`) and Ollama is running.",
        ) from e

    if not chunks:
        return None, []

    retrieved_md = build_retrieval_context(chunks)
    system_prompt = _build_rag_system_prompt(retrieved_md, body.document_context)
    sources = [c.to_source() for c in chunks]
    return system_prompt, sources


def _inject_document_context(messages: List[Dict[str, Any]], document_context: Optional[str]) -> None:
    if not document_context or not str(document_context).strip():
        return
    max_c = int(os.getenv("DOC_CONTEXT_MAX_CHARS", "200000"))
    raw = str(document_context).strip()[:max_c]
    doc = normalize_document_for_llm(raw)
    instruction = build_document_system_content(doc)
    messages.insert(0, {"role": "system", "content": instruction})


def _inject_rag_system(messages: List[Dict[str, Any]], rag_system: str) -> None:
    messages.insert(0, {"role": "system", "content": rag_system})


def _friendly_error_message(e: Exception) -> str:
    """Convert raw library errors into user-friendly text for the chat UI."""
    if isinstance(e, ResponseError):
        msg = str(e).strip()
        sc = getattr(e, "status_code", None)
        if not msg or msg == str(sc):
            msg = "Ollama returned an error."
        if sc == 404:
            return f"Model not found. Did you `ollama pull` it? ({msg})"
        if sc in (502, 503, 504):
            return f"Ollama is unreachable. Is the server running? ({msg})"
        return msg
    if isinstance(e, HTTPException):
        return str(e.detail)
    txt = str(e).strip() or e.__class__.__name__
    if "Connection refused" in txt or "Failed to connect" in txt:
        return "Could not reach Ollama. Make sure the daemon is running."
    return txt


def _effective_think(model: str, think: Any, has_documents: bool) -> Any:
    """
    Qwen3.x often leaks long reasoning into `content` when think=true on document QA.
    Default: disable think for Qwen + attached library docs (override with DOC_CHAT_DISABLE_THINK_FOR_QWEN=false).
    """
    if not has_documents:
        return think
    flag = os.getenv("DOC_CHAT_DISABLE_THINK_FOR_QWEN", "true").strip().lower()
    if flag not in ("1", "true", "yes", "on"):
        return think
    if "qwen" in (model or "").lower():
        return False
    return think


@router.post("/chat")
async def chat(request: Request, body: ChatBody):
    client = request.app.state.ollama
    working = strip_prior_document_system_messages(_messages_to_ollama(body.messages))

    rag_sources: List[Dict[str, Any]] = []
    rag_system: Optional[str] = None
    has_documents = False

    use_rag = bool(body.rag_enabled and body.saved_document_ids)
    if use_rag:
        rag_system, rag_sources = await _retrieve_rag_context(request, body, working)

    if rag_system:
        _inject_rag_system(working, rag_system)
        has_documents = True
    else:
        # Either RAG disabled, no attached docs, or no retrieved chunks → fallback.
        merged_ctx = await _merged_document_context(request, body)
        has_documents = bool(merged_ctx and str(merged_ctx).strip())
        _inject_document_context(working, merged_ctx)

    think_param = _effective_think(body.model, body.think, has_documents)
    if body.images:
        for i in range(len(working) - 1, -1, -1):
            if working[i].get("role") == "user":
                imgs = list(working[i].get("images") or [])
                imgs.extend(body.images)
                working[i]["images"] = imgs
                break

    tools: Optional[List[Dict[str, Any]]]
    if body.tools is not None:
        tools = list(body.tools)
    elif body.enable_default_tools:
        tools = [DEFAULT_WEATHER_TOOL]
    else:
        tools = None

    opts = body.options

    async def gen():
        rounds = 0
        try:
            if rag_sources:
                yield _sse({"type": "retrieval", "mode": "rag", "sources": rag_sources})
            elif use_rag and not rag_system:
                # User asked for RAG but nothing matched / docs not embedded yet.
                yield _sse(
                    {
                        "type": "retrieval",
                        "mode": "fallback_full",
                        "sources": [],
                        "message": "No relevant chunks found — falling back to full document context.",
                    }
                )

            while rounds < 12:
                rounds += 1
                yield _sse({"type": "round_start", "round": rounds})
                stream_it = await client.chat(
                    model=body.model,
                    messages=working,
                    tools=tools,
                    stream=True,
                    options=opts,
                    think=think_param,
                )
                acc_content = ""
                acc_thinking = ""
                last_tool_calls: Optional[List[Dict[str, Any]]] = None
                async for part in stream_it:
                    payload = part.model_dump(mode="json", exclude_none=True)
                    msg = part.message
                    if msg.content:
                        acc_content += msg.content
                    if getattr(msg, "thinking", None):
                        acc_thinking += msg.thinking
                    yield _sse({"type": "ollama_chunk", "chunk": payload})
                    if msg.tool_calls:
                        last_tool_calls = [tc.model_dump(mode="json") for tc in msg.tool_calls]

                final_content = acc_content
                if acc_thinking or think_param:
                    final_content = sanitize_leaked_thinking_content(acc_content, acc_thinking)
                assistant: Dict[str, Any] = {"role": "assistant", "content": final_content}
                if acc_thinking:
                    assistant["thinking"] = acc_thinking
                if last_tool_calls:
                    assistant["tool_calls"] = last_tool_calls
                    working.append(assistant)
                    for tc in last_tool_calls:
                        fn = tc.get("function") or {}
                        name = fn.get("name") or ""
                        args = _parse_args(fn.get("arguments"))
                        yield _sse({"type": "tool_executing", "name": name, "arguments": args})
                        result = _dispatch_tool(name, args)
                        yield _sse({"type": "tool_done", "name": name, "result": result})
                        working.append(
                            {
                                "role": "tool",
                                "content": result,
                                "tool_name": name,
                            }
                        )
                    continue

                if not (final_content.strip() or acc_thinking.strip()):
                    yield _sse(
                        {
                            "type": "error",
                            "message": (
                                "The model returned an empty response. Try again, "
                                "switch to a smaller / different model, or shorten the "
                                "attached documents."
                            ),
                            "empty": True,
                        }
                    )
                    return

                working.append(assistant)
                yield _sse({"type": "finished", "messages": working})
                return

            yield _sse({"type": "error", "message": "Too many tool rounds"})
        except ResponseError as e:
            yield _sse(
                {
                    "type": "error",
                    "message": _friendly_error_message(e),
                    "status_code": e.status_code,
                }
            )
        except HTTPException as e:
            yield _sse(
                {
                    "type": "error",
                    "message": _friendly_error_message(e),
                    "status_code": e.status_code,
                }
            )
        except Exception as e:  # noqa: BLE001
            yield _sse({"type": "error", "message": _friendly_error_message(e)})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/generate")
async def generate(request: Request, body: GenerateBody):
    client = request.app.state.ollama

    async def gen():
        try:
            stream_it = await client.generate(
                model=body.model,
                prompt=body.prompt,
                system=body.system,
                template=body.template,
                raw=body.raw if body.raw is not None else False,
                images=body.images,
                options=body.options,
                stream=True,
            )
            async for part in stream_it:
                yield _sse({"type": "ollama_chunk", "chunk": part.model_dump(mode="json", exclude_none=True)})
        except ResponseError as e:
            yield _sse({"type": "error", "message": str(e), "status_code": e.status_code})
        except Exception as e:
            yield _sse({"type": "error", "message": str(e)})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/embed")
async def embed(request: Request, body: EmbedBody):
    client = request.app.state.ollama
    try:
        res = await client.embed(
            model=body.model,
            input=body.input,
            truncate=body.truncate,
            options=body.options,
            dimensions=body.dimensions,
        )
        return res.model_dump(mode="json", exclude_none=True)
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.get("/tags")
@router.get("/models")
async def list_models(request: Request):
    client = request.app.state.ollama
    try:
        return (await client.list()).model_dump(mode="json", exclude_none=True)
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.get("/ps")
async def ps(request: Request):
    client = request.app.state.ollama
    try:
        return (await client.ps()).model_dump(mode="json", exclude_none=True)
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.post("/show")
async def show(request: Request, body: ShowBody):
    client = request.app.state.ollama
    try:
        return (await client.show(body.model)).model_dump(
            mode="json", exclude_none=True, by_alias=True
        )
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.post("/pull")
async def pull(request: Request, body: PullBody):
    client = request.app.state.ollama

    async def gen():
        try:
            stream_it = await client.pull(model=body.model, insecure=bool(body.insecure), stream=True)
            async for prog in stream_it:
                yield _sse({"type": "progress", "data": prog.model_dump(mode="json", exclude_none=True)})
        except ResponseError as e:
            yield _sse({"type": "error", "message": str(e), "status_code": e.status_code})
        except Exception as e:
            yield _sse({"type": "error", "message": str(e)})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/push")
async def push(request: Request, body: PushBody):
    client = request.app.state.ollama

    if not body.stream:
        try:
            res = await client.push(model=body.model, insecure=bool(body.insecure), stream=False)
            return res.model_dump(mode="json", exclude_none=True)
        except ResponseError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    async def gen():
        try:
            stream_it = await client.push(model=body.model, insecure=bool(body.insecure), stream=True)
            async for prog in stream_it:
                yield _sse({"type": "progress", "data": prog.model_dump(mode="json", exclude_none=True)})
        except ResponseError as e:
            yield _sse({"type": "error", "message": str(e), "status_code": e.status_code})
        except Exception as e:
            yield _sse({"type": "error", "message": str(e)})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/create")
async def create(request: Request, body: CreateBody):
    client = request.app.state.ollama

    if body.modelfile and body.modelfile.strip():
        mf = body.modelfile
        if body.from_ and not mf.lstrip().upper().startswith("FROM"):
            mf = f"FROM {body.from_}\n{mf}"

        async def gen():
            try:
                async for chunk in _raw_create_stream(body.name, mf):
                    yield _sse({"type": "progress", "data": chunk})
            except HTTPException as e:
                yield _sse({"type": "error", "message": e.detail, "status_code": e.status_code})
            except Exception as e:
                yield _sse({"type": "error", "message": str(e)})

        if body.stream:
            return StreamingResponse(gen(), media_type="text/event-stream")

        buf: List[dict] = []
        try:
            async for chunk in _raw_create_stream(body.name, mf):
                buf.append(chunk)
        except HTTPException as e:
            raise e
        return {"ok": True, "events": buf}

    if not body.from_:
        raise HTTPException(status_code=400, detail="Provide modelfile or from (base model).")

    if body.stream:

        async def gen_sdk():
            try:
                stream_it = await client.create(
                    model=body.name,
                    from_=body.from_,
                    system=body.system,
                    template=body.template,
                    parameters=body.parameters,
                    stream=True,
                )
                async for prog in stream_it:
                    yield _sse({"type": "progress", "data": prog.model_dump(mode="json", exclude_none=True)})
            except ResponseError as e:
                yield _sse({"type": "error", "message": str(e), "status_code": e.status_code})
            except Exception as e:
                yield _sse({"type": "error", "message": str(e)})

        return StreamingResponse(gen_sdk(), media_type="text/event-stream")

    try:
        res = await client.create(
            model=body.name,
            from_=body.from_,
            system=body.system,
            template=body.template,
            parameters=body.parameters,
            stream=False,
        )
        return res.model_dump(mode="json", exclude_none=True)
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.post("/copy")
async def copy_model(request: Request, body: CopyBody):
    client = request.app.state.ollama
    try:
        return (await client.copy(body.source, body.destination)).model_dump(mode="json", exclude_none=True)
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.delete("/delete")
async def delete_model(request: Request, model: str = Query(..., min_length=1)):
    client = request.app.state.ollama
    try:
        return (await client.delete(model)).model_dump(mode="json", exclude_none=True)
    except ResponseError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
