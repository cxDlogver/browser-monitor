import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { ApiConfig } from '@browser-monitor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Inject } from '@nestjs/common';

import { parseBody } from '../common/http.js';
import { API_CONFIG } from '../infrastructure/tokens.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionGuard, type AuthenticatedUser } from './session.guard.js';

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(256),
  displayName: z.string().trim().min(1).max(120),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(256) });
const tokenSchema = z.object({ token: z.string().min(16).max(512) });
const resetSchema = tokenSchema.extend({ password: z.string().min(10).max(256) });

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post('register')
  @HttpCode(202)
  async register(@Body() body: unknown): Promise<{ message: string }> {
    const input = parseBody(registerSchema, body);
    await this.auth.register(input.email, input.password, input.displayName);
    return { message: 'Verification email sent.' };
  }

  @Post('verify-email')
  @HttpCode(204)
  async verify(@Body() body: unknown): Promise<void> {
    const input = parseBody(tokenSchema, body);
    await this.auth.verifyEmail(input.token);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parseBody(loginSchema, body);
    const session = await this.auth.login(input.email, input.password);
    reply.setCookie('bm_session', session.token, {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
    return { user: session.user, csrfToken: session.user.csrfToken };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: AuthenticatedUser): { user: AuthenticatedUser; csrfToken: string } {
    return { user, csrfToken: user.csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(request.cookies?.bm_session);
    reply.clearCookie('bm_session', { path: '/' });
  }

  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body() body: unknown): Promise<{ message: string }> {
    const input = parseBody(z.object({ email: z.string().email() }), body);
    await this.auth.forgotPassword(input.email);
    return { message: 'If the account exists, a reset email has been sent.' };
  }

  @Post('reset-password')
  @HttpCode(204)
  async reset(@Body() body: unknown): Promise<void> {
    const input = parseBody(resetSchema, body);
    await this.auth.resetPassword(input.token, input.password);
  }
}

