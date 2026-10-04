"""Reduce every main-thread Claude Code transcript to one row per API request.

Row: file, segment (0 = session start, +1 after each compaction / handoff seed), kind of segment
start, timestamp, context (input + cache read + cache write), cache read, cache write (5m/1h),
output tokens, seconds since the previous transcript entry, whether the response edits a file.
"""
import json, glob, os, sys, csv
from datetime import datetime

ROOT = os.path.expanduser('~/.claude/projects')
OUT = sys.argv[1]
EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}

def ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None

def first_text(content):
    if isinstance(content, str):
        return content
    for b in content or []:
        if isinstance(b, dict) and b.get('type') == 'text':
            return b.get('text', '')
    return ''

rows = []
files = [f for f in glob.glob(f'{ROOT}/**/*.jsonl', recursive=True) if '/subagents/' not in f]
for path in files:
    seg, seg_kind = 0, 'start'
    prev_t = None
    reqs = {}  # message.id -> row, kept in order
    order = []
    try:
        fh = open(path, encoding='utf-8', errors='replace')
    except OSError:
        continue
    with fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('isSidechain'):
                continue
            t = ts(e.get('timestamp', '')) if e.get('timestamp') else None
            typ = e.get('type')
            if typ == 'system' and e.get('subtype') == 'compact_boundary':
                seg, seg_kind = seg + 1, 'compact'
            elif typ == 'user':
                msg = e.get('message') or {}
                txt = first_text(msg.get('content'))
                if e.get('isCompactSummary'):
                    pass  # boundary already counted
                elif '[auto-handoff] ↪ Handoff' in txt[:200]:
                    seg, seg_kind = seg + 1, 'handoff'
                if t:
                    prev_t = t
            elif typ == 'assistant':
                msg = e.get('message') or {}
                u = msg.get('usage') or {}
                mid = msg.get('id')
                if not mid or not u:
                    continue
                cc = u.get('cache_creation') or {}
                ctx = (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
                edits = any(isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') in EDIT_TOOLS for b in msg.get('content') or [])
                if mid not in reqs:
                    reqs[mid] = dict(file=os.path.basename(path)[:8], seg=seg, kind=seg_kind, model=msg.get('model', ''),
                                     t0=prev_t, t1=t, ctx=ctx, read=u.get('cache_read_input_tokens') or 0,
                                     write=u.get('cache_creation_input_tokens') or 0,
                                     w1h=cc.get('ephemeral_1h_input_tokens') or 0, w5m=cc.get('ephemeral_5m_input_tokens') or 0,
                                     out=u.get('output_tokens') or 0, edit=edits)
                    order.append(mid)
                else:
                    r = reqs[mid]
                    r['t1'] = t or r['t1']
                    r['out'] = max(r['out'], u.get('output_tokens') or 0)
                    r['edit'] = r['edit'] or edits
    for mid in order:
        r = reqs[mid]
        if r['model'].startswith('<synthetic') or r['ctx'] == 0:
            continue
        r['lat'] = round(r['t1'] - r['t0'], 2) if r['t0'] and r['t1'] else ''
        rows.append(r)

with open(OUT, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['file', 'seg', 'kind', 'model', 't0', 't1', 'ctx', 'read', 'write', 'w1h', 'w5m', 'out', 'lat', 'edit'])
    w.writeheader()
    w.writerows(rows)
print(f'files={len(files)} requests={len(rows)} out={OUT}')
