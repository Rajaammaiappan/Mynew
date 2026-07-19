import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { JwtGuard, AuthedRequest } from '../auth/jwt.guard';
import { parse } from '../common/zod';

const PatchMe = z.object({
  display_name: z.string().min(1).max(50).optional(),
  avatar_url: z.string().url().optional(),
  units: z.enum(['metric', 'imperial']).optional(),
});
const ZoneBody = z.object({
  label: z.string().max(30).default('home'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().int().min(100).max(1500),
});

@Controller('v1')
@UseGuards(JwtGuard)
export class UsersController {
  constructor(private db: DbService) {}

  @Get('me')
  async me(@Req() req: AuthedRequest) {
    return this.db.one(
      `SELECT id, handle, display_name, avatar_url, color, units, trust_score, created_at
       FROM users WHERE id=$1`, [req.auth!.sub]);
  }

  @Patch('me')
  async patchMe(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parse(PatchMe, body);
    return this.db.one(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         avatar_url   = COALESCE($3, avatar_url),
         units        = COALESCE($4, units),
         updated_at   = now()
       WHERE id=$1 RETURNING id, handle, display_name, avatar_url, units`,
      [req.auth!.sub, b.display_name ?? null, b.avatar_url ?? null, b.units ?? null]);
  }

  @Get('me/privacy-zones')
  zones(@Req() req: AuthedRequest) {
    return this.db.query(
      `SELECT id, label, ST_Y(center::geometry) lat, ST_X(center::geometry) lng, radius_m
       FROM privacy_zones WHERE user_id=$1`, [req.auth!.sub]);
  }

  @Post('me/privacy-zones')
  async addZone(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parse(ZoneBody, body);
    return this.db.one(
      `INSERT INTO privacy_zones(user_id, label, center, radius_m)
       VALUES ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, $5)
       RETURNING id, label, radius_m`,
      [req.auth!.sub, b.label, b.lng, b.lat, b.radius_m]);
  }

  @Delete('me/privacy-zones/:id') @HttpCode(204)
  async delZone(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query('DELETE FROM privacy_zones WHERE id=$1 AND user_id=$2', [id, req.auth!.sub]);
  }

  @Get('users/:handle')
  async profile(@Param('handle') handle: string) {
    return this.db.one(
      `SELECT u.handle, u.display_name, u.avatar_url, u.color, u.created_at,
              (SELECT count(*) FROM follows f WHERE f.followee_id=u.id)::int AS followers
       FROM users u WHERE u.handle=$1 AND u.status='active'`, [handle]);
  }
}
