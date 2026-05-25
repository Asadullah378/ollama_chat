from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from db.models import ChatMessage, ChatPreferences, ChatSession
from routers.library import get_db

router = APIRouter()


class LibraryDocIn(BaseModel):
    id: str
    fileName: str = Field(default="document", alias="fileName")

    model_config = {"populate_by_name": True}


class MessageIn(BaseModel):
    id: str
    role: str
    content: str = ""
    thinking: Optional[str] = None
    images: Optional[List[str]] = None
    toolEvents: Optional[List[Any]] = Field(default=None, alias="toolEvents")
    sources: Optional[List[Any]] = None
    promptTokens: Optional[int] = Field(default=None, alias="promptTokens")
    completionTokens: Optional[int] = Field(default=None, alias="completionTokens")
    totalDurationMs: Optional[int] = Field(default=None, alias="totalDurationMs")
    loadDurationMs: Optional[int] = Field(default=None, alias="loadDurationMs")
    promptEvalDurationMs: Optional[int] = Field(default=None, alias="promptEvalDurationMs")
    evalDurationMs: Optional[int] = Field(default=None, alias="evalDurationMs")
    streaming: bool = False

    model_config = {"populate_by_name": True}


class SessionIn(BaseModel):
    id: Optional[str] = None
    title: str = "New chat"
    model: Optional[str] = None
    messages: List[MessageIn] = Field(default_factory=list)
    ollamaHistory: Optional[List[Any]] = Field(default=None, alias="ollamaHistory")
    libraryDocs: List[LibraryDocIn] = Field(default_factory=list, alias="libraryDocs")
    updatedAt: Optional[int] = Field(default=None, alias="updatedAt")

    model_config = {"populate_by_name": True}


class PreferencesIn(BaseModel):
    activeId: Optional[str] = None
    defaultModel: str = Field(default="", alias="defaultModel")
    sidebarOpen: bool = Field(default=True, alias="sidebarOpen")
    ragEnabled: bool = Field(default=True, alias="ragEnabled")

    model_config = {"populate_by_name": True}


def _ts(dt: Optional[datetime]) -> int:
    if dt is None:
        return int(datetime.now(timezone.utc).timestamp() * 1000)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _message_to_api(m: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(m.id),
        "role": m.role,
        "content": m.content or "",
    }
    if m.thinking:
        out["thinking"] = m.thinking
    if m.images:
        out["images"] = m.images
    if m.tool_events:
        out["toolEvents"] = m.tool_events
    if m.sources:
        out["sources"] = m.sources
    if m.prompt_tokens is not None:
        out["promptTokens"] = int(m.prompt_tokens)
    if m.completion_tokens is not None:
        out["completionTokens"] = int(m.completion_tokens)
    if m.total_duration_ms is not None:
        out["totalDurationMs"] = int(m.total_duration_ms)
    if m.load_duration_ms is not None:
        out["loadDurationMs"] = int(m.load_duration_ms)
    if m.prompt_eval_duration_ms is not None:
        out["promptEvalDurationMs"] = int(m.prompt_eval_duration_ms)
    if m.eval_duration_ms is not None:
        out["evalDurationMs"] = int(m.eval_duration_ms)
    return out


def _session_to_api(row: ChatSession) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "title": row.title,
        "model": row.model or "",
        "messages": [_message_to_api(m) for m in row.messages],
        "ollamaHistory": row.ollama_history or [],
        "libraryDocs": row.library_docs if isinstance(row.library_docs, list) else [],
        "updatedAt": _ts(row.updated_at),
    }


async def _get_or_create_preferences(db: AsyncSession) -> ChatPreferences:
    row = await db.get(ChatPreferences, 1)
    if row is None:
        row = ChatPreferences(id=1)
        db.add(row)
        await db.flush()
    return row


async def _set_active_session_id(
    db: AsyncSession, prefs: ChatPreferences, session_id: Optional[uuid.UUID]
) -> None:
    """FK to chat_sessions: only set after the session row exists."""
    if session_id is not None and await db.get(ChatSession, session_id) is None:
        session_id = None
    prefs.active_session_id = session_id


async def _load_session(db: AsyncSession, session_id: uuid.UUID) -> Optional[ChatSession]:
    res = await db.execute(
        select(ChatSession)
        .where(ChatSession.id == session_id)
        .options(selectinload(ChatSession.messages))
    )
    return res.scalar_one_or_none()


def _parse_uuid(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Invalid session id") from e


def _library_docs_payload(docs: List[LibraryDocIn]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for d in docs:
        if d.id:
            out.append({"id": d.id, "fileName": d.fileName or "document"})
    return out


async def _replace_messages(db: AsyncSession, session_id: uuid.UUID, messages: List[MessageIn]) -> None:
    await db.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
    for i, m in enumerate(messages):
        db.add(
            ChatMessage(
                id=_parse_uuid(m.id) if m.id else uuid.uuid4(),
                session_id=session_id,
                sort_order=i,
                role=m.role,
                content=m.content or "",
                thinking=m.thinking,
                images=m.images if m.images else None,
                tool_events=m.toolEvents if m.toolEvents else None,
                sources=m.sources if m.sources else None,
                prompt_tokens=m.promptTokens,
                completion_tokens=m.completionTokens,
                total_duration_ms=m.totalDurationMs,
                load_duration_ms=m.loadDurationMs,
                prompt_eval_duration_ms=m.promptEvalDurationMs,
                eval_duration_ms=m.evalDurationMs,
            )
        )


@router.get("/chats/bootstrap")
async def bootstrap(db: AsyncSession = Depends(get_db)):
    """Load all sessions (with messages) and UI preferences."""
    prefs = await _get_or_create_preferences(db)
    res = await db.execute(
        select(ChatSession).options(selectinload(ChatSession.messages)).order_by(ChatSession.updated_at.desc())
    )
    sessions = res.scalars().unique().all()

    active_id = str(prefs.active_session_id) if prefs.active_session_id else None
    if active_id and not any(str(s.id) == active_id for s in sessions):
        active_id = str(sessions[0].id) if sessions else None
        await _set_active_session_id(
            db, prefs, uuid.UUID(active_id) if active_id else None
        )
        await db.commit()

    return {
        "preferences": {
            "activeId": active_id,
            "defaultModel": prefs.default_model or "",
            "sidebarOpen": prefs.sidebar_open,
            "ragEnabled": bool(prefs.rag_enabled),
        },
        "sessions": [_session_to_api(s) for s in sessions],
    }


@router.post("/chats/sessions")
async def create_session(
    body: Optional[SessionIn] = None,
    db: AsyncSession = Depends(get_db),
):
    data = body or SessionIn()
    sid = _parse_uuid(data.id) if data.id else uuid.uuid4()
    row = ChatSession(
        id=sid,
        title=data.title or "New chat",
        model=data.model,
        ollama_history=data.ollamaHistory or [],
        library_docs=_library_docs_payload(data.libraryDocs),
    )
    db.add(row)
    await db.flush()
    if data.messages:
        await _replace_messages(db, sid, data.messages)
    prefs = await _get_or_create_preferences(db)
    await _set_active_session_id(db, prefs, sid)
    await db.commit()
    loaded = await _load_session(db, sid)
    assert loaded is not None
    return _session_to_api(loaded)


@router.get("/chats/sessions/{session_id}")
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    sid = _parse_uuid(session_id)
    row = await _load_session(db, sid)
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_to_api(row)


@router.put("/chats/sessions/{session_id}")
async def update_session(session_id: str, body: SessionIn, db: AsyncSession = Depends(get_db)):
    sid = _parse_uuid(session_id)
    # Lock the session row to serialize concurrent saves from the frontend and
    # prevent DELETE+INSERT race conditions on chat_messages.
    res = await db.execute(
        select(ChatSession)
        .where(ChatSession.id == sid)
        .options(selectinload(ChatSession.messages))
        .with_for_update()
    )
    row = res.scalar_one_or_none()
    if not row:
        row = ChatSession(id=sid)
        db.add(row)
        try:
            await db.flush()
        except Exception:
            # If a concurrent request already created it, roll back and re-fetch
            await db.rollback()
            res = await db.execute(
                select(ChatSession)
                .where(ChatSession.id == sid)
                .options(selectinload(ChatSession.messages))
                .with_for_update()
            )
            row = res.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=500, detail="Failed to lock session")
    row.title = body.title or row.title or "New chat"
    if body.model is not None:
        row.model = body.model
    if body.ollamaHistory is not None:
        row.ollama_history = body.ollamaHistory
    if body.libraryDocs is not None:
        row.library_docs = _library_docs_payload(body.libraryDocs)
    if body.messages is not None:
        await _replace_messages(db, sid, body.messages)
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    loaded = await _load_session(db, sid)
    assert loaded is not None
    return _session_to_api(loaded)


@router.delete("/chats/sessions/{session_id}")
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    sid = _parse_uuid(session_id)
    row = await db.get(ChatSession, sid)
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    prefs = await _get_or_create_preferences(db)
    if prefs.active_session_id == sid:
        prefs.active_session_id = None
    await db.delete(row)
    await db.commit()
    return {"ok": True, "id": session_id}


@router.put("/chats/preferences")
async def update_preferences(body: PreferencesIn, db: AsyncSession = Depends(get_db)):
    prefs = await _get_or_create_preferences(db)
    prefs.default_model = body.defaultModel or ""
    prefs.sidebar_open = body.sidebarOpen
    prefs.rag_enabled = bool(body.ragEnabled)
    if body.activeId:
        aid = _parse_uuid(body.activeId)
        if await db.get(ChatSession, aid) is None:
            raise HTTPException(status_code=404, detail="Active session not found")
        prefs.active_session_id = aid
    else:
        prefs.active_session_id = None
    await db.commit()
    return {
        "activeId": str(prefs.active_session_id) if prefs.active_session_id else None,
        "defaultModel": prefs.default_model,
        "sidebarOpen": prefs.sidebar_open,
        "ragEnabled": bool(prefs.rag_enabled),
    }
