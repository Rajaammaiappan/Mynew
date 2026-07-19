import { Module } from '@nestjs/common';
import { TerritoryController } from './territory.controller';
import { TerritoryService } from './territory.service';

@Module({ controllers: [TerritoryController], providers: [TerritoryService] })
export class TerritoryModule {}
