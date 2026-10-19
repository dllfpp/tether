#!/usr/bin/env python3
"""Render terminal output with ANSI colors as an SVG terminal window.

    sh demo.sh host | python3 ansi2svg.py "root@pve: ~" > host.svg

Handles what the Tether wizard prints: SGR colors, bold, underline, \r and
"erase to end of line". Wide characters (emoji) take two cells.
"""
import re
import sys
import unicodedata
from html import escape

CELL_W, LINE_H, FONT = 8.4, 20, 14
PAD_X, PAD_TOP, PAD_BOTTOM, BAR = 18, 16, 18, 34
BG, FG, BAR_BG = "#0d1117", "#c9d1d9", "#161b22"
COLORS = {31: "#f85149", 32: "#3fb950", 33: "#e3b341", 36: "#39c5cf", 92: "#56d364"}
SGR = re.compile(r"\x1b\[([0-9;]*)([A-Za-z])")


def width(ch):
    if ch == "️" or unicodedata.combining(ch):
        return 0
    if unicodedata.east_asian_width(ch) in "WF":
        return 2
    return 1


def parse(text):
    """Return lines as dicts {col: (chars, style)}."""
    lines, cells, col = [], {}, 0
    style = {"fg": None, "bold": False, "ul": False}
    pos = 0
    for m in list(SGR.finditer(text)) + [None]:
        chunk = text[pos:m.start()] if m else text[pos:]
        for ch in chunk:
            if ch == "\n":
                lines.append(cells)
                cells, col = {}, 0
            elif ch == "\r":
                col = 0
            elif width(ch) == 0:
                if cells and col > 0:
                    prev = max(c for c in cells if c < col)
                    cells[prev] = (cells[prev][0] + ch, cells[prev][1])
            else:
                cells[col] = (ch, dict(style))
                col += width(ch)
        if not m:
            break
        pos = m.end()
        if m.group(2) == "K":
            cells = {c: v for c, v in cells.items() if c < col}
        elif m.group(2) == "m":
            for code in [int(c) for c in (m.group(1) or "0").split(";") if c]:
                if code == 0:
                    style = {"fg": None, "bold": False, "ul": False}
                elif code == 1:
                    style["bold"] = True
                elif code == 4:
                    style["ul"] = True
                elif code in COLORS:
                    style["fg"] = COLORS[code]
    if cells:
        lines.append(cells)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def render(lines, title):
    cols = max((max(c + width(v[0][0]) for c, v in l.items()) for l in lines if l), default=40)
    w = round(PAD_X * 2 + cols * CELL_W)
    h = BAR + PAD_TOP + len(lines) * LINE_H + PAD_BOTTOM
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,\'Liberation Mono\',monospace" font-size="{FONT}">',
        f'<rect width="{w}" height="{h}" rx="10" fill="{BG}"/>',
        f'<path d="M0 10a10 10 0 0 1 10-10h{w - 20}a10 10 0 0 1 10 10v{BAR - 10}h-{w}z" fill="{BAR_BG}"/>',
    ]
    for i, color in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        out.append(f'<circle cx="{20 + i * 20}" cy="{BAR / 2}" r="6" fill="{color}"/>')
    out.append(f'<text x="{w / 2}" y="{BAR / 2 + 5}" fill="#8b949e" font-size="13" text-anchor="middle">{escape(title)}</text>')
    for n, cells in enumerate(lines):
        y = BAR + PAD_TOP + (n + 1) * LINE_H - 6
        # One <text> per run of equally styled narrow characters; wide ones
        # stand alone so a font's emoji width cannot shift the columns.
        state = {"run": "", "start": None, "key": None}

        def flush():
            run, start, key = state["run"], state["start"], state["key"]
            if run.strip():
                fg, bold, ul = key
                attrs = f' fill="{fg or FG}"' + (' font-weight="700"' if bold else "") + (' text-decoration="underline"' if ul else "")
                out.append(f'<text x="{PAD_X + start * CELL_W:.1f}" y="{y}" xml:space="preserve"{attrs}>{escape(run)}</text>')
            state.update(run="", start=None, key=None)

        for col in sorted(cells):
            ch, st = cells[col]
            k = (st["fg"], st["bold"], st["ul"])
            wide = width(ch[0]) == 2
            if wide or k != state["key"] or state["start"] is None or col != state["start"] + len(state["run"]):
                flush()
                state.update(start=col, key=k)
            state["run"] += ch
            if wide:
                flush()
        flush()
    out.append("</svg>")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    sys.stdout.write(render(parse(sys.stdin.read()), sys.argv[1] if len(sys.argv) > 1 else ""))
