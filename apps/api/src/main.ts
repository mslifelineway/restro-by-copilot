import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.setup';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(config.port);
  console.log(`RMS API listening on :${config.port}`);
}
void bootstrap();
