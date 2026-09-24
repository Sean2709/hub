// Parity harness: reads profiles JSON (argv[1]) → prints app-engine results JSON to stdout.
import Foundation
let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let profiles = try! JSONDecoder().decode([Profile].self, from: data)
var out: [[String: Any]] = []
for p in profiles {
    let s = Calculator.simulate(p)
    let ns = Tax.netSalary(p.salary)
    out.append([
        "status": s.status, "fire": s.fire, "depletionAge": s.depletionAge as Any? ?? NSNull(),
        "liquidAtRetire": s.liquidAtRetire, "monthlyAvailable": s.monthlyAvailable,
        "avgMonthlyPension": s.avgMonthlyPension, "monthlyFromAssets": s.monthlyFromAssets,
        "retirementAsset": s.retirementAsset, "requiredAsset": s.requiredAsset,
        "achievementRate": s.achievementRate, "surplus": s.surplus, "totalMonthlyPension": s.totalMonthlyPension,
        "schedule": s.pensionSchedule.map { ["key": $0.key, "name": $0.name, "startAge": $0.startAge, "monthly": $0.monthly] as [String: Any] },
        "nw": s.snapshots.map { $0.netWorth },
        "earliest": Calculator.earliestRetireAge(p) as Any? ?? NSNull(),
        "netSalary": ns.net,
        "recs": Recommend.generate(p.sanitized, s).map { $0.body },
        "fmt": Format.manwon(s.retirementAsset),
    ])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
