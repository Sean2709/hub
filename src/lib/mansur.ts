// 은퇴하면 만수르 — 계산 엔진 웹 포팅 (iOS 앱 RetireMansur/Models/*.swift 1:1 대응)
// 원본: Constants.swift · Profile.swift · Tax.swift · HousingPension.swift · Calculator.swift
// ⚠️ 앱 엔진을 고치면 여기도 같이 고칠 것 — 교차 검증 절차는 scripts/mansur-parity/README.md.
// 모든 금액 = 만원, 연 단위 시뮬레이션, 모든 값은 "오늘 돈 가치(실질)".

// ── Constants.swift (K) ──
export const K = {
  tax: { pensionCombinedLimit: 900, taxCreditRateLow: 0.165, taxCreditRateHigh: 0.132, salaryThreshold: 5500 },
  incomeTax: {
    earnedDeduction: [
      { cap: 500, base: 0, rate: 0.7 },
      { cap: 1500, base: 350, rate: 0.4 },
      { cap: 4500, base: 750, rate: 0.15 },
      { cap: 10000, base: 1200, rate: 0.05 },
      { cap: Infinity, base: 1475, rate: 0.02 },
    ],
    earnedDeductionMax: 2000,
    personalDeduction: 150,
    brackets: [
      { cap: 1400, rate: 0.06 },
      { cap: 5000, rate: 0.15 },
      { cap: 8800, rate: 0.24 },
      { cap: 15000, rate: 0.35 },
      { cap: 30000, rate: 0.38 },
      { cap: 50000, rate: 0.4 },
      { cap: 100000, rate: 0.42 },
      { cap: Infinity, rate: 0.45 },
    ],
    nationalPensionRate: 0.045,
    nationalPensionBaseCap: 7644,
    healthRate: 0.03545,
    longTermCareRate: 0.1295,
    employmentRate: 0.009,
    localTaxRate: 0.1,
  },
  defaults: {
    lifeExpectancy: 90,
    expectedReturn: 0.05,
    inflationRate: 0.025,
    salaryGrowth: 0.03,
    housingGrowth: 0.03,
    safeWithdrawalRate: 0.04,
    pensionOpenAge: 55,
    nationalStartAge: 65,
    dcContributionRate: 1 / 12,
  },
} as const;

// ── Profile.swift ──
export interface Profile {
  currentAge: number;
  retireAge: number;
  salary: number; // 만원/년 (세전)
  monthlyCost: number; // 만원/월 (은퇴 전)
  targetMonthlyCost: number; // 만원/월 (은퇴 후 목표)
  cash: number;
  invest: number;
  monthlyInvest: number; // 만원/월 — 현금 → 투자 이동
  irp: { balance: number; annualPay: number };
  pensionSavings: { balance: number; annualPay: number };
  retirePension: { type: 'DB' | 'DC'; balance: number };
  realEstate: { home: number; investment: number };
  debt: { balance: number; rate: number };
  nationalPension: { monthly: number; startAge: number };
  housingPension: { use: boolean; monthly: number; homePrice: number; residing: boolean };
  lifeExpectancy: number;
  expectedReturn: number;
  inflation: number;
  salaryGrowth: number;
  housingGrowth: number;
}

export const emptyProfile = (): Profile => ({
  currentAge: 40,
  retireAge: 60,
  salary: 0,
  monthlyCost: 0,
  targetMonthlyCost: 0,
  cash: 0,
  invest: 0,
  monthlyInvest: 0,
  irp: { balance: 0, annualPay: 0 },
  pensionSavings: { balance: 0, annualPay: 0 },
  retirePension: { type: 'DC', balance: 0 },
  realEstate: { home: 0, investment: 0 },
  debt: { balance: 0, rate: 0 },
  nationalPension: { monthly: 0, startAge: K.defaults.nationalStartAge },
  housingPension: { use: false, monthly: 0, homePrice: 0, residing: true },
  lifeExpectancy: K.defaults.lifeExpectancy,
  expectedReturn: K.defaults.expectedReturn,
  inflation: K.defaults.inflationRate,
  salaryGrowth: K.defaults.salaryGrowth,
  housingGrowth: K.defaults.housingGrowth,
});

/** Profile.sample — 앱의 샘플 프로필과 동일 */
export const sampleProfile = (): Profile => ({
  ...emptyProfile(),
  currentAge: 40,
  retireAge: 60,
  salary: 6000,
  monthlyCost: 300,
  targetMonthlyCost: 300,
  cash: 5000,
  invest: 5000,
  irp: { balance: 2000, annualPay: 300 },
  pensionSavings: { balance: 1500, annualPay: 400 },
  monthlyInvest: 100,
  retirePension: { type: 'DC', balance: 8000 },
  realEstate: { home: 50000, investment: 0 },
  debt: { balance: 10000, rate: 0.04 },
  nationalPension: { monthly: 120, startAge: 65 },
});

export const clone = (p: Profile): Profile => JSON.parse(JSON.stringify(p));
const realOf = (g: number, infl: number) => (1 + g) / (1 + infl) - 1;
export const realReturn = (p: Profile) => realOf(p.expectedReturn, p.inflation);
export const realSalaryGrowth = (p: Profile) => realOf(p.salaryGrowth, p.inflation);
export const realHousingGrowth = (p: Profile) => realOf(p.housingGrowth, p.inflation);

/** t세 시점의 실질 세전 연봉 (은퇴 후 0) */
export function salaryAt(p: Profile, age: number): number {
  if (age >= p.retireAge || p.salary <= 0) return 0;
  return p.salary * Math.pow(1 + realSalaryGrowth(p), Math.max(0, age - p.currentAge));
}

/** Swift `.rounded()` = schoolbook (half away from zero); JS Math.round differs for negatives */
const swiftRound = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

// ── HousingPension.swift ──
const HP_TABLE = [
  { age: 55, per100M: 15.6, cap: 187.2 },
  { age: 60, per100M: 21.05, cap: 252.8 },
  { age: 65, per100M: 25.25, cap: 303.5 },
  { age: 70, per100M: 30.75, cap: 341.4 },
  { age: 75, per100M: 38.1, cap: 366.6 },
  { age: 80, per100M: 48.3, cap: 406.0 },
];
export const HP_MIN_AGE = 55;
export const HP_MAX_PRICE = 120_000;
export function housingPensionMonthly(price: number, age: number): number {
  if (age < HP_MIN_AGE || !(price > 0)) return 0;
  const t = HP_TABLE;
  const a = Math.min(age, t[t.length - 1].age);
  let per = t[t.length - 1].per100M;
  let cap = t[t.length - 1].cap;
  for (let i = 0; i < t.length - 1; i++) {
    const lo = t[i], hi = t[i + 1];
    if (a >= lo.age && a <= hi.age) {
      const f = (a - lo.age) / (hi.age - lo.age);
      per = lo.per100M + (hi.per100M - lo.per100M) * f;
      cap = lo.cap + (hi.cap - lo.cap) * f;
      break;
    }
  }
  const priceIn100M = Math.min(price, HP_MAX_PRICE) / 10_000;
  return swiftRound(Math.min(per * priceIn100M, cap));
}

export const housingStartAge = (p: Profile) => Math.max(p.retireAge, HP_MIN_AGE);
export const housingPrice = (p: Profile) => (p.housingPension.homePrice > 0 ? p.housingPension.homePrice : p.realEstate.home);
export function housingPriceAtStart(p: Profile): number {
  const hp = housingPrice(p);
  if (hp <= 0) return 0;
  const years = Math.max(0, housingStartAge(p) - p.currentAge);
  return hp * Math.pow(1 + realHousingGrowth(p), years);
}
export function housingMonthly(p: Profile): number {
  if (!p.housingPension.use || !p.housingPension.residing) return 0;
  const calc = housingPensionMonthly(housingPriceAtStart(p), housingStartAge(p));
  return calc > 0 ? calc : p.housingPension.monthly;
}

// ── Tax.swift ──
export interface NetSalary { gross: number; social: number; incomeTax: number; localTax: number; net: number; monthlyNet: number }

export function netSalary(gross: number): NetSalary {
  if (!(gross > 0)) return { gross: 0, social: 0, incomeTax: 0, localTax: 0, net: 0, monthlyNet: 0 };
  const I = K.incomeTax;
  const np = Math.min(gross, I.nationalPensionBaseCap) * I.nationalPensionRate;
  const health = gross * I.healthRate;
  const social = np + health + health * I.longTermCareRate + gross * I.employmentRate;
  let deduction = 0, lower = 0;
  for (const b of I.earnedDeduction) {
    if (gross <= b.cap) { deduction = b.base + (gross - lower) * b.rate; break; }
    lower = b.cap;
  }
  deduction = Math.min(deduction, I.earnedDeductionMax);
  const taxBase = Math.max(0, gross - deduction - I.personalDeduction - social);
  let tax = 0;
  lower = 0;
  for (const b of I.brackets) {
    tax += (Math.min(taxBase, b.cap) - lower) * b.rate;
    if (taxBase <= b.cap) break;
    lower = b.cap;
  }
  const rawCredit = tax <= 130 ? tax * 0.55 : 71.5 + (tax - 130) * 0.3;
  const creditCap =
    gross <= 3300 ? 74
    : gross <= 7000 ? Math.max(66, 74 - (gross - 3300) * 0.008)
    : gross <= 12000 ? Math.max(50, 66 - (gross - 7000) * 0.5)
    : 20;
  const incomeTax = Math.max(0, tax - Math.min(rawCredit, creditCap));
  const localTax = incomeTax * I.localTaxRate;
  const net = gross - social - incomeTax - localTax;
  return { gross, social, incomeTax, localTax, net, monthlyNet: net / 12 };
}

export const creditRate = (salary: number) => (salary <= K.tax.salaryThreshold ? K.tax.taxCreditRateLow : K.tax.taxCreditRateHigh);

export function pensionCredit(salary: number, irpAnnualPay: number, psAnnualPay: number) {
  const rate = creditRate(salary);
  const paid = irpAnnualPay + psAnnualPay;
  const credit = Math.min(paid, K.tax.pensionCombinedLimit) * rate;
  const remaining = Math.max(0, K.tax.pensionCombinedLimit - paid);
  return { rate, paid, credit, remaining, monthlyTopUp: remaining / 12, extraCredit: remaining * rate };
}

// ── Profile 파생값 ──
export function maxMonthlyInvest(p: Profile): number | null {
  if (p.salary <= 0) return null;
  return Math.max(1, Math.floor(netSalary(p.salary).monthlyNet));
}
export function monthlyFreeCashFlow(p: Profile): number | null {
  if (p.salary <= 0) return null;
  return netSalary(p.salary).monthlyNet - p.monthlyCost - (p.irp.annualPay + p.pensionSavings.annualPay) / 12;
}

/** 저장·계산 전 정합성 보정 (Profile.sanitized) */
export function sanitized(raw: Profile): Profile {
  const q = clone(raw);
  if (q.currentAge <= 0) q.currentAge = 40;
  if (q.retireAge <= 0) q.retireAge = 60;
  if (q.lifeExpectancy <= q.currentAge) q.lifeExpectancy = Math.max(q.currentAge + 1, K.defaults.lifeExpectancy);
  if (q.retireAge > q.lifeExpectancy) q.retireAge = q.lifeExpectancy;
  if (q.nationalPension.startAge <= 0) q.nationalPension.startAge = K.defaults.nationalStartAge;
  if (q.targetMonthlyCost <= 0) q.targetMonthlyCost = q.monthlyCost;
  const cap = maxMonthlyInvest(q);
  if (cap !== null && q.monthlyInvest > cap) q.monthlyInvest = cap;
  return q;
}

// ── Calculator.swift ──
export interface Snapshot { age: number; netWorth: number; income: number; expense: number; pensionIncome: number }
export interface ScheduleItem { key: string; name: string; startAge: number; monthly: number; lifelong: boolean; endAge: number | null }
export type Status = '가능' | '주의' | '부족';
export interface SimResult {
  snapshots: Snapshot[];
  pensionSchedule: ScheduleItem[];
  totalMonthlyPension: number;
  avgMonthlyPension: number;
  monthlyFromAssets: number;
  liquidAtRetire: number;
  monthlyAvailable: number;
  retirementAsset: number;
  requiredAsset: number;
  achievementRate: number;
  surplus: number;
  depletionAge: number | null;
  fire: boolean;
  status: Status;
}
export interface Include { national: boolean; irp: boolean; ps: boolean; retire: boolean; housing: boolean }
const ALL: Include = { national: true, irp: true, ps: true, retire: true, housing: true };

interface Acc { key: string; name: string; balance: number; annualPay: number; on: boolean; startAge: number; years: number; annualPayout: number; monthly: number }

export function simulate(rawProfile: Profile, inc: Include = ALL): SimResult {
  const p = sanitized(rawProfile);
  const r = realReturn(p);
  const life = p.lifeExpectancy;
  const openAge = Math.max(K.defaults.pensionOpenAge, p.retireAge);

  const netSalaryAt = (t: number) => (t < p.retireAge ? netSalary(salaryAt(p, t)).net : 0);

  const isDC = p.retirePension.type === 'DC';
  const retireGrowth = isDC ? r : realSalaryGrowth(p);
  const retireContribAt = (t: number) => (t < p.retireAge ? salaryAt(p, t) * K.defaults.dcContributionRate : 0);

  const mk = (key: string, name: string, balance: number, annualPay: number, on: boolean): Acc =>
    ({ key, name, balance, annualPay, on, startAge: 0, years: 0, annualPayout: 0, monthly: 0 });
  const accounts: Acc[] = [
    mk('irp', 'IRP', p.irp.balance, p.irp.annualPay, inc.irp),
    mk('ps', '연금저축', p.pensionSavings.balance, p.pensionSavings.annualPay, inc.ps),
    mk('retire', `퇴직연금(${p.retirePension.type})`, p.retirePension.balance, 0, inc.retire),
  ];
  const accGrowth = (key: string) => (key === 'retire' ? retireGrowth : r);
  const accContrib = (acc: Acc, t: number) => (t >= p.retireAge ? 0 : acc.key === 'retire' ? retireContribAt(t) : acc.annualPay);
  for (const a of accounts) {
    a.startAge = openAge;
    a.years = Math.max(0, life - openAge);
    let b = a.balance;
    for (let t = p.currentAge; t < a.startAge; t++) b = b * (1 + accGrowth(a.key)) + accContrib(a, t);
    a.annualPayout = a.years > 0 ? b / a.years : 0;
    a.monthly = a.years > 0 ? b / (a.years * 12) : 0;
  }

  const pensionSchedule: ScheduleItem[] = [];
  if (inc.national && p.nationalPension.monthly > 0)
    pensionSchedule.push({ key: 'national', name: '국민연금', startAge: p.nationalPension.startAge, monthly: p.nationalPension.monthly, lifelong: true, endAge: null });
  for (const a of accounts)
    if (a.on && a.monthly > 0) pensionSchedule.push({ key: a.key, name: a.name, startAge: a.startAge, monthly: a.monthly, lifelong: false, endAge: a.startAge + a.years });
  const hMonthly = housingMonthly(p);
  const hStart = housingStartAge(p);
  if (inc.housing && hMonthly > 0)
    pensionSchedule.push({ key: 'housing', name: '주택연금', startAge: hStart, monthly: hMonthly, lifelong: true, endAge: null });
  const order = ['national', 'retire', 'irp', 'ps', 'housing'];
  pensionSchedule.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const totalMonthlyPension = pensionSchedule.reduce((s, x) => s + x.monthly, 0);

  const livingCostAt = (t: number) => (t < p.retireAge ? p.monthlyCost : p.targetMonthlyCost) * 12;
  const pensionIncomeAt = (t: number) => {
    let sum = 0;
    if (inc.national && t >= p.nationalPension.startAge) sum += p.nationalPension.monthly * 12;
    if (inc.housing && hMonthly > 0 && t >= hStart) sum += hMonthly * 12;
    for (const a of accounts) if (a.on && t >= a.startAge && t < a.startAge + a.years) sum += a.annualPayout;
    return sum;
  };

  let cashBal = p.cash;
  let investBal = p.invest;
  let liquidAtRetire = 0;
  const accBal = accounts.map((a) => a.balance);
  let realEstate = p.realEstate.home + p.realEstate.investment;
  const snapshots: Snapshot[] = [];
  const rh = realHousingGrowth(p);

  for (let t = p.currentAge; t <= life; t++) {
    const liquid = cashBal + investBal;
    const pensionBalanceSum = accBal.reduce((s, x) => s + x, 0);
    const netWorth = liquid + pensionBalanceSum + realEstate - p.debt.balance;
    const retired = t >= p.retireAge;
    if (t === Math.max(p.retireAge, p.currentAge)) liquidAtRetire = Math.max(0, liquid);
    const pensionIncome = pensionIncomeAt(t);
    const income = netSalaryAt(t) + pensionIncome;
    const expense = livingCostAt(t) + p.debt.balance * p.debt.rate;
    snapshots.push({ age: t, netWorth, income, expense, pensionIncome });
    if (t === life) break;

    const totalAnnualPay = retired ? 0 : p.irp.annualPay + p.pensionSavings.annualPay;
    const invContrib = retired ? 0 : p.monthlyInvest * 12;
    investBal = investBal * (1 + r) + invContrib;
    cashBal += income - expense - totalAnnualPay - invContrib;
    if (cashBal < 0) {
      investBal += cashBal;
      cashBal = 0;
      if (investBal < 0) { cashBal = investBal; investBal = 0; }
    }
    realEstate *= 1 + rh;
    accounts.forEach((a, i) => {
      if (t < a.startAge) accBal[i] = accBal[i] * (1 + accGrowth(a.key)) + accContrib(a, t);
      else if (a.on && t < a.startAge + a.years) accBal[i] = Math.max(0, accBal[i] - a.annualPayout);
    });
  }

  const nwAt = (age: number) => snapshots.find((s) => s.age === age)?.netWorth ?? 0;
  const retireStart = Math.max(p.retireAge, p.currentAge);
  const retirementAsset = nwAt(retireStart);
  const depletionAge = snapshots.find((s) => s.netWorth <= 0)?.age ?? null;

  const drawYears = Math.max(0, life - retireStart);
  const drawMonths = drawYears * 12;
  let pensionTotal = 0, shortfallNet = 0, requiredAsset = 0;
  for (let t = retireStart; t < life; t++) {
    const pension = pensionIncomeAt(t);
    const cost = livingCostAt(t);
    pensionTotal += pension;
    shortfallNet += cost - pension;
    requiredAsset += Math.max(0, cost - pension);
  }
  const avgMonthlyPension = drawMonths > 0 ? pensionTotal / drawMonths : 0;
  const monthlyFromAssets = drawMonths > 0 ? liquidAtRetire / drawMonths : 0;
  const monthlyAvailable = avgMonthlyPension + monthlyFromAssets;
  const surplus = liquidAtRetire - shortfallNet;
  const targetM = Math.max(p.targetMonthlyCost, 1);
  const achievementRate = requiredAsset <= 0
    ? (monthlyAvailable >= targetM * 0.9 ? 999 : 0)
    : Math.min(999, (liquidAtRetire / requiredAsset) * 100);
  const ratio = monthlyAvailable / targetM;
  const status: Status = ratio < 0.5 ? '부족' : ratio < 0.9 ? '주의' : '가능';
  const fire = (liquidAtRetire * K.defaults.safeWithdrawalRate) / 12 + avgMonthlyPension >= targetM;

  return {
    snapshots, pensionSchedule, totalMonthlyPension, avgMonthlyPension, monthlyFromAssets,
    liquidAtRetire, monthlyAvailable, retirementAsset, requiredAsset, achievementRate,
    surplus, depletionAge, fire, status,
  };
}

/** 현재 조건으로 status "가능"이 되는 가장 빠른 은퇴 나이 (없으면 null) */
export function earliestRetireAge(rawProfile: Profile, inc: Include = ALL): number | null {
  const p = sanitized(rawProfile);
  const hi = Math.min(p.lifeExpectancy - 1, 80);
  for (let age = p.currentAge + 1; age <= hi; age++) {
    const q = clone(p);
    q.retireAge = age;
    if (simulate(q, inc).status === '가능') return age;
  }
  return null;
}

// ── Format.swift ──
export const comma = (n: number) => Math.trunc(n).toLocaleString('en-US');
/** 만원 금액 → "1억 5,000만원" */
export function manwon(n: number): string {
  const v = swiftRound(n);
  if (v === 0) return '0원';
  if (v < 0) return '-' + manwon(-v);
  const eok = Math.floor(v / 10000), man = v % 10000;
  if (eok > 0 && man > 0) return `${comma(eok)}억 ${comma(man)}만원`;
  if (eok > 0) return `${comma(eok)}억원`;
  return `${comma(man)}만원`;
}

// ── Recommend.swift ── 조건 기반 맞춤 추천, priority 오름차순 최대 5개
export interface Recommendation { id: string; title: string; body: string; priority: number }

export function recommend(p: Profile, sim: SimResult): Recommendation[] {
  const recs: Recommendation[] = [];
  const won = (n: number) => comma(swiftRound(n));

  const pc = pensionCredit(p.salary, p.irp.annualPay, p.pensionSavings.annualPay);
  if (pc.remaining > 0)
    recs.push({ id: 'pension-topup', title: 'IRP·연금저축 한도가 남아 있습니다', priority: 1,
      body: `매월 ${won(pc.monthlyTopUp)}만원을 더 납입하면 올해 세액공제를 ${won(pc.extraCredit)}만원 더 받을 수 있습니다. (합산 한도 ${won(pc.remaining)}만원 여유)` });

  const freeMonthly = (monthlyFreeCashFlow(p) ?? 0) - p.monthlyInvest;
  if (freeMonthly >= 30) {
    const addable = Math.floor(freeMonthly / 10) * 10;
    recs.push({ id: 'invest-more', title: '매달 투자할 여력이 있습니다', priority: 2,
      body: `세후 월소득에서 생활비·연금 납입·월 투자금액을 빼면 약 ${won(addable)}만원이 남습니다. 월 투자금액을 늘리면 현금(물가 수준)이 아닌 기대 수익률로 운용되어 은퇴 자산이 증가합니다.` });
  }

  if (sim.depletionAge !== null) {
    const dep = sim.depletionAge;
    const cut = 30;
    const cutP = clone(p);
    cutP.monthlyCost = Math.max(0, p.monthlyCost - cut);
    cutP.targetMonthlyCost = Math.max(0, p.targetMonthlyCost - cut);
    const cutSim = simulate(cutP);
    const gainYears = (cutSim.depletionAge ?? p.lifeExpectancy) - dep;
    recs.push({ id: 'cost-cut', title: '생활비 절감을 검토해보세요', priority: 3,
      body: `생활비를 월 ${cut}만원 줄이면 자산 고갈 시점이 약 ${Math.max(1, swiftRound(gainYears))}년 늦춰집니다. (현재 고갈 예상: ${dep}세)` });
    for (let delay = 1; delay <= 10; delay++) {
      const laterP = clone(p);
      laterP.retireAge = p.retireAge + delay;
      if (simulate(laterP).depletionAge === null) {
        recs.push({ id: 'retire-later', title: '은퇴 시기를 늦추면 고갈이 사라집니다', priority: 4,
          body: `은퇴 나이를 ${delay}년 늦추면(${p.retireAge + delay}세) 자산 고갈 없이 기대수명까지 유지됩니다.` });
        break;
      }
    }
  }

  if (!p.housingPension.use && p.realEstate.home > 0 && (sim.depletionAge !== null || sim.achievementRate < 100)) {
    const est = housingPensionMonthly(p.realEstate.home, housingStartAge(p));
    const estTxt = est > 0 ? `평생 월 약 ${comma(est)}만원` : '평생 월 수령액';
    recs.push({ id: 'housing-pension', title: '주택연금을 검토해보세요', priority: 5,
      body: `거주 주택(${manwon(p.realEstate.home)})으로 주택연금에 가입하면 ${estTxt}을 확보할 수 있습니다.` });
  }
  return recs.sort((a, b) => a.priority - b.priority).slice(0, 5);
}
