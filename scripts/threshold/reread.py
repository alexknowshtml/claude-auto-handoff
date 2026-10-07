"""Re-orientation tax: after a restart (compaction or handoff seed), how many tokens of tool output
does the new segment spend re-reading files the previous segment already had in context?

A read is a Read call, or a Bash/Grep/Glob call whose input names a path. Its cost is the size of
its result (chars / 4). Baseline: within a segment, re-reads of paths that segment already read,
per request. The tax is the excess over that baseline in the new segment's first WINDOW requests.
"""
import json, glob, os, re, sys, statistics as st

ROOT = os.path.expanduser('~/.claude/projects')
WINDOW = int(sys.argv[1]) if len(sys.argv) > 1 else 60
PATH = re.compile(r'(?:~|\.{0,2})?/?[\w.@-]+(?:/[\w.@-]+)+\.\w{1,6}|[\w.-]+\.(?:py|ts|tsx|js|md|json|sql|yml|yaml|toml|sh|css|html|go|rs)\b')

def paths_of(name, inp):
    if name == 'Read':
        p = inp.get('file_path')
        return {p.split('/')[-1] + '|' + p} if p else set()
    if name in ('Bash', 'Grep', 'Glob'):
        s = ' '.join(str(v) for v in inp.values())
        return {m.split('/')[-1] + '|' + m for m in PATH.findall(s)}
    return set()

def size(content):
    if isinstance(content, str):
        return len(content)
    return sum(len(b.get('text', '')) for b in content or [] if isinstance(b, dict))

boundary_tax, base_rates, seg_count = [], [], 0
for path in glob.glob(f'{ROOT}/**/*.jsonl', recursive=True):
    if '/subagents/' in path:
        continue
    segs = [[]]  # per segment: list of requests; request = list of (paths, tool_use_id)
    kinds = ['start']
    pending, results = {}, {}
    seen_ids = set()
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('isSidechain'):
            continue
        typ = e.get('type')
        msg = e.get('message') or {}
        if typ == 'system' and e.get('subtype') == 'compact_boundary':
            segs.append([]); kinds.append('compact')
        elif typ == 'user':
            c = msg.get('content')
            txt = c if isinstance(c, str) else next((b.get('text', '') for b in c or [] if isinstance(b, dict) and b.get('type') == 'text'), '')
            if not e.get('isCompactSummary') and '[auto-handoff] ↪ Handoff' in txt[:200]:
                segs.append([]); kinds.append('handoff')
            for b in c if isinstance(c, list) else []:
                if isinstance(b, dict) and b.get('type') == 'tool_result':
                    results[b.get('tool_use_id')] = size(b.get('content')) // 4
        elif typ == 'assistant':
            mid = msg.get('id')
            calls = [(paths_of(b.get('name'), b.get('input') or {}), b.get('id'), b.get('name'))
                     for b in msg.get('content') or [] if isinstance(b, dict) and b.get('type') == 'tool_use']
            if mid in seen_ids and segs[-1]:
                segs[-1][-1].extend(calls)
            else:
                seen_ids.add(mid)
                segs[-1].append(calls)
    # Per segment: within-segment re-read rate, and boundary re-reads of the previous segment's paths.
    prev_paths = None
    for s, kind in zip(segs, kinds):
        if not s:
            continue
        seg_count += 1
        own, re_tok = set(), 0
        for req in s:
            for ps, tid, name in req:
                if ps and ps & own:
                    re_tok += results.get(tid, 0)
                own |= ps
        if len(s) > WINDOW:
            base_rates.append(re_tok / len(s))
        if kind in ('compact', 'handoff') and prev_paths:
            tax, seen = 0, set()
            for req in s[:WINDOW]:
                for ps, tid, name in req:
                    # A path read again within the new segment counts under the baseline, not here.
                    if ps and (ps & prev_paths) and not (ps & seen):
                        tax += results.get(tid, 0)
                    seen |= ps
            boundary_tax.append((kind, tax, min(len(s), WINDOW)))
        prev_paths = set()
        for req in s:
            for ps, _, _ in req:
                prev_paths |= ps

base = st.median(base_rates)
print(f'segments={seg_count} window={WINDOW} requests')
print(f'baseline in-segment re-read tokens/request: median {base:.0f}  mean {st.mean(base_rates):.0f}  (segments longer than the window: {len(base_rates)})')
for kind in ('compact', 'handoff'):
    t = [x for k, x, n in boundary_tax if k == kind]
    if t:
        print(f'{kind}: boundaries={len(t)} first-read-after-boundary of previous segment paths, tokens: median {st.median(t):.0f}  mean {st.mean(t):.0f}  p75 {sorted(t)[len(t)*3//4]}  p90 {sorted(t)[len(t)*9//10]}')
