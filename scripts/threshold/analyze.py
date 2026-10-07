"""Fit the handoff-threshold cost model to the per-request rows extract.py wrote.

Units: input-token equivalents at the model's own base input price. Anthropic's multipliers:
cache read 0.1, 5-minute write 1.25, 1-hour write 2, output 5 (identical across current models).
"""
import csv, sys, statistics as st
from collections import defaultdict

rows = list(csv.DictReader(open(sys.argv[1])))
for r in rows:
    for k in ('ctx', 'read', 'write', 'w1h', 'w5m', 'out', 'seg'):
        r[k] = int(r[k])
    r['lat'] = float(r['lat']) if r['lat'] else None
    r['edit'] = r['edit'] == 'True'

segs = defaultdict(list)
for r in rows:
    segs[(r['file'], r['seg'])].append(r)

# A. Growth per request, within a segment.
deltas, shrinks = [], 0
for s in segs.values():
    for a, b in zip(s, s[1:]):
        d = b['ctx'] - a['ctx']
        if d < 0:
            shrinks += 1
        deltas.append(d)
pos = [d for d in deltas if d >= 0]
g_mean = sum(pos) / len(deltas)
print(f'A growth/request: mean {g_mean:.0f}  median {st.median(pos):.0f}  p90 {sorted(pos)[len(pos)*9//10]}  shrinking steps {shrinks}/{len(deltas)}')

# B. Cache misses mid-segment: a request that rewrites most of a large context.
mid = [b for s in segs.values() for b in s[1:] if b['ctx'] > 30_000]
miss = [b for b in mid if b['write'] > 0.5 * b['ctx']]
m = len(miss) / len(mid)
w1h, w5m = sum(r['w1h'] for r in rows), sum(r['w5m'] for r in rows)
w_blend = (2 * w1h + 1.25 * w5m) / max(1, w1h + w5m)
print(f'B mid-segment cache misses: {len(miss)}/{len(mid)} = {m:.4f} per request; blended write multiplier {w_blend:.3f}')

# C. Segment starts and D. re-orientation until the first edit.
def first_edit(s):
    for i, r in enumerate(s):
        if r['edit']:
            return i
    return None
for kind in ('start', 'compact', 'handoff'):
    ss = [s for (f, n), s in segs.items() if s[0]['kind'] == kind and len(s) >= 3]
    if not ss:
        continue
    starts = [s[0]['ctx'] for s in ss]
    fresh = [s[0]['write'] + int(s[0]['ctx'] - s[0]['read'] - s[0]['write']) for s in ss]
    fe = [(first_edit(s), s) for s in ss]
    with_edit = [(i, s) for i, s in fe if i is not None]
    nR = [i for i, _ in with_edit]
    R = [s[i]['ctx'] - s[0]['ctx'] for i, s in with_edit]
    tR = [s[i]['t1'] and float(s[i]['t1']) - float(s[0]['t0'] or s[0]['t1']) for i, s in with_edit]
    print(f'C/D {kind:8s} segs={len(ss):4d} start ctx median {st.median(starts):.0f}  first-request fresh write median {st.median(fresh):.0f}'
          f' | to first edit: requests median {st.median(nR) if nR else "-"} growth median {st.median(R) if R else "-"} seconds median {st.median(tR) if tR else "-"} (segments with an edit {len(with_edit)}/{len(ss)})')

# E. Latency: median seconds per request by context band, and a least-squares fit
#    lat = a + b*ctx + c*out on requests that waited on the model alone (0.3 s .. 300 s).
L = [r for r in rows if r['lat'] is not None and 0.3 <= r['lat'] <= 300]
bands = defaultdict(list)
for r in L:
    bands[min(r['ctx'] // 50_000, 7)].append(r)
print('E latency by context band (median s, median out tokens, n):')
for b in sorted(bands):
    v = bands[b]
    print(f'   {b*50:>3}-{b*50+50}k: {st.median(x["lat"] for x in v):6.2f} s  out {st.median(x["out"] for x in v):5.0f}  n={len(v)}')
def lstsq(X, y):
    n = len(X[0])
    A = [[sum(x[i] * x[j] for x in X) for j in range(n)] for i in range(n)]
    v = [sum(x[i] * t for x, t in zip(X, y)) for i in range(n)]
    for i in range(n):  # Gauss-Jordan
        p = A[i][i]
        for j in range(n):
            A[i][j] /= p
        v[i] /= p
        for k in range(n):
            if k != i:
                f = A[k][i]
                for j in range(n):
                    A[k][j] -= f * A[i][j]
                v[k] -= f * v[i]
    return v
a, b, c = lstsq([[1, r['ctx'] / 1000, r['out'] / 1000] for r in L], [r['lat'] for r in L])
print(f'E fit: lat = {a:.2f} s + {b:.4f} s per 1k ctx + {c:.2f} s per 1k output   (n={len(L)})')

# F. Where segments end today.
ends = [s[-1]['ctx'] for (f, n), s in segs.items() if (f, n + 1) in segs and segs[(f, n + 1)][0]['kind'] == 'compact']
print(f'F context at auto-compaction: median {st.median(ends):.0f}  p10 {sorted(ends)[len(ends)//10]}  p90 {sorted(ends)[len(ends)*9//10]}  n={len(ends)}')
out_mean = st.mean(r['out'] for r in rows)
print(f'  mean output tokens per request {out_mean:.0f}')

import json
json.dump(dict(g=g_mean, m=m, w=w_blend, a=a, b=b, c=c, out=out_mean), open(sys.argv[2], 'w'))
