# Static UI image for the Agentic API Gateway chat frontend, served by nginx on port 80.
# Built and pushed to ECR by you (no Docker in the CI/agent env), then run on ECS Fargate behind an ALB.
#
#   REPO=$(cd terraform && terraform output -raw web_ecr_repository_url)
#   aws ecr get-login-password --region us-gov-west-1 | docker login --username AWS --password-stdin "${REPO%/*}"
#   docker build -t "$REPO:latest" .
#   docker push "$REPO:latest"
#   aws ecs update-service --cluster bedrock-reporting-dev-web --service bedrock-reporting-dev-web --force-new-deployment --region us-gov-west-1
#
# Only the UI files are copied (no README/Dockerfile/etc.), so the image is tiny and clean.
FROM nginx:1.27-alpine

# Static UI files. telemetry/charts/dashboard back the Dashboard view and MUST be listed here —
# index.html loads them by name, and a missing file leaves the view blank with a 404 in the console.
COPY web/index.html web/app.js web/styles.css /usr/share/nginx/html/
COPY web/telemetry.js web/charts.js web/dashboard.js web/dashboard.css /usr/share/nginx/html/

# Site config as a TEMPLATE: the nginx image entrypoint renders /etc/nginx/templates/*.template with
# envsubst at container start, injecting ${API_BASE_URL} (the current API Gateway URL, set on the ECS
# task by Terraform) so nginx reverse-proxies /v1/* to it — no API URL is baked into the image.
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
