import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { JwtGuard, AuthedRequest } from '../auth/jwt.guard';
import { parse } from '../common/zod';

const CommentBody = z.object({ body: z.string().min(1).max(1000) });

@Controller('v1')
@UseGuards(JwtGuard)
export class SocialController {
  constructor(private db: DbService) {}

  @Post('users/:id/follow') @HttpCode(204)
  async follow(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query(
      `INSERT INTO follows(follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.auth!.sub, id]);
  }

  @Delete('users/:id/follow') @HttpCode(204)
  async unfollow(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query(`DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2`, [req.auth!.sub, id]);
  }

  @Post('activities/:id/kudos') @HttpCode(204)
  async kudos(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query(
      `INSERT INTO kudos(activity_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, req.auth!.sub]);
  }

  @Delete('activities/:id/kudos') @HttpCode(204)
  async unkudos(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query(`DELETE FROM kudos WHERE activity_id=$1 AND user_id=$2`, [id, req.auth!.sub]);
  }

  @Get('activities/:id/comments')
  comments(@Param('id') id: string, @Query('cursor') cursor?: string) {
    return this.db.query(
      `SELECT c.id, c.body, c.created_at, u.handle, u.display_name, u.avatar_url
       FROM comments c JOIN users u ON u.id=c.user_id
       WHERE c.activity_id=$1 AND c.deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR c.created_at < $2)
       ORDER BY c.created_at DESC LIMIT 30`, [id, cursor ?? null]);
  }

  @Post('activities/:id/comments') @HttpCode(201)
  comment(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(CommentBody, body);
    return this.db.one(
      `INSERT INTO comments(activity_id, user_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at`, [id, req.auth!.sub, b.body]);
  }

  @Delete('comments/:id') @HttpCode(204)
  async delComment(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.db.query(`UPDATE comments SET deleted_at=now() WHERE id=$1 AND user_id=$2`, [id, req.auth!.sub]);
  }
}
