"""Run [MinerU](https://github.com/opendatalab/mineru) locally via CLI for fast CPU `pipeline` parsing."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _mineru_argv0() -> List[str]:
    """
    MinerU 3.x exposes the CLI via setuptools entry point `mineru`, not `python -m mineru`.
    Prefer the script colocated with the current interpreter's venv, then PATH, then a module run.
    """
    bindir = Path(sys.executable).resolve().parent
    name = "mineru.exe" if sys.platform == "win32" else "mineru"
    candidate = bindir / name
    if candidate.is_file():
        return [str(candidate)]
    which = shutil.which("mineru")
    if which:
        return [which]
    return [sys.executable, "-m", "mineru.cli.client"]


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _collect_main_markdown(out_dir: Path) -> str:
    """Pick the largest non-debug .md file MinerU wrote (see MinerU output file docs)."""
    skip = ("layout", "span")
    candidates = [
        p
        for p in out_dir.rglob("*.md")
        if not any(s in p.name.lower() for s in skip)
    ]
    if not candidates:
        raise RuntimeError(
            "MinerU produced no markdown files. Check MinerU install and logs (MINERU_DEBUG=1)."
        )
    candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
    return candidates[0].read_text(encoding="utf-8", errors="replace")


def parse_file_with_mineru(input_path: Path) -> Tuple[str, Dict[str, Any]]:
    """
    Run MinerU CLI and return (markdown, meta).

    Uses pipeline backend by default (CPU-friendly). Override with MINERU_BACKEND.
    """
    backend = os.getenv("MINERU_BACKEND", "pipeline").strip() or "pipeline"
    timeout = int(os.getenv("MINERU_TIMEOUT_SEC", "900"))

    out_dir = Path(tempfile.mkdtemp(prefix="mineru_out_"))
    try:
        cmd = [
            *_mineru_argv0(),
            "-p",
            str(input_path),
            "-o",
            str(out_dir),
            "-b",
            backend,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            err = (proc.stderr or "").strip() or (proc.stdout or "").strip() or f"exit {proc.returncode}"
            hint = ""
            if "No module named" in err or "not found" in err.lower():
                hint = (
                    " Ensure MinerU is installed in this venv: pip install 'mineru[all]' "
                    "(see https://github.com/opendatalab/mineru )"
                )
            raise RuntimeError(f"MinerU failed: {err[:4000]}{hint}")

        markdown = _collect_main_markdown(out_dir)
        meta: Dict[str, Any] = {
            "backend": backend,
            "mineru_stdout_tail": (proc.stdout or "")[-3000:],
            "mineru_stderr_tail": (proc.stderr or "")[-3000:],
        }
        if os.getenv("MINERU_DEBUG"):
            meta["output_tree"] = [str(p.relative_to(out_dir)) for p in sorted(out_dir.rglob("*"))[:200]]
        return markdown, meta
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
