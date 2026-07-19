import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import Redis from 'ioredis';
import { DbService } from '../db/db.service';
import { REDIS } from '../redis/redis.module';
import { Problem } from '../common/problem';
import { CONFIG } from '../config';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface JwtClaims { sub: string; dev: string }

@Injectable()
export class AuthService {
  constructor(
    private db: DbService,
    private jwt: JwtService,
    @Inject(REDIS) private redis: Redis,
  ) {}

  /** Dev OTP provider logs the code; prod swaps in an SMS gateway behind the same interface. */
  async requestOtp(phone: string): Promise<{ dev_code?: string }> {
    const attempts = await this.redis.incr(`otp:attempts:${phone}`);
    if (attempts === 1) await this.redis.expire(`otp:attempts:${phone}`, 3600);
    if (attempts > 3) throw new Problem(HttpStatus.TOO_MANY_REQUESTS, 'OTP_RATE_LIMITED', 'Max 3 OTP requests per hour');
    const code = String(randomInt(100000, 999999));
    await this.redis.set(`otp:${phone}`, sha256(code), 'EX', 300);
    if (!CONFIG.isProd) console.log(`[dev-otp] ${phone} → ${code}`);
    // prod: await this.sms.send(phone, code)
    return CONFIG.devOtpEcho && !CONFIG.isProd ? { dev_code: code } : {};
  }

  async verifyOtp(phone: string, code: string, device: { platform: string; model?: string }) {
    const stored = await this.redis.get(`otp:${phone}`);
    if (!stored || stored !== sha256(code)) {
      throw new Problem(HttpStatus.UNAUTHORIZED, 'OTP_INVALID', 'Wrong or expired code');
    }
    await this.redis.del(`otp:${phone}`);

    let user = await this.db.one<{ id: string; handle: string; status: string }>(
      'SELECT id, handle, status FROM users WHERE phone_e164=$1', [phone]);
    const isNew = !user;
    if (!user) {
      const handle = `runner_${randomBytes(4).toString('hex')}`;
      user = (await this.db.one(
        `INSERT INTO users(phone_e164, handle, display_name, color)
         VALUES ($1,$2,$3,$4) RETURNING id, handle, status`,
        [phone, handle, handle, randomColor()]))!;
    }
    if (user.status === 'banned') throw new Problem(HttpStatus.FORBIDDEN, 'ACCOUNT_BANNED', 'Account is banned');

    const dev = await this.db.one<{ id: string }>(
      `INSERT INTO devices(user_id, platform, model) VALUES ($1,$2,$3) RETURNING id`,
      [user.id, device.platform, device.model ?? null]);
    const tokens = await this.issueTokens(user.id, dev!.id);
    return { ...tokens, user: { id: user.id, handle: user.handle }, is_new: isNew };
  }

  private async issueTokens(userId: string, deviceId: string) {
    const access = await this.jwt.signAsync({ sub: userId, dev: deviceId } satisfies JwtClaims);
    const refresh = randomBytes(32).toString('base64url');
    await this.db.query('UPDATE devices SET refresh_token_hash=$1, last_seen_at=now() WHERE id=$2',
      [sha256(refresh), deviceId]);
    return { access, refresh: `${deviceId}.${refresh}`, expires_in: 900 };
  }

  /** Rotation with reuse detection: a stale refresh kills the device session. */
  async refresh(token: string) {
    const [deviceId, secret] = token.split('.');
    if (!deviceId || !secret) throw new Problem(HttpStatus.UNAUTHORIZED, 'REFRESH_INVALID', 'Malformed token');
    const dev = await this.db.one<{ id: string; user_id: string; refresh_token_hash: string | null }>(
      'SELECT id, user_id, refresh_token_hash FROM devices WHERE id=$1', [deviceId]);
    if (!dev?.refresh_token_hash) throw new Problem(HttpStatus.UNAUTHORIZED, 'REFRESH_INVALID', 'Unknown session');
    if (dev.refresh_token_hash !== sha256(secret)) {
      await this.db.query('UPDATE devices SET refresh_token_hash=NULL WHERE id=$1', [deviceId]);
      throw new Problem(HttpStatus.UNAUTHORIZED, 'REFRESH_REUSED', 'Session revoked');
    }
    return this.issueTokens(dev.user_id, dev.id);
  }

  async logout(deviceId: string) {
    await this.db.query('UPDATE devices SET refresh_token_hash=NULL WHERE id=$1', [deviceId]);
  }
}

function randomColor(): string {
  const palette = ['#FF3B6B', '#00E5FF', '#B4FF39', '#FFB300', '#B388FF', '#FF6E40', '#69F0AE', '#F50057'];
  return palette[randomInt(palette.length)];
}
