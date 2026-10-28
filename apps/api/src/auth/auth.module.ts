import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { config } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AudienceGuard, AuthGuard, FeatureGuard, PermissionGuard } from './guards';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { PermissionService } from './permission.service';
import { TenantStateService } from './tenant-state.service';

@Global()
@Module({
  imports: [JwtModule.register({ secret: config.jwtSecret, signOptions: { expiresIn: config.jwtAccessTtlSeconds, algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } })],
  controllers: [AuthController],
  providers: [
    AuthService, SessionService, PasswordService, PermissionService, TenantStateService,
    // Guard chain order matters: auth -> audience -> feature -> permission.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AudienceGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [PermissionService, TenantStateService, SessionService],
})
export class AuthModule {}
