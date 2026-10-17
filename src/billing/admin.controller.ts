import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../auth/admin.guard.js';
import { BillingService, type AdminOverview, type Plan } from './billing.service.js';
import { UpdatePlanDto } from './dto/billing.dto.js';
import { gameCatalog } from './game-catalog.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly billing: BillingService) {}

  /** The plan as saved, plus every game that can be made premium. */
  @Get('plan')
  async plan(): Promise<{ plan: Plan; games: typeof gameCatalog; provider: string | null }> {
    return { plan: await this.billing.getPlan(), games: gameCatalog, provider: this.billing.providerName };
  }

  @Put('plan')
  async updatePlan(@Body() dto: UpdatePlanDto, @Req() req: Request & { adminEmail?: string }): Promise<{ plan: Plan }> {
    return { plan: await this.billing.updatePlan(dto, req.adminEmail ?? 'unknown') };
  }

  @Get('payments')
  payments(): Promise<AdminOverview> {
    return this.billing.adminOverview();
  }
}
