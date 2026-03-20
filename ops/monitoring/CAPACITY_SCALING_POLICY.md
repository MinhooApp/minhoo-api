# Capacity Scaling Policy (70/80/90)

## Objective

Avoid service crashes by scaling before saturation.

Current baseline for authenticated chat/realtime profile:

- Safe baseline: `RISK_BASELINE_SAFE_RPS=55`
- Approx safe concurrent heavy users: ~100

## Thresholds

- `70%` (Warning): prepare scaling.
- `80%` (Scale now): execute infrastructure scaling immediately.
- `90%` (Critical): scale + apply temporary containment.

The monitor computes utilization as:

`utilization_percent = observed_rps / RISK_BASELINE_SAFE_RPS * 100`

## Actions by threshold

### 70% Warning

- Freeze non-essential deployments.
- Validate current service health and latency trend.
- Prepare next capacity tier (compute + memory).

### 80% Scale Now

- Scale server resources now (recommended target: 4 vCPU / 8 GB).
- If available, add a second app host behind load balancer.
- Keep close monitoring for 15 minutes after scaling.

### 90% Critical

- Execute urgent scaling.
- Apply temporary containment on non-critical traffic (feed/reels burst controls).
- Prioritize chat/realtime traffic and incident communication.

## Exit criteria

Leave incident mode when all conditions hold for 15 minutes:

- Utilization below `70%`.
- No service down checks.
- No high-severity risks.
- Latency trend stable.

