/** Environment config — fail fast on missing prod values. */
const env = process.env;
export const CONFIG = {
  port: Number(env.PORT ?? 3000),
  nodeEnv: env.NODE_ENV ?? 'development',
  databaseUrl: env.DATABASE_URL ?? 'postgres://runverse:runverse@localhost:5432/runverse',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtAccessTtl: '15m',
  /** local dir standing in for S3 in dev; S3 adapter selected when set */
  streamBucket: env.STREAM_BUCKET, // e.g. s3://runverse-streams
  streamDir: env.STREAM_DIR ?? '/tmp/runverse-streams',
  isProd: (env.NODE_ENV ?? 'development') === 'production',
  /** dev/staging only: echo OTP codes in the API response so remote testing needs no log access */
  devOtpEcho: env.DEV_OTP_ECHO === 'true',
} as const;

if (CONFIG.isProd && CONFIG.jwtSecret === 'dev-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
