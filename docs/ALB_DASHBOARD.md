# ALB Load Balancing Dashboard

The **Network Monitor** page is available at `/static/network.html` and from the ShareRoom header.

## What is implemented
- `GET /health` responds with `{"status":"ok"}` for ALB target-group health checks.
- `GET /api/network/instance` returns the configured instance label, local process probe counter, uptime and timestamp.
- A browser dashboard sends 1–100 sequential independent HTTP probe requests, measures client-observed response time, and shows the share handled by each instance.
- All displayed request counts are **test samples only**. They are not CloudWatch ALB RequestCount or total application requests.
- No AWS credentials are stored in the frontend.

## Run two independent instances for an ALB demonstration
1. Set environment variable `INSTANCE_NAME=EC2-1` on the first instance, and `INSTANCE_NAME=EC2-2` on the second (in each systemd service environment).
2. Deploy the same code to both instances and restart their services.
3. Create an internet-facing AWS **Application Load Balancer**, a target group using HTTP port **80**, health check path `/health`, and register both EC2 instances.
4. Allow ALB inbound HTTP 80 (or HTTPS 443 with a certificate) and allow the instances' port 80 inbound **from the ALB security group**. Keep Uvicorn port 8000 private.
5. Open the ALB DNS name, navigate to Network Monitor, and run 20–100 probes. Observe which backend served each response.
6. In the AWS Console inspect EC2 → Target Groups → Targets for real target health, and CloudWatch for ALB metrics.

**Important:** The current ShareRoom stores SQLite, uploaded files, and WebSocket connections separately on each instance. **Do not use two active targets for real rooms and file sharing yet**: shared DB/storage and cross-instance WebSocket pub/sub are required first. The dashboard is a safe stateless load-balancing demonstration.

The dashboard does not directly read CloudWatch, detect target health, or automatically configure an ALB. An ALB with only one healthy target cannot demonstrate distribution. Request distribution is not guaranteed to be 50/50. Long-lived WebSocket connections stay on the selected target.

## Verify
Run `python -m pytest -q` and visit `/health`, `/api/network/instance`, and `/static/network.html` locally. For the actual ALB experiment, use its DNS name and compare observations with AWS target-group status.
