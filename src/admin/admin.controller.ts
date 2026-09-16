import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminService } from './admin.service';

/**
 * Operator endpoints.
 *
 * Role-gated at the controller, not per route — a read-only dashboard anyone
 * could open is a finding, not a feature, and the safe default has to be the
 * one you get by forgetting a decorator on a new endpoint.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles('admin')
@UseGuards(RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Credits in circulation, house P&L, live exposure and integrity' })
  overview() {
    return this.admin.getOverview();
  }

  @Get('users')
  @ApiOperation({ summary: 'Players with their balances' })
  users(
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('search') search?: string,
  ) {
    return this.admin.listUsers({ limit, offset, search });
  }

  @Get('distribution')
  @ApiOperation({ summary: 'How credits are spread across players' })
  distribution() {
    return this.admin.getBalanceDistribution();
  }
}
