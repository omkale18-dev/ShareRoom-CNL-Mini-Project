"""Read-only AWS ALB monitoring. Uses the EC2 IAM role credential chain."""
import os
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError, NoRegionError


def _dimension(arn, resource):
    marker = ":" + resource + "/"
    if marker not in arn:
        raise ValueError("Invalid " + resource + " ARN")
    return resource + "/" + arn.split(marker, 1)[1]


def get_alb_metrics():
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    alb_arn = os.environ.get("SHAREROOM_ALB_ARN", "").strip()
    app_arn = os.environ.get("SHAREROOM_APP_TG_ARN", "").strip()
    monitor_arn = os.environ.get("SHAREROOM_MONITOR_TG_ARN", "").strip()
    if not alb_arn or not app_arn or not monitor_arn:
        return {"connected": False, "error": "Set SHAREROOM_ALB_ARN, SHAREROOM_APP_TG_ARN and SHAREROOM_MONITOR_TG_ARN on EC2-1."}

    try:
        lb_dimension = _dimension(alb_arn, "loadbalancer")
        elbv2 = boto3.client("elbv2", region_name=region)
        cloudwatch = boto3.client("cloudwatch", region_name=region)
        targets = {}
        for label, arn in (("application", app_arn), ("monitor", monitor_arn)):
            desc = elbv2.describe_target_health(TargetGroupArn=arn)["TargetHealthDescriptions"]
            targets[label] = {
                "healthy": sum(t["TargetHealth"]["State"] == "healthy" for t in desc),
                "unhealthy": sum(t["TargetHealth"]["State"] == "unhealthy" for t in desc),
                "other": sum(t["TargetHealth"]["State"] not in ("healthy", "unhealthy") for t in desc),
                "details": [
                    {
                        "id": t["Target"].get("Id", ""),
                        "state": t["TargetHealth"]["State"],
                        "reason": t["TargetHealth"].get("Reason", ""),
                    } for t in desc
                ],
            }

        end = datetime.now(timezone.utc)
        start = end - timedelta(minutes=60)
        dimensions = [{"Name": "LoadBalancer", "Value": lb_dimension}]
        queries = [
            {"Id": "requests", "MetricStat": {"Metric": {"Namespace": "AWS/ApplicationELB", "MetricName": "RequestCount", "Dimensions": dimensions}, "Period": 60, "Stat": "Sum"}, "ReturnData": True},
            {"Id": "response", "MetricStat": {"Metric": {"Namespace": "AWS/ApplicationELB", "MetricName": "TargetResponseTime", "Dimensions": dimensions}, "Period": 60, "Stat": "Average"}, "ReturnData": True},
        ]
        response = cloudwatch.get_metric_data(MetricDataQueries=queries, StartTime=start, EndTime=end, ScanBy="TimestampDescending")
        series = {r["Id"]: r for r in response.get("MetricDataResults", [])}
        counts = series.get("requests", {}).get("Values", [])
        times = series.get("response", {}).get("Values", [])
        return {
            "connected": True,
            "region": region,
            "window_minutes": 60,
            "targets": targets,
            "request_count": round(sum(counts)),
            "target_response_time_ms": round(sum(times) / len(times) * 1000, 1) if times else None,
            "note": "CloudWatch metrics can lag several minutes. Response time is the mean of available one-minute averages, not a request-weighted mean.",
        }
    except (BotoCoreError, ClientError, NoCredentialsError, NoRegionError, ValueError) as exc:
        return {"connected": False, "error": "AWS metrics unavailable: " + str(exc)[:250]}
