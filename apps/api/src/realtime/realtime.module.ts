import { Module } from '@nestjs/common';
import { Broadcaster } from './broadcaster.service';
import { TerritoryGateway } from './territory.gateway';

@Module({ providers: [Broadcaster, TerritoryGateway], exports: [Broadcaster] })
export class RealtimeModule {}
