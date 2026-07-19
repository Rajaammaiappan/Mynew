import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Problem } from '../common/problem';
import { JwtClaims } from './auth.service';

export interface AuthedRequest {
  headers: Record<string, string | undefined>;
  auth?: JwtClaims;
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private jwt: JwtService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new Problem(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED', 'Missing bearer token');
    }
    try {
      req.auth = await this.jwt.verifyAsync<JwtClaims>(header.slice(7));
      return true;
    } catch {
      throw new Problem(HttpStatus.UNAUTHORIZED, 'TOKEN_INVALID', 'Expired or invalid token');
    }
  }
}
