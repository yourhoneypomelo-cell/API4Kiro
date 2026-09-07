#!/usr/bin/env python3
"""Print the handoff card from docs/state/TODO.md. Standard library only."""
from __future__ import annotations

import sys
from pathlib import Path

MARK_START = "<!-- HANDOFF:START -->"
MARK_END = "<!-- HANDOFF:END -->"


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    todo = root / "docs" / "state" / "TODO.md"
    if not todo.is_file():
        print("缺少 docs/state/TODO.md", file=sys.stderr)
        return 2
    text = todo.read_text(encoding="utf-8")
    if MARK_START not in text or MARK_END not in text:
        print(
            "接手卡标记缺失：docs/state/TODO.md 需要 HANDOFF:START 与 HANDOFF:END",
            file=sys.stderr,
        )
        return 2
    body = text.split(MARK_START, 1)[1].split(MARK_END, 1)[0].strip()
    if not body:
        print("接手卡为空", file=sys.stderr)
        return 2
    for field in ("定位：", "停止点：", "本批加读：", "下一步："):
        if field not in body:
            print(f"接手卡缺少字段：{field}", file=sys.stderr)
            return 2
    print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
