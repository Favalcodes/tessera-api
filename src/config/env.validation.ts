import { z } from 'zod';

/**
 * Environment schema. The process refuses to boot on anything missing or
 * malformed — a service that starts with a half-configured database URL and
 * fails on the first request is strictly worse than one that never starts.
 */

const DEV_SECRET_MARKER = 'dev-only';

const seconds = (label: string) =>
  z.coerce.number().int().positive({ message: `${label} must be a positive number of seconds` });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    DATABASE_URL: z
      .string()
      .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgres:// connection string',
      }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: seconds('JWT_ACCESS_TTL').default(900),
    JWT_REFRESH_TTL: seconds('JWT_REFRESH_TTL').default(2_592_000),

    SIGNUP_GRANT_MINOR: z.coerce.number().int().positive().default(100_000),

    /** How long bets are accepted before a round locks and takes off. */
    ROUND_BETTING_WINDOW_MS: z.coerce.number().int().min(1_000).default(15_000),
    /** Pause between one round settling and the next opening. */
    ROUND_INTERMISSION_MS: z.coerce.number().int().min(0).default(4_000),
    MIN_STAKE_MINOR: z.coerce.number().int().positive().default(100),
    MAX_STAKE_MINOR: z.coerce.number().int().positive().default(1_000_000),

    /** Operational off switch for rate limiting; see ConfigurableThrottlerGuard. */
    THROTTLE_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'refresh and access secrets must differ, or an access token can be replayed as a refresh token',
      });
    }

    // The .env.example placeholders are deliberately long enough to pass the length
    // check so local setup is frictionless. That makes it entirely possible to ship
    // them by accident, so production refuses them by name.
    if (env.MIN_STAKE_MINOR > env.MAX_STAKE_MINOR) {
      ctx.addIssue({
        code: 'custom',
        path: ['MIN_STAKE_MINOR'],
        message: 'minimum stake cannot exceed the maximum',
      });
    }

    if (env.NODE_ENV === 'production' && !env.THROTTLE_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['THROTTLE_ENABLED'],
        message: 'rate limiting may not be disabled in production',
      });
    }

    if (env.NODE_ENV === 'production') {
      for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (env[key].includes(DEV_SECRET_MARKER)) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is still the development placeholder; generate one with \`openssl rand -base64 48\``,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

/** Split the configured CORS_ORIGINS list into concrete origins. */
export function corsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
