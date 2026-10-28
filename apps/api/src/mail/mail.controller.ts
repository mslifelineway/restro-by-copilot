import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { config } from '../config';
import { Public, ResponseMessage } from '../common/decorators';
import { AppException } from '../common/errors';
import { MailService } from './mail.service';

/** DEV/TEST ONLY: read emails captured by the console transport (e.g. password-reset links in Playwright). 404 in production. */
@Controller('v1/dev')
export class DevMailController {
  constructor(private mail: MailService) {}

  @Public() @Get('outbox') @ResponseMessage('Outbox fetched successfully')
  outbox(@Query('to') to?: string) {
    if (config.isProd || config.mailTransport !== 'console') throw new AppException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    return this.mail.outbox.filter((m) => !to || m.to.toLowerCase() === to.toLowerCase()).slice().reverse();
  }
}
