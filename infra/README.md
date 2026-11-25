# infra — AWS resources for hub.seanson.com

Everything here now lives in the personal account `seanson` (081155410611), ap-northeast-2.

| Folder | What |
|---|---|
| [`analytics/`](analytics/README.md) | cookie-less visitor analytics: API GW HTTP API `5m1ffl4pvd` → Lambda → DynamoDB `hub-analytics` (re-created 2026-11-25) |

## History: retired Bedrock refresh workflow

The `/bedrock/` catalog, its daily `bedrock-refresh.yml` workflow, the generator scripts and the
IAM policy JSON files were removed from this repo on 2026-11-19. Their AWS side (OIDC provider,
role `hub-bedrock-refresh`, inline policy `bedrock-catalog-readonly`) lived in the old LZA account
sean-workload (461839758724) and went away with that account when it was closed (2026-11-25).
The GitHub repo variable `AWS_ROLE_ARN` that pointed at that role was removed the same day.
Nothing in the repo or its workflows uses AWS credentials any more.
