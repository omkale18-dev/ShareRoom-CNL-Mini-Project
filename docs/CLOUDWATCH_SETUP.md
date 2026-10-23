# ShareRoom AWS monitoring setup

This optional integration runs on **EC2-1**, the default application target. It uses EC2 instance-profile credentials, not hardcoded keys.

## IAM role

Attach an IAM role to EC2-1 with this minimum read-only policy (scope the ELB permission to the relevant target groups where practical):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "cloudwatch:GetMetricData", "Resource": "*"},
    {"Effect": "Allow", "Action": "elasticloadbalancing:DescribeTargetHealth", "Resource": "*"}
  ]
}
```

EC2 console → Instances → EC2-1 → Actions → Security → Modify IAM role.

## Configuration

Find ARNs under EC2 → Load Balancers → shareroom-alb and EC2 → Target Groups → each target group.

Add these to the EC2-1 `shareroom.service` systemd override (via `sudo systemctl edit shareroom`):

```ini
[Service]
Environment="AWS_DEFAULT_REGION=us-east-1"
Environment="SHAREROOM_ALB_ARN=arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:loadbalancer/app/NAME/ID"
Environment="SHAREROOM_APP_TG_ARN=arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:targetgroup/NAME/ID"
Environment="SHAREROOM_MONITOR_TG_ARN=arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:targetgroup/NAME/ID"
```

Replace placeholders with **your actual ARN values**. Do not copy the example values unchanged.

Deploy the updated code to the active application directory, activate its virtual environment, run `pip install -r requirements.txt`, then `sudo systemctl daemon-reload && sudo systemctl restart shareroom`.

Verify: `curl http://127.0.0.1:8000/api/network/aws-metrics`. View the dashboard through the ALB DNS.

The ALB listener must forward `/api/network/aws-metrics` to the **application target group (EC2-1)**, not the monitor target group. The existing monitor rule should match only `/api/network/instance`.

CloudWatch metrics are delayed, and the response time displayed is the average of one-minute averages. This is not an exact request-weighted average.

Keep rooms/files/WebSockets on EC2-1 until shared state is implemented.
