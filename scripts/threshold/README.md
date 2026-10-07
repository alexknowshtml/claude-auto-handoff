# Threshold analysis

Re-derives the handoff threshold from this machine's Claude Code transcripts. Run from the repo root:

```bash
python3 scripts/threshold/extract.py /tmp/requests.csv
python3 scripts/threshold/analyze.py /tmp/requests.csv /tmp/params.json
python3 scripts/threshold/reread.py 60
python3 scripts/threshold/sweep.py /tmp/params.json
```

`sweep.py`'s `model()` defaults (`R`, `H`, `S0`, `fresh`, `B`, `t_req`) are the values measured on
2026-10-04; update them from `analyze.py` and `reread.py` before trusting a new optimum.
