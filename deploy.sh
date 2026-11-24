#!/bin/bash
# Развёртывание приложения TimeCapsule на сервере: bash deploy.sh <inline|sns>
#
# При первом запуске файл .env создаётся из переменных окружения:
#   EVENTS_TOPIC_ARN, AWS_REGION (остальное — DB_*, SESSION_SECRET и т.д.).
# При следующих запусках меняется только MAIL_MODE.
set -e
MODE="${1:-inline}"
cd /home/ec2-user/timecapsule

if ! grep -q '^MAIL_MODE=' .env; then
  if [ -z "$EVENTS_TOPIC_ARN" ]; then
    echo "EVENTS_TOPIC_ARN не задан: укажите ARN темы SNS" >&2
    exit 1
  fi
  cat >> .env <<EOF
MAIL_MODE=$MODE
MAIL_DELAY_SECONDS=5
EVENTS_TOPIC_ARN=$EVENTS_TOPIC_ARN
AWS_REGION=${AWS_REGION:-eu-central-1}
EOF
else
  sed -i "s/^MAIL_MODE=.*/MAIL_MODE=$MODE/" .env
fi

sudo systemctl restart timecapsule
sleep 4
curl -s localhost:3000/health
echo
curl -s -o /dev/null -w 'seal request: %{http_code} %{time_total}s\n' \
  -X POST --data 'title=Baseline+test&body=hello&open_at=2026-12-01T10:00:00Z' \
  http://localhost:3000/seal
