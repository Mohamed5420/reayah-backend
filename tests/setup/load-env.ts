// The load test sends thousands of requests from one IP: lift the per-IP limits for it.
process.env.RATE_LIMIT_PER_MINUTE = '100000000';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '100000000';
