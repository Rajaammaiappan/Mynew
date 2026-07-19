import { Module } from '@nestjs/common';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { StreamStore } from './streams.store';
import { PipelineModule } from '../pipeline/pipeline.module';

@Module({
  imports: [PipelineModule],
  controllers: [ActivitiesController],
  providers: [ActivitiesService, StreamStore],
  exports: [StreamStore],
})
export class ActivitiesModule {}
