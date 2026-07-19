import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtGuard } from './jwt.guard';
import { CONFIG } from '../config';

@Global()
@Module({
  imports: [JwtModule.register({ secret: CONFIG.jwtSecret, signOptions: { expiresIn: CONFIG.jwtAccessTtl } })],
  controllers: [AuthController],
  providers: [AuthService, JwtGuard],
  exports: [AuthService, JwtGuard, JwtModule],
})
export class AuthModule {}
