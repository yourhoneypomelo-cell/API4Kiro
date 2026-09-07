#!/usr/bin/env python3
"""Snapshot AGENTS, adapters, docs/state, docs/specs, Cursor rules/skills into docs/archive/baselines/. Standard library only."""
from __future__ import annotations

import argparse
import datetime as dt
import shutil
import sys
from pathlib import Path

COPIES = (
    "AGENTS.md",
    "CLAUDE.md",
    ".github",
    ".gemini",
    "docs/state",
    "docs/specs",
    "docs/overlays",
    ".cursor/rules",
    ".cursor/skills",
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a rollback baseline of current truth files")
    parser.add_argument("--label", required=True, help="short label, no spaces preferred")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    label = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in args.label).strip("-")
    if not label:
        print("--label 无效", file=sys.stderr)
        return 2
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    dest = root / "docs" / "archive" / "baselines" / f"{stamp}-{label}"
    dest.mkdir(parents=True, exist_ok=False)
    copied: list[str] = []
    missing: list[str] = []
    for rel in COPIES:
        src = root / rel
        if not src.exists():
            missing.append(rel)
            continue
        target = dest / rel
        if src.is_dir():
            shutil.copytree(src, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
        copied.append(rel)
    (dest / "MANIFEST.txt").write_text(
        f"created={stamp}\nlabel={label}\ncopied={','.join(copied)}\n",
        encoding="utf-8",
    )
    print(dest)
    if missing:
        print("缺少快照源：" + "、".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
