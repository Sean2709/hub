# infra — one-time AWS setup for the Bedrock refresh workflow

Account: sean-workload (461839758724). Created 2026-09-22.

| Resource | Name | Notes |
|---|---|---|
| IAM OIDC provider | `token.actions.githubusercontent.com` | audience `sts.amazonaws.com` |
| IAM role | `hub-bedrock-refresh` | trust: `repo:Sean2709/hub:ref:refs/heads/main` only ([trust-policy.json](trust-policy.json)) |
| Inline policy | `bedrock-catalog-readonly` | `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` ([bedrock-readonly-policy.json](bedrock-readonly-policy.json)) |
| GitHub repo variable | `AWS_ROLE_ARN` | `arn:aws:iam::461839758724:role/hub-bedrock-refresh` |

No access keys or secrets anywhere; the Actions runner exchanges its GitHub OIDC token for
short-lived credentials on every run. Recreate with:

```sh
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
aws iam create-role --role-name hub-bedrock-refresh --assume-role-policy-document file://trust-policy.json
aws iam put-role-policy --role-name hub-bedrock-refresh --policy-name bedrock-catalog-readonly \
  --policy-document file://bedrock-readonly-policy.json
gh variable set AWS_ROLE_ARN --body arn:aws:iam::461839758724:role/hub-bedrock-refresh
```
