# mansur-parity — 웹 엔진 ↔ iOS 앱 엔진 교차 검증

`/retire/`(은퇴 자산 계산기)는 iOS 앱 「은퇴하면 만수르」의 계산 엔진(Swift)을
`src/lib/mansur.ts`로 1:1 포팅해 쓴다. 두 엔진이 같은 결과를 내는지 무작위 프로필로 비교한다.

## 실행

```sh
./scripts/mansur-parity/run.sh        # 기본 400개 + 샘플·빈 프로필 2개
./scripts/mansur-parity/run.sh 2000   # 개수 지정
```

- 필요: macOS `swiftc`, Node ≥ 22.12(`.ts` 직접 실행), 앱 소스
  (`~/Documents/Projects/Retire Mansur/RetireMansur/Models`, 다른 경로면 `MANSUR_MODELS=` 지정)
- 흐름: `parity.ts gen` → 프로필 JSON 생성 → `main.swift`(앱 Models 소스와 함께 컴파일)로 앱 엔진 결과 →
  `parity.ts cmp`로 항목별 비교(판정·월 가용액·고갈 나이·연금 스케줄·세후 월급·최단 은퇴 나이·추천 등)
- CI에서는 돌리지 않는다(앱 소스가 비공개 저장소). 앱 엔진이나 `mansur.ts`를 고치면 수동으로 실행할 것.

## 기록

- 2026-09-24: 402개 × 18개 항목 = 7,236건 전부 일치
