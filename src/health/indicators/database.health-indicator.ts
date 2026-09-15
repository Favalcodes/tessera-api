import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly database: DatabaseService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await sql`select 1`.execute(this.database.db);
      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'database unreachable',
      });
    }
  }
}
