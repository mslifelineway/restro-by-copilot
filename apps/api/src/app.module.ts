import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { SecurityModule } from './security/security.module';
import { MailModule } from './mail/mail.module';
import { DbModule } from './db/db.module';
import { EntitlementModule } from './entitlements/entitlement.module';
import { HealthController } from './health/health.controller';
import { PlatformModule } from './platform/platform.module';
import { TenantModule } from './tenant/tenant.module';

@Module({
  imports: [SecurityModule, DbModule, MailModule, AuditModule, EntitlementModule, AuthModule, PlatformModule, TenantModule],
  controllers: [HealthController],
})
export class AppModule {}
