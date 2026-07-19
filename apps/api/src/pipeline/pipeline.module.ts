import { Module } from '@nestjs/common';
import { ingestQueueProvider } from './queues';
import { IngestProcessor } from './ingest.processor';
import { DecaySweep } from './decay.sweep';
import { RealtimeModule } from '../realtime/realtime.module';
import { StreamStore } from '../activities/streams.store';

@Module({
  imports: [RealtimeModule],
  providers: [ingestQueueProvider, IngestProcessor, DecaySweep, StreamStore],
  exports: [ingestQueueProvider],
})
export class PipelineModule {}
