import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { CONFIG } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  await app.listen(CONFIG.port);
  console.log(`runverse api on :${CONFIG.port} (env ${CONFIG.nodeEnv})`);
}
bootstrap();
