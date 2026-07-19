import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ActivitiesModule } from './activities/activities.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { TerritoryModule } from './territory/territory.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SocialModule } from './social/social.module';
import { ClientController } from './common/client.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DbModule, RedisModule, AuthModule, UsersModule,
    ActivitiesModule, PipelineModule, TerritoryModule, RealtimeModule, SocialModule,
  ],
  controllers: [ClientController],
})
export class AppModule {}
