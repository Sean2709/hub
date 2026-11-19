# infra — leftover AWS resources from the retired Bedrock refresh workflow

The `/bedrock/` catalog, its daily `bedrock-refresh.yml` workflow, the generator scripts and the
IAM policy JSON files were removed from this repo on 2026-11-19. The AWS side was intentionally
left untouched and still exists in account sean-workload (461839758724):

| Resource | Name | Notes |
|---|---|---|
| IAM OIDC provider | `token.actions.githubusercontent.com` | audience `sts.amazonaws.com` |
| IAM role | `hub-bedrock-refresh` | trust: `repo:Sean2709@214588092/hub@1381576445:ref:refs/heads/main` only |
| Inline policy | `bedrock-catalog-readonly` | `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` |
| GitHub repo variable | `AWS_ROLE_ARN` | `arn:aws:iam::461839758724:role/hub-bedrock-refresh` |

Nothing in the repo uses them any more. If they are cleaned up later (needs explicit approval):

```sh
aws iam delete-role-policy --role-name hub-bedrock-refresh --policy-name bedrock-catalog-readonly
aws iam delete-role --role-name hub-bedrock-refresh
gh variable delete AWS_ROLE_ARN
# OIDC provider: delete only if no other role trusts it
```

The analytics backend lives in [`analytics/`](analytics/README.md) and is unrelated.
