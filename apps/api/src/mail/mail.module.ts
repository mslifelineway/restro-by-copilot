import { Global, Module } from '@nestjs/common';
import { DevMailController } from './mail.controller';
import { MailService } from './mail.service';

@Global()
@Module({ controllers: [DevMailController], providers: [MailService], exports: [MailService] })
export class MailModule {}
