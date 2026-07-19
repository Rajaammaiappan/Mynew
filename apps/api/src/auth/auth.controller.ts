import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { JwtGuard, AuthedRequest } from './jwt.guard';
import { parse } from '../common/zod';

const OtpRequest = z.object({ phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/) });
const OtpVerify = OtpRequest.extend({
  code: z.string().length(6),
  device: z.object({ platform: z.enum(['ios', 'android', 'dev']), model: z.string().optional() }),
});
const Refresh = z.object({ refresh: z.string().min(10) });

@Controller('v1/auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('otp/request') @HttpCode(200)
  async otpRequest(@Body() body: unknown) {
    const r = await this.auth.requestOtp(parse(OtpRequest, body).phone_e164);
    return { sent: true, ...r };
  }

  @Post('otp/verify') @HttpCode(200)
  otpVerify(@Body() body: unknown) {
    const b = parse(OtpVerify, body);
    return this.auth.verifyOtp(b.phone_e164, b.code, b.device);
  }

  @Post('refresh') @HttpCode(200)
  refresh(@Body() body: unknown) {
    return this.auth.refresh(parse(Refresh, body).refresh);
  }

  @Post('logout') @HttpCode(204) @UseGuards(JwtGuard)
  async logout(@Req() req: AuthedRequest) {
    await this.auth.logout(req.auth!.dev);
  }
}
