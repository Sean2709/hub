// 연금 절세 계산기 엔진 (/pension/) — 연금저축·IRP 세액공제(넣을 때) + 사적연금 연금소득세(받을 때)
// 2026년 귀속 소득세법 기준 단순화. 금액 단위 = 만원. 세율·누진세율표는 만수르 엔진(K)과 같은 값을 쓴다.
// 근거: 소득세법 §59의3(연금계좌세액공제), §14③9(사적연금 1,500만원 분리과세 선택), §64의4(16.5% 분리과세),
//       §129①5의2(연령별 원천징수 5·4·3%), §47의2(연금소득공제), 조특법 §91의18(ISA 만기 전환 추가공제).
import { K, netSalary } from './mansur';

export const PT = {
  psLimit: 600, // 연금저축 단독 한도
  combinedLimit: K.tax.pensionCombinedLimit, // 연금저축+IRP 합산 900
  isaRate: 0.1, // ISA 만기 전환액의 10%
  isaMax: 300, // 추가 공제 한도
  natRateLow: 0.15, // 국세 (지방소득세 10% 별도 → 16.5%)
  natRateHigh: 0.12, // → 13.2%
  salaryThreshold: K.tax.salaryThreshold, // 총급여 5,500 이하 = 우대
  incomeThreshold: 4500, // (근로소득 외) 종합소득금액 4,500 이하 = 우대
  separateCap: 1500, // 사적연금 연 1,500 이하 → 저율 분리과세
  separateRate: 0.165, // 1,500 초과 시 선택 가능한 분리과세
  otherIncomeRate: 0.165, // 연금외수령(중도 해지 등) 기타소득세
  localTaxRate: K.incomeTax.localTaxRate,
  pensionDeduction: [
    { cap: 350, base: 0, rate: 1 },
    { cap: 700, base: 350, rate: 0.4 },
    { cap: 1400, base: 490, rate: 0.2 },
    { cap: Infinity, base: 630, rate: 0.1 },
  ],
  pensionDeductionMax: 900,
  personalDeduction: K.incomeTax.personalDeduction, // 본인 기본공제 150
  brackets: K.incomeTax.brackets,
} as const;

const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** 종합소득 과세표준 → 국세 산출세액 (누진) */
export function progressiveTax(taxBase: number): number {
  const b = pos(taxBase);
  let tax = 0, lower = 0;
  for (const br of PT.brackets) {
    tax += (Math.min(b, br.cap) - lower) * br.rate;
    if (b <= br.cap) break;
    lower = br.cap;
  }
  return tax;
}

/** 총연금액 → 연금소득공제 (한도 900) */
export function pensionDeduction(total: number): number {
  const t = pos(total);
  let lower = 0;
  for (const s of PT.pensionDeduction) {
    if (t <= s.cap) return Math.min(PT.pensionDeductionMax, s.base + (t - lower) * s.rate);
    lower = s.cap;
  }
  return PT.pensionDeductionMax;
}

// ───────────────────────── 넣을 때: 세액공제 ─────────────────────────
export interface CreditInput {
  incomeType: 'salary' | 'other'; // 근로자(총급여) | 그 외(종합소득금액)
  income: number; // 총급여 또는 종합소득금액
  ps: number; // 연금저축 연 납입
  irp: number; // IRP 연 납입
  isa: number; // 올해 ISA 만기 전환액
  taxCap: number; // 결정세액(국세, 알면 입력). 0 = 추정(근로자) / 제한 없음(그 외)
}
export interface CreditResult {
  preferred: boolean; rate: number; // 지방세 포함 16.5% / 13.2%
  psBase: number; irpBase: number; isaBase: number; base: number; // 공제대상액
  psOver: number; // 연금저축 600 초과로 공제 못 받는 금액
  overLimit: number; // 합산 900 초과 납입분
  isaUnused: number; // ISA 전환액 중 추가공제 반영 안 된 부분(10% 초과·한도 초과)
  credit: number; // 계산상 세액공제 (지방세 포함)
  capNat: number | null; capEstimated: boolean; // 적용한 결정세액 한도(국세)
  applied: number; // 실제 돌려받는 세금 (결정세액 한도 반영)
  lostByCap: number; // 결정세액 부족으로 못 받는 금액
  room: number; // 합산 한도까지 남은 납입 여유
  roomGain: number; // 여유만큼 더 넣으면 추가 환급
  penaltyIfCashed: number; // 공제대상 원금을 연금 외로 찾으면 내는 기타소득세(16.5%)
}

export function credit(inp: CreditInput): CreditResult {
  const income = pos(inp.income), ps = pos(inp.ps), irp = pos(inp.irp), isa = pos(inp.isa);
  const preferred = inp.incomeType === 'salary' ? income <= PT.salaryThreshold : income <= PT.incomeThreshold;
  const nat = preferred ? PT.natRateLow : PT.natRateHigh;
  const rate = nat * (1 + PT.localTaxRate);
  const psBase = Math.min(ps, PT.psLimit);
  const irpBase = Math.min(irp, PT.combinedLimit - psBase);
  const isaBase = Math.min(isa * PT.isaRate, PT.isaMax);
  const base = psBase + irpBase + isaBase;
  const psOver = ps - psBase;
  const overLimit = Math.max(0, ps + irp - PT.combinedLimit);
  const isaUnused = isa - isaBase;
  const creditNat = base * nat;

  let capNat: number | null = null, capEstimated = false;
  if (pos(inp.taxCap) > 0) capNat = pos(inp.taxCap);
  else if (inp.incomeType === 'salary' && income > 0) { capNat = netSalary(income).incomeTax; capEstimated = true; }
  const appliedNat = capNat === null ? creditNat : Math.min(creditNat, capNat);
  const applied = appliedNat * (1 + PT.localTaxRate);
  const room = Math.max(0, PT.combinedLimit - psBase - irpBase);
  const headroomNat = capNat === null ? Infinity : Math.max(0, capNat - appliedNat);
  const roomGain = Math.min(room * nat, headroomNat) * (1 + PT.localTaxRate);
  return {
    preferred, rate, psBase, irpBase, isaBase, base, psOver, overLimit, isaUnused,
    credit: creditNat * (1 + PT.localTaxRate), capNat, capEstimated, applied,
    lostByCap: creditNat * (1 + PT.localTaxRate) - applied, room, roomGain,
    penaltyIfCashed: base * PT.otherIncomeRate,
  };
}

// ───────────────────────── 받을 때: 연금소득세 ─────────────────────────
export interface PayoutInput {
  age: number; // 수령 나이
  lifelong: boolean; // 종신형 연금(생명보험 연금저축 등)
  privateAnnual: number; // 연 사적연금 수령액(세액공제 받은 원금 + 운용수익; 퇴직금 재원 제외)
  publicAnnual: number; // 공적연금 과세 대상 연액(국민연금 등, 2002년 이후 납입분)
  otherIncome: number; // 연금 외 종합소득금액(사업·임대·이자배당 종합과세분 등)
}
export type OptionId = 'low' | 'sep' | 'comp';
export interface PayoutOption { id: OptionId; label: string; tax: number; net: number; eff: number; available: boolean; note: string }
export interface PayoutResult {
  eligible: boolean; // 55세 이상 연금수령
  lowRate: number; overCap: boolean;
  options: PayoutOption[]; best: OptionId | null;
  compDetail: { total: number; deduction: number; taxBase: number; withTax: number; withoutTax: number };
  cashOutTax: number; // 연금 외 수령 시 16.5%
}

export function lowRateFor(age: number, lifelong: boolean): number {
  const byAge = age >= 80 ? 0.03 : age >= 70 ? 0.04 : 0.05;
  const nat = lifelong ? Math.min(byAge, 0.04) : byAge; // 종신형은 4% (80세 이상은 3%)
  return nat * (1 + PT.localTaxRate);
}

/** 연금·기타 종합소득 → 종합소득세(지방세 포함). 공제: 연금소득공제 + 본인 기본공제만 */
function comprehensiveTax(pensionTotal: number, other: number) {
  const deduction = pensionDeduction(pensionTotal);
  const taxBase = Math.max(0, pos(pensionTotal) - deduction + pos(other) - PT.personalDeduction);
  return { deduction, taxBase, tax: progressiveTax(taxBase) * (1 + PT.localTaxRate) };
}

export function payout(inp: PayoutInput): PayoutResult {
  const age = Number.isFinite(inp.age) ? inp.age : 0;
  const priv = pos(inp.privateAnnual), pub = pos(inp.publicAnnual), other = pos(inp.otherIncome);
  const eligible = age >= 55;
  const lowRate = lowRateFor(age, inp.lifelong);
  const overCap = priv > PT.separateCap;
  const withC = comprehensiveTax(pub + priv, other);
  const without = comprehensiveTax(pub, other);
  const compTax = Math.max(0, withC.tax - without.tax); // 사적연금 때문에 늘어나는 종합소득세
  const mk = (id: OptionId, label: string, tax: number, available: boolean, note: string): PayoutOption => ({
    id, label, tax, net: priv - tax, eff: priv > 0 ? tax / priv : 0, available, note,
  });
  const options: PayoutOption[] = [
    mk('low', `저율 분리과세 ${(lowRate * 100).toFixed(1)}%`, priv * lowRate, eligible && !overCap,
      overCap ? `연 ${PT.separateCap.toLocaleString('en-US')}만원 초과라 적용 불가` : '원천징수로 끝, 신고 불필요'),
    mk('sep', '16.5% 분리과세', priv * PT.separateRate, eligible && overCap,
      overCap ? '5월 종합소득세 신고 때 선택' : `연 ${PT.separateCap.toLocaleString('en-US')}만원 초과일 때만 선택`),
    mk('comp', '종합과세', compTax, eligible, '다른 소득과 합산, 누진세율 6~45%'),
  ];
  const avail = options.filter((o) => o.available);
  const best = avail.length && priv > 0 ? avail.reduce((a, b) => (b.tax < a.tax - 1e-9 ? b : a)).id : null;
  return {
    eligible, lowRate, overCap, options, best,
    compDetail: { total: pub + priv, deduction: withC.deduction, taxBase: withC.taxBase, withTax: withC.tax, withoutTax: without.tax },
    cashOutTax: priv * PT.otherIncomeRate,
  };
}

/** 만원 → "1,485,000원" (원 단위 반올림) */
export const won = (manwon: number) => `${Math.round((Number.isFinite(manwon) ? manwon : 0) * 10000).toLocaleString('en-US')}원`;
export const pct = (r: number, d = 1) => `${(r * 100).toFixed(d)}%`;
