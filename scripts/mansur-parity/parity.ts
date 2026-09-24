// Parity check: random profiles → TS engine vs Swift app engine (main.swift). Run via run.sh.
import { readFileSync, writeFileSync } from 'node:fs';
import { simulate, earliestRetireAge, netSalary, recommend, sanitized, manwon, emptyProfile, sampleProfile, type Profile } from '../../src/lib/mansur.ts';

let seed = 20260924;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const amt = (max: number, zero = 0.2) => (rnd() < zero ? 0 : Math.round(rnd() * max));

function gen(n: number): Profile[] {
  const out: Profile[] = [sampleProfile(), emptyProfile()];
  for (let i = 0; i < n; i++) {
    const cur = 22 + Math.floor(rnd() * 45);
    out.push({
      ...emptyProfile(),
      currentAge: cur,
      retireAge: pick([cur - 3, cur, cur + 1, cur + 5, 55, 60, 65, 70, 0]),
      salary: amt(20000),
      monthlyCost: amt(800, 0.05),
      targetMonthlyCost: amt(800),
      cash: amt(50000), invest: amt(200000), monthlyInvest: amt(600),
      irp: { balance: amt(10000), annualPay: amt(900) },
      pensionSavings: { balance: amt(10000), annualPay: amt(600) },
      retirePension: { type: pick(['DB', 'DC'] as const), balance: amt(30000) },
      realEstate: { home: amt(200000, 0.3), investment: amt(100000, 0.6) },
      debt: { balance: amt(50000, 0.4), rate: pick([0, 0.03, 0.045, 0.07]) },
      nationalPension: { monthly: amt(250), startAge: pick([60, 63, 65, 70, 0]) },
      housingPension: { use: rnd() < 0.4, monthly: amt(200, 0.7), homePrice: amt(150000, 0.6), residing: rnd() < 0.85 },
      lifeExpectancy: pick([80, 85, 90, 95, 100, cur - 1]),
      expectedReturn: pick([0, 0.03, 0.05, 0.08, 0.12]),
      inflation: pick([0, 0.02, 0.025, 0.04]),
      salaryGrowth: pick([0, 0.02, 0.03, 0.05]),
      housingGrowth: pick([-0.02, 0, 0.03, 0.05]),
    });
  }
  return out;
}

const mode = process.argv[2];
if (mode === 'gen') {
  writeFileSync(process.argv[3], JSON.stringify(gen(+process.argv[4] || 400)));
} else {
  const profiles: Profile[] = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const swift: any[] = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  let fails = 0, checks = 0;
  profiles.forEach((p, i) => {
    const s = simulate(p), w = swift[i];
    const ts: Record<string, unknown> = {
      status: s.status, fire: s.fire, depletionAge: s.depletionAge, liquidAtRetire: s.liquidAtRetire,
      monthlyAvailable: s.monthlyAvailable, avgMonthlyPension: s.avgMonthlyPension, monthlyFromAssets: s.monthlyFromAssets,
      retirementAsset: s.retirementAsset, requiredAsset: s.requiredAsset, achievementRate: s.achievementRate,
      surplus: s.surplus, totalMonthlyPension: s.totalMonthlyPension,
      schedule: s.pensionSchedule.map((x) => ({ key: x.key, name: x.name, startAge: x.startAge, monthly: x.monthly })),
      nw: s.snapshots.map((x) => x.netWorth), earliest: earliestRetireAge(p), netSalary: netSalary(p.salary).net,
      recs: recommend(sanitized(p), s).map((r) => r.body), fmt: manwon(s.retirementAsset),
    };
    const eq = (a: any, b: any): boolean =>
      typeof a === 'number' && typeof b === 'number' ? close(a, b)
      : Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, j) => eq(x, b[j]))
      : a && typeof a === 'object' ? Object.keys(a).every((k) => eq(a[k], b?.[k]))
      : a === b;
    for (const k of Object.keys(ts)) {
      checks++;
      if (!eq(ts[k], w[k])) { fails++; if (fails <= 12) console.log(`#${i} ${k}\n  ts:    ${JSON.stringify(ts[k]).slice(0, 300)}\n  swift: ${JSON.stringify(w[k]).slice(0, 300)}`); }
    }
  });
  console.log(`${profiles.length} profiles · ${checks} checks · ${fails} mismatches`);
  process.exit(fails ? 1 : 0);
}
