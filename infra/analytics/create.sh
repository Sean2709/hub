#!/bin/bash
# hub-analytics backend in personal account seanson (081155410611), ap-northeast-2. Idempotent-ish: each step skips if exists.
set -euo pipefail
export AWS_PROFILE=seanson AWS_REGION=ap-northeast-2 AWS_PAGER=""
ACCT=081155410611; R=ap-northeast-2; ORIGIN=https://hub.seanson.com
SRC=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d)  # scratch for the zip / env files
SEC=~/.hub-analytics-secrets
GCID=53886632583-rg6ckd1ph9chkniojam8kc065ems88hp.apps.googleusercontent.com
ADMINS=seanson2709@gmail.com
TAGJ='{"project":"hub"}'

# secrets (never printed)
if [ ! -f "$SEC" ]; then
  umask 077
  python3 - "$SEC" <<'PY'
import secrets,sys
open(sys.argv[1],"w").write(f"SITE_KEY={secrets.token_hex(12)}\nSALT_SECRET={secrets.token_hex(32)}\n")
PY
fi
chmod 600 "$SEC"
SITE_KEY=$(grep '^SITE_KEY=' "$SEC" | cut -d= -f2); SALT=$(grep '^SALT_SECRET=' "$SEC" | cut -d= -f2)

# log groups (14 d)
for f in hub-analytics hub-analytics-authorizer; do
  aws logs create-log-group --log-group-name /aws/lambda/$f --tags project=hub 2>/dev/null || echo "loggroup $f exists"
  aws logs put-retention-policy --log-group-name /aws/lambda/$f --retention-in-days 14
done

# DynamoDB
if ! aws dynamodb describe-table --table-name hub-analytics >/dev/null 2>&1; then
  aws dynamodb create-table --table-name hub-analytics \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST --deletion-protection-enabled \
    --tags Key=project,Value=hub --query TableDescription.TableStatus
  aws dynamodb wait table-exists --table-name hub-analytics
fi
aws dynamodb update-time-to-live --table-name hub-analytics --time-to-live-specification Enabled=true,AttributeName=ttl --query TimeToLiveSpecification 2>/dev/null || echo "ttl already set"

# IAM roles
mk_role() { # name policyfile policyname
  if ! aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam create-role --role-name "$1" --assume-role-policy-document file://$SRC/lambda-trust.json \
      --tags Key=project,Value=hub --query Role.Arn
  fi
  aws iam put-role-policy --role-name "$1" --policy-name "$3" --policy-document file://$SRC/$2
}
mk_role hub-analytics-lambda policy-collector.json hub-analytics-collector
mk_role hub-analytics-authorizer policy-authorizer.json hub-analytics-authorizer-logs
sleep 12

# Lambda
cd "$W"; /usr/bin/zip -qj hub-analytics.zip $SRC/lambda_function.py
python3 - "$SITE_KEY" "$SALT" "$GCID" "$ADMINS" "$ORIGIN" <<'PY'
import json,sys
k,salt,gc,ad,o=sys.argv[1:]
base={"TABLE":"hub-analytics","GOOGLE_CLIENT_ID":gc,"ADMIN_EMAILS":ad,"SITE_KEY":k,"ALLOWED_ORIGINS":o}
json.dump({"Variables":{**base,"SALT_SECRET":salt}},open("env-collector.json","w"))
json.dump({"Variables":base},open("env-authorizer.json","w"))
PY
chmod 600 env-collector.json env-authorizer.json
mk_fn() { # name handler mem timeout role envfile
  if ! aws lambda get-function --function-name "$1" >/dev/null 2>&1; then
    aws lambda create-function --function-name "$1" --runtime python3.13 --architectures arm64 \
      --handler "$2" --memory-size "$3" --timeout "$4" --role arn:aws:iam::$ACCT:role/$5 \
      --zip-file fileb://hub-analytics.zip --environment file://$6 \
      --logging-config LogFormat=Text,LogGroup=/aws/lambda/$1 \
      --tags project=hub --query FunctionArn
  fi
  aws lambda wait function-active-v2 --function-name "$1"
}
mk_fn hub-analytics lambda_function.lambda_handler 256 15 hub-analytics-lambda env-collector.json
mk_fn hub-analytics-authorizer lambda_function.authorizer_handler 128 5 hub-analytics-authorizer env-authorizer.json
/bin/rm -f env-collector.json env-authorizer.json

# HTTP API
API=$(aws apigatewayv2 get-apis --query "Items[?Name=='hub-analytics'].ApiId | [0]" --output text)
if [ "$API" = "None" ] || [ -z "$API" ]; then
  API=$(aws apigatewayv2 create-api --name hub-analytics --protocol-type HTTP \
    --cors-configuration "{\"AllowOrigins\":[\"$ORIGIN\"],\"AllowMethods\":[\"GET\",\"POST\"],\"AllowHeaders\":[\"authorization\",\"content-type\"],\"MaxAge\":600}" \
    --tags project=hub --query ApiId --output text)
fi
echo "API=$API"
FN=arn:aws:lambda:$R:$ACCT:function
INT=$(aws apigatewayv2 get-integrations --api-id $API --query 'Items[0].IntegrationId' --output text)
if [ "$INT" = "None" ]; then
  INT=$(aws apigatewayv2 create-integration --api-id $API --integration-type AWS_PROXY \
    --integration-uri $FN:hub-analytics --payload-format-version 2.0 --timeout-in-millis 15000 \
    --query IntegrationId --output text)
fi
mk_auth() { # name identitysources
  local id; id=$(aws apigatewayv2 get-authorizers --api-id $API --query "Items[?Name=='$1'].AuthorizerId | [0]" --output text)
  if [ "$id" = "None" ]; then
    id=$(aws apigatewayv2 create-authorizer --api-id $API --name "$1" --authorizer-type REQUEST \
      --authorizer-uri arn:aws:apigateway:$R:lambda:path/2015-03-31/functions/$FN:hub-analytics-authorizer/invocations \
      --identity-source $2 --authorizer-payload-format-version 2.0 --enable-simple-responses \
      --authorizer-result-ttl-in-seconds 300 --query AuthorizerId --output text)
  fi
  echo "$id"
}
A_SITE=$(mk_auth site-key '$request.querystring.k $request.header.origin')
A_ADMIN=$(mk_auth admin-bearer '$request.header.authorization')
echo "authorizers site-key=$A_SITE admin-bearer=$A_ADMIN"
mk_route() { # key authid
  local id; id=$(aws apigatewayv2 get-routes --api-id $API --query "Items[?RouteKey=='$1'].RouteId | [0]" --output text)
  if [ "$id" = "None" ]; then
    aws apigatewayv2 create-route --api-id $API --route-key "$1" --target integrations/$INT \
      --authorization-type CUSTOM --authorizer-id $2 --query RouteId --output text
  fi
}
mk_route 'POST /collect' $A_SITE
mk_route 'GET /stats' $A_ADMIN
mk_route 'GET /health' $A_ADMIN
if ! aws apigatewayv2 get-stage --api-id $API --stage-name '$default' >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id $API --stage-name '$default' --auto-deploy \
    --default-route-settings ThrottlingRateLimit=20,ThrottlingBurstLimit=50 --tags project=hub --query StageName
fi

# invoke permissions scoped to this API
aws lambda add-permission --function-name hub-analytics --statement-id apigw-hub-analytics \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$R:$ACCT:$API/*/*" --query Statement --output text 2>/dev/null || echo "perm collector exists"
aws lambda add-permission --function-name hub-analytics-authorizer --statement-id apigw-hub-analytics-authorizers \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$R:$ACCT:$API/authorizers/*" --query Statement --output text 2>/dev/null || echo "perm authorizer exists"

echo "ENDPOINT=https://$API.execute-api.$R.amazonaws.com"
