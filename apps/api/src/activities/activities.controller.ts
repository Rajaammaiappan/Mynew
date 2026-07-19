import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ActivitiesService } from './activities.service';
import { JwtGuard, AuthedRequest } from '../auth/jwt.guard';
import { parse } from '../common/zod';

const Start = z.object({
  type: z.enum(['run', 'walk', 'cycle', 'hike', 'trail_run', 'treadmill']),
  started_at: z.string().datetime({ offset: true }),
});
const Point = z.object({
  t: z.number().int(), lat: z.number(), lng: z.number(),
  alt: z.number().optional(), acc: z.number().optional(),
  hr: z.number().optional(), cad: z.number().optional(),
});
const Chunk = z.object({
  seq: z.number().int().min(0),
  points: z.array(Point).min(1).max(500),
  sensors: z.object({
    steps: z.number().int().optional(),
    accelVar: z.number().optional(),
    mockLocation: z.boolean().optional(),
  }).optional(),
});
const Finish = z.object({ ended_at: z.string().datetime({ offset: true }) });

@Controller('v1')
@UseGuards(JwtGuard)
export class ActivitiesController {
  constructor(private svc: ActivitiesService) {}

  @Post('activities/live/start') @HttpCode(201)
  start(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parse(Start, body);
    return this.svc.start(req.auth!.sub, b.type, b.started_at);
  }

  @Post('activities/live/:id/chunks') @HttpCode(202)
  chunk(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.appendChunk(req.auth!.sub, id, parse(Chunk, body));
  }

  @Post('activities/live/:id/finish') @HttpCode(200)
  finish(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.finish(req.auth!.sub, id, parse(Finish, body).ended_at);
  }

  @Post('activities/live/:id/abandon') @HttpCode(204)
  abandon(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.abandon(req.auth!.sub, id);
  }

  @Get('activities/:id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.get(req.auth!.sub, id);
  }

  @Get('activities/:id/captures')
  captures(@Param('id') id: string) {
    return this.svc.captures(id);
  }

  @Get('activities/:id/result')
  result(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.result(req.auth!.sub, id);
  }

  @Get('feed')
  feed(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.svc.feed(req.auth!.sub, cursor, Math.min(Number(limit ?? 20), 50));
  }
}
