"""Threshold sweep. Per 1k tokens of progress (context growth past the restart):
cost in input-token equivalents, time in seconds. Parameters measured by analyze.py/reread.py."""
import json, sys
p = json.load(open(sys.argv[1]))
g, m, w = p['g'], p['m'], p['w']
r = 0.1 + m * (w - 0.1)            # read multiplier with the measured cache-miss rate
OUT = p['out'] * 5 / g             # output cost per progress token: same at every threshold
def model(R=2_000, H=50, S0=74_000, fresh=29_100, B=2_000, t_req=17.5):
    S = S0 + R
    F = fresh * w + B * 5 + R * w  # one handoff: fresh prefix writes, the brief's output, re-reads
    def cost(T):
        P = T - S
        return (r * (S + T) / (2 * g) + F / P + w + OUT) * 1000
    def time(T):
        return (t_req / g + H / (T - S)) * 1000
    return cost, time, S, F
def run(label, **kw):
    cost, time, S, F = model(**kw)
    Ts = range(100_000, 400_001, 5_000)
    cmin = min(cost(T) for T in Ts); tbase = time(10**9)
    comb = {T: (cost(T) / cmin - 1) + (time(T) / tbase - 1) for T in Ts}
    tc = min(Ts, key=cost); tb = min(Ts, key=comb.get)
    print(f'{label}: F={F/1000:.0f}k  cost-optimal {tc//1000}k  cost+time optimal {tb//1000}k')
    return cost, time, cmin, tbase
print(f'g={g:.0f} tok/request  read multiplier {r:.4f}  write {w:.3f}')
cost, time, cmin, tbase = run('measured (R=2k, H=50s)')
print('   T     cost/1k  vs 300k   time/1k  vs no-handoff')
for T in (125_000, 150_000, 175_000, 200_000, 225_000, 250_000, 300_000):
    print(f'  {T//1000:>3}k  {cost(T):7.0f}  {cost(T)/cost(300_000)-1:+6.1%}   {time(T):6.2f}s  {time(T)/tbase-1:+6.1%}')
run('re-reads x10 (R=20k)', R=20_000)
run('handoff wall time x3 (H=150s)', H=150)
run('both', R=20_000, H=150)
run('brief read injected, no Read round trip (fresh 12.3k)', fresh=12_300 + 2_500)
