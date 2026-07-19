import { Controller, Get, Headers, HttpStatus, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtGuard, AuthedRequest } from '../auth/jwt.guard';
import { TerritoryService } from './territory.service';
import { Problem } from '../common/problem';

@Controller('v1/territory')
@UseGuards(JwtGuard)
export class TerritoryController {
  constructor(private svc: TerritoryService) {}

  /** Viewport hexes for up to 6 res-5 cells, ETag-cached per cell-set. */
  @Get('viewport')
  async viewport(
    @Query('cells') cells: string | undefined,
    @Headers('if-none-match') inm: string | undefined,
    @Res() res: Response,
  ) {
    const list = (cells ?? '').split(',').filter(Boolean).slice(0, 6);
    if (!list.length) throw new Problem(HttpStatus.BAD_REQUEST, 'CELLS_REQUIRED', 'Pass ?cells=r5a,r5b');
    const etag = await this.svc.viewportEtag(list);
    if (inm && inm === etag) return res.status(304).end();
    const hexes = await this.svc.viewport(list);
    res.setHeader('ETag', etag).json({ hexes });
  }

  @Get('me/summary')
  summary(@Req() req: AuthedRequest) {
    return this.svc.summary(req.auth!.sub);
  }

  @Get('hex/:h3')
  hex(@Param('h3') h3: string) {
    return this.svc.hexDetail(h3);
  }
}
