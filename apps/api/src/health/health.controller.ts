import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators';
import { DbService } from '../db/db.service';

@Controller()
export class HealthController {
  constructor(private db: DbService) {}

  @Public() @Get('health')
  async health() {
    await this.db.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
