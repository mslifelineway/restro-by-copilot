// Runs before any module is imported: relax per-IP auth throttling so the suite can log in many times.
process.env.THROTTLE_AUTH_PER_MIN = '1000';
process.env.THROTTLE_DEFAULT_PER_MIN = '100000';
