import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { MailerService } from './mailer.service.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, MailerService, SessionGuard, CsrfGuard],
  exports: [MailerService, SessionGuard, CsrfGuard],
})
export class AuthModule {}

