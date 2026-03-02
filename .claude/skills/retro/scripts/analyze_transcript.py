#!/usr/bin/env python3
"""Deterministic transcript analysis for retro skill.

Usage: python3 analyze_transcript.py <path-to-jsonl>
Output: Markdown-formatted turn-by-turn analysis with timing stats

Hands-on time model (for parallel-session users):
  Reading:  assistant_output_words / 150 wpm
  Typing:   user_input_words / 60 wpm
  Buffer:   1 min per turn (context switch overhead)
  Merge:    consecutive turns with overlapping buffers merge into one block

Filters out system-injected messages:
  - Skill injections ("Base directory for this skill:")
  - Local command outputs (<command-name>, <local-command-)
  - System reminders (<system-reminder>)
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

# --- Constants ---

READ_WPM = 150
TYPE_WPM = 60
BUFFER_MIN = 1.0
HUMAN_PREVIEW_LIMIT = 2000
ASSISTANT_PREVIEW_LIMIT = 150

SYSTEM_MESSAGE_PATTERNS = [
    re.compile(r"^Base directory for this skill:"),
    re.compile(r"^<(command-name|local-command|system-reminder)"),
    re.compile(r"^<local-command-caveat>"),
    re.compile(r"^This session is being continued from a previous conversation"),
]


# --- Data classes ---


@dataclass
class Message:
    """A single extracted message from the transcript."""

    timestamp: datetime
    role: str
    is_human: bool
    is_tool_result: bool
    is_system: bool
    word_count: int
    tools: list[str]
    has_error: bool
    preview: str


@dataclass
class Turn:
    """A grouped turn: one user message and all subsequent assistant messages."""

    number: int
    timestamp: datetime
    user_text: str
    user_words: int
    asst_words: int
    tools: list[str]
    errors: int
    asst_preview: str


@dataclass
class TurnTiming:
    """Timing data for a single turn."""

    read_min: float
    type_min: float
    buffer_min: float = BUFFER_MIN
    merged: bool = False


@dataclass
class TimingStats:
    """Aggregate timing statistics."""

    total_turns: int
    total_read_min: float
    total_type_min: float
    total_buffer_min: float
    raw_handson_min: float
    adjusted_handson_min: float
    per_turn: list[TurnTiming] = field(default_factory=list)


# --- Extraction ---


def _extract_text(content: str | list) -> str:
    """Extract readable text from message content."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type", "")
        if block_type == "text":
            parts.append(block.get("text", ""))
        elif block_type == "thinking":
            pass  # excluded from text
        elif block_type == "tool_use":
            parts.append(f"TOOL:{block.get('name', '')}")
        elif block_type == "tool_result":
            text = str(block.get("content", ""))
            if block.get("is_error"):
                parts.append(f"ERROR:{text}")
            else:
                parts.append(text)
    return " ".join(parts)


def _extract_tools(content: str | list) -> list[str]:
    """Extract tool names from assistant message content."""
    if not isinstance(content, list):
        return []
    return [
        block.get("name", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "tool_use"
    ]


def _has_error(content: str | list) -> bool:
    """Check if message content contains errors."""
    if isinstance(content, list):
        return any(
            isinstance(block, dict)
            and block.get("type") == "tool_result"
            and block.get("is_error") is True
            for block in content
        )
    if isinstance(content, str):
        return bool(re.search(r"(?i)error|failed|exit code [1-9]", content))
    return False


def _is_system_message(text: str) -> bool:
    """Check if a human message is system-injected."""
    return any(pat.search(text) for pat in SYSTEM_MESSAGE_PATTERNS)


def _word_count(text: str) -> int:
    """Count words in text, splitting on whitespace."""
    return len(text.split())


def _make_preview(role: str, is_human: bool, is_system: bool, text: str, tools: list[str]) -> str:
    """Create a content preview for display."""
    if is_human and is_system:
        return f"[SYSTEM] {text[:100]}"
    if is_human:
        if len(text) > HUMAN_PREVIEW_LIMIT:
            return text[:HUMAN_PREVIEW_LIMIT] + " [TRUNCATED]"
        return text
    if role == "assistant" and tools:
        return f"tools: {', '.join(tools)}"
    if role == "assistant":
        return text[:ASSISTANT_PREVIEW_LIMIT]
    return text[:ASSISTANT_PREVIEW_LIMIT]


def _parse_timestamp(ts: str) -> datetime:
    """Parse ISO timestamp to datetime."""
    # Handle both Z suffix and +00:00
    ts = ts.replace("Z", "+00:00")
    return datetime.fromisoformat(ts)


def extract_messages(jsonl_text: str) -> list[Message]:
    """Parse JSONL transcript text into a list of Messages."""
    messages = []
    for line in jsonl_text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        if "timestamp" not in record or "message" not in record:
            continue

        msg = record["message"]
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            continue

        content = msg.get("content", "")
        is_human = (
            role == "user"
            and record.get("sourceToolAssistantUUID") is None
            and record.get("toolUseResult") is None
        )
        is_tool_result = (
            record.get("sourceToolAssistantUUID") is not None
            or record.get("toolUseResult") is not None
        )

        text = _extract_text(content)
        is_system = is_human and _is_system_message(text)
        tools = _extract_tools(content) if role == "assistant" else []

        # Word count: only count text blocks for assistants, full text for humans
        if is_system:
            words = 0
        elif role == "assistant":
            # Count only text blocks, not tool names or error prefixes
            if isinstance(content, list):
                text_parts = [
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                ]
                words = _word_count(" ".join(text_parts))
            else:
                words = _word_count(text)
        else:
            words = _word_count(text)

        preview = _make_preview(role, is_human, is_system, text, tools)

        messages.append(
            Message(
                timestamp=_parse_timestamp(record["timestamp"]),
                role=role,
                is_human=is_human,
                is_tool_result=is_tool_result,
                is_system=is_system,
                word_count=words,
                tools=tools,
                has_error=_has_error(content),
                preview=preview,
            )
        )
    return messages


# --- Turn grouping ---


def group_into_turns(messages: list[Message]) -> list[Turn]:
    """Group messages into turns. A new turn starts with each real human message."""
    turns: list[Turn] = []
    current: Turn | None = None

    for msg in messages:
        # Real human message (not system, not tool result) starts a new turn
        if msg.is_human and not msg.is_system:
            if current is not None:
                turns.append(current)
            current = Turn(
                number=len(turns) + 1,
                timestamp=msg.timestamp,
                user_text=msg.preview,
                user_words=msg.word_count,
                asst_words=0,
                tools=[],
                errors=0,
                asst_preview="",
            )
            continue

        # System-injected user messages: skip (don't create turn)
        if msg.is_human and msg.is_system:
            continue

        # Assistant or tool result messages attach to current turn
        if current is not None:
            if msg.role == "assistant":
                current.asst_words += msg.word_count
                for tool in msg.tools:
                    if tool not in current.tools:
                        current.tools.append(tool)
                # Capture first non-tool text preview
                if not current.asst_preview and msg.preview and not msg.preview.startswith("tools: "):
                    current.asst_preview = msg.preview
            if msg.has_error:
                current.errors += 1

    if current is not None:
        turns.append(current)

    # Fix numbering
    for i, turn in enumerate(turns):
        turn.number = i + 1

    return turns


# --- Timing ---


def calculate_timing(turns: list[Turn]) -> TimingStats:
    """Calculate hands-on timing with overlapping turn merging."""
    if not turns:
        return TimingStats(
            total_turns=0,
            total_read_min=0,
            total_type_min=0,
            total_buffer_min=0,
            raw_handson_min=0,
            adjusted_handson_min=0,
        )

    # Per-turn raw timing
    per_turn: list[TurnTiming] = []
    for turn in turns:
        read_min = turn.asst_words / READ_WPM
        type_min = turn.user_words / TYPE_WPM
        per_turn.append(TurnTiming(read_min=read_min, type_min=type_min))

    # Merge overlapping turns
    # Turn N's buffered end = start + read + type + buffer
    # If that >= turn N+1's start, merge them
    n = len(turns)
    merge_end = list(range(n))  # each turn's merge group end index

    i = 0
    while i < n:
        t_start = turns[i].timestamp
        buffered_end_minutes = (
            per_turn[i].read_min + per_turn[i].type_min + BUFFER_MIN
        )
        j = i + 1
        while j < n:
            gap_minutes = (turns[j].timestamp - t_start).total_seconds() / 60.0
            if buffered_end_minutes >= gap_minutes:
                # Merge: mark j as merged, extend the window
                per_turn[j].merged = True
                merge_end[i] = j
                # Extend buffered end from turn j's perspective
                gap_to_j = (turns[j].timestamp - t_start).total_seconds() / 60.0
                buffered_end_minutes = gap_to_j + per_turn[j].read_min + per_turn[j].type_min + BUFFER_MIN
                j += 1
            else:
                break
        i = j if j > i + 1 else i + 1

    # Calculate totals
    total_read = sum(t.read_min for t in per_turn)
    total_type = sum(t.type_min for t in per_turn)
    total_buffer = BUFFER_MIN * n
    raw_handson = total_read + total_type + total_buffer

    # Adjusted: merged groups share a single buffer
    adjusted_handson = 0.0
    i = 0
    while i < n:
        if per_turn[i].merged:
            i += 1
            continue
        end = merge_end[i]
        group_raw = sum(per_turn[k].read_min + per_turn[k].type_min for k in range(i, end + 1))
        adjusted_handson += group_raw + BUFFER_MIN
        i = end + 1

    return TimingStats(
        total_turns=n,
        total_read_min=total_read,
        total_type_min=total_type,
        total_buffer_min=total_buffer,
        raw_handson_min=raw_handson,
        adjusted_handson_min=adjusted_handson,
        per_turn=per_turn,
    )


# --- Formatting ---


def format_markdown(turns: list[Turn], stats: TimingStats) -> str:
    """Format turns and timing stats as markdown."""
    lines: list[str] = []
    lines.append("# Transcript Analysis")
    lines.append("")
    lines.append("## Turns")
    lines.append("")

    for turn in turns:
        tools_str = ", ".join(turn.tools)
        lines.append(f"### Turn {turn.number} — {turn.timestamp.isoformat()}")
        lines.append(f"**User** ({turn.user_words} words):")
        lines.append(f"> {turn.user_text}")
        lines.append("")

        asst_line = f"**Assistant** ({turn.asst_words} words)"
        if tools_str:
            asst_line += f" | Tools: {tools_str}"
        if turn.errors > 0:
            asst_line += f" | ERRORS: {turn.errors}"
        lines.append(asst_line)

        if turn.asst_preview:
            lines.append(f"Preview: {turn.asst_preview}")
        lines.append("")

    lines.append("---")
    lines.append("## Timing Stats")
    lines.append("")
    lines.append(f"Total turns: {stats.total_turns}")
    lines.append("")

    # Per-turn table
    lines.append("| Turn | Timestamp | User Words | Asst Words | Read (min) | Type (min) | Buffer | Turn Total | Merged? |")
    lines.append("|------|-----------|------------|------------|------------|------------|--------|------------|---------|")

    for i, turn in enumerate(turns):
        pt = stats.per_turn[i]
        turn_total = pt.read_min + pt.type_min + pt.buffer_min
        merged_flag = "merged" if pt.merged else ""
        lines.append(
            f"| {turn.number} | {turn.timestamp.isoformat()} | {turn.user_words} | {turn.asst_words} "
            f"| {pt.read_min:.1f} | {pt.type_min:.1f} | {pt.buffer_min:.1f} | {turn_total:.1f} | {merged_flag} |"
        )

    lines.append("")
    lines.append(
        f"**Raw hands-on: {stats.raw_handson_min:.1f} min** "
        f"(reading: {stats.total_read_min:.1f} + typing: {stats.total_type_min:.1f} + buffer: {stats.total_buffer_min:.1f})"
    )
    lines.append(
        f"**Adjusted hands-on: {stats.adjusted_handson_min:.1f} min** "
        f"(overlapping turns merged, single buffer per group)"
    )

    return "\n".join(lines)


# --- CLI ---


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_transcript.py <path-to-jsonl>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    try:
        with open(path) as f:
            jsonl_text = f.read()
    except FileNotFoundError:
        print(f"Error: File not found: {path}", file=sys.stderr)
        sys.exit(1)

    messages = extract_messages(jsonl_text)
    turns = group_into_turns(messages)
    stats = calculate_timing(turns)
    print(format_markdown(turns, stats))


if __name__ == "__main__":
    main()
