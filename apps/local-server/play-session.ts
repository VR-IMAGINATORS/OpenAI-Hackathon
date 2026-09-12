import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import { errorResponse } from '../../packages/server/http.js';

const token = () => randomBytes(32).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest();
function equal(value: unknown, expected: Buffer | undefined) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !!expected && timingSafeEqual(hash(value), expected);
}
function cookie(req: Request, name: string): string | undefined {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
}
export class PlayAccess {
  private invitation?: { value: string; digest: Buffer; expiresAt: number };
  private owner?: { digest: Buffer; expiresAt: number };
  private clearing?: Promise<void>;
  private resetFailed = false;
  private attempts = 0;
  private windowAt = 0;
  public origin?: string;
  constructor(private resetGame: () => Promise<void>, private now = Date.now) {}
  setOrigin(origin: string) { this.origin = origin; }
  issue() {
    if (!this.origin) throw new Error('PUBLIC_URL_NOT_READY');
    if (this.owner || this.clearing || this.resetFailed) throw new Error('PLAY_OCCUPIED');
    const value = token();
    this.invitation = { value, digest: hash(value), expiresAt: this.now() + 300_000 };
    return this.currentInvite();
  }
  currentInvite() {
    if (!this.origin || !this.invitation || this.invitation.expiresAt <= this.now()) return null;
    return { url: this.origin + '/#invite=' + this.invitation.value, expiresAt: this.invitation.expiresAt };
  }
  async clear() {
    if (this.clearing) return this.clearing;
    this.owner = undefined;
    this.invitation = undefined;
    this.clearing = this.resetGame();
    try { await this.clearing; this.resetFailed = false; } catch (error) { this.resetFailed = true; throw error; } finally { this.clearing = undefined; }
  }
  async expire() { if (this.owner && this.owner.expiresAt <= this.now()) await this.clear(); }
  claim: RequestHandler = async (req, res) => {
    await this.expire();
    if (this.now() - this.windowAt >= 60_000) { this.windowAt = this.now(); this.attempts = 0; }
    if (++this.attempts > 30) { errorResponse(res, 429, 'INVITE_LIMIT', '参加試行が多すぎます。少し待ってください。'); return; }
    if (this.owner || this.clearing || this.resetFailed) { errorResponse(res, 409, 'PLAY_OCCUPIED', 'すでに参加中です。元のブラウザで開くか、PCからやり直してください。'); return; }
    if (!req.body || Object.keys(req.body).length !== 1 || !equal(req.body.invite, this.invitation?.digest) || !this.invitation || this.invitation.expiresAt <= this.now()) {
      errorResponse(res, 401, 'INVITE_INVALID', '招待の期限が切れたか、使用済みです。PCからQRを再発行してください。'); return;
    }
    const value = token();
    this.owner = { digest: hash(value), expiresAt: this.now() + 900_000 };
    this.invitation = undefined;
    res.cookie('play_owner', value, { httpOnly: true, sameSite: 'strict', secure: this.origin?.startsWith('https:') ?? false, maxAge: 900_000, path: '/api/play' });
    res.json({ ok: true });
  };
  authorize: RequestHandler = async (req, res, next) => {
    await this.expire();
    if (this.clearing || !this.owner || !equal(cookie(req, 'play_owner'), this.owner.digest)) {
      errorResponse(res, 401, 'OWNER_REQUIRED', 'PCの招待QRから参加してください。期限切れの場合はQRを再発行してください。'); return;
    }
    next();
  };
}

export class AdminAccess {
  readonly initialToken = token();
  private initialDigest: Buffer | undefined = hash(this.initialToken);
  private digest?: Buffer;
  private expiresAt: number;
  constructor(private now = Date.now) { this.expiresAt = now() + 300_000; }
  claim: RequestHandler = (req, res) => {
    if (this.now() >= this.expiresAt || !equal(req.body?.token, this.initialDigest)) {
      errorResponse(res, 401, 'ADMIN_INVALID', '管理リンクが無効です。起動時のリンクから開いてください。'); return;
    }
    const value = token();
    this.initialDigest = undefined;
    this.digest = hash(value);
    this.expiresAt = this.now() + 3_600_000;
    res.cookie('play_admin', value, { httpOnly: true, sameSite: 'strict', maxAge: 3_600_000, path: '/api/admin' });
    res.json({ ok: true });
  };
  authorize: RequestHandler = (req, res, next) => {
    if (this.now() >= this.expiresAt || !equal(cookie(req, 'play_admin'), this.digest)) {
      errorResponse(res, 401, 'ADMIN_REQUIRED', '起動時に表示された管理リンクから開いてください。'); return;
    }
    next();
  };
}
export function originGuard(hosts: Set<string>, origins: Set<string>): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!hosts.has((req.get('host') ?? '').toLowerCase()) || (origin !== undefined && !origins.has(origin)) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origin)) {
      errorResponse(res, 403, 'ORIGIN_DENIED', 'この接続元からの操作は許可されていません。'); return;
    }
    next();
  };
}
