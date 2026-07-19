/**
 * WS gateway (raw `ws`): clients subscribe to res-5 cells for territory deltas
 * plus their own user channel for activity results. Stateless — any instance
 * serves any socket; Redis pub/sub is the spine.
 */
import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { REDIS_SUB } from '../redis/redis.module';
import { CELL_CHANNEL, USER_CHANNEL } from './broadcaster.service';
import { JwtClaims } from '../auth/auth.service';

const MAX_CELLS = 12;

interface Client { ws: WebSocket; userId: string; cells: Set<string> }

@WebSocketGateway({ path: '/rt' })
export class TerritoryGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger('rt');
  private clients = new Map<WebSocket, Client>();
  /** channel → refcount, so we psubscribe once per busy cell */
  private channelRefs = new Map<string, number>();

  constructor(private jwt: JwtService, @Inject(REDIS_SUB) private sub: Redis) {}

  afterInit() {
    this.sub.on('message', (channel: string, message: string) => {
      for (const c of this.clients.values()) {
        if (channel === USER_CHANNEL(c.userId)) c.ws.send(message);
        else if (channel.startsWith('rt:cell:') && c.cells.has(channel.slice(8))) c.ws.send(message);
      }
    });
  }

  async handleConnection(ws: WebSocket, req: { url?: string }) {
    // Attach a buffering listener synchronously: clients may send `subscribe`
    // the instant the socket opens, before async auth below completes.
    const pending: Buffer[] = [];
    const bufferEarly = (raw: Buffer) => pending.push(raw);
    ws.on('message', bufferEarly);
    try {
      const token = new URLSearchParams((req.url ?? '').split('?')[1]).get('token') ?? '';
      const claims = await this.jwt.verifyAsync<JwtClaims>(token);
      const client: Client = { ws, userId: claims.sub, cells: new Set() };
      this.clients.set(ws, client);
      await this.retain(USER_CHANNEL(claims.sub));
      ws.send(JSON.stringify({ type: 'hello', session: claims.dev }));
      ws.off('message', bufferEarly);
      ws.on('message', (raw: Buffer) => this.onMessage(client, raw));
      for (const raw of pending) await this.onMessage(client, raw);
    } catch {
      ws.off('message', bufferEarly);
      ws.close(4001, 'unauthorized');
    }
  }

  async handleDisconnect(ws: WebSocket) {
    const c = this.clients.get(ws);
    if (!c) return;
    this.clients.delete(ws);
    await this.release(USER_CHANNEL(c.userId));
    for (const cell of c.cells) await this.release(CELL_CHANNEL(cell));
  }

  private async onMessage(client: Client, raw: Buffer) {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') return void client.ws.send('{"type":"pong"}');
    if (msg.type === 'subscribe' && Array.isArray(msg.cells_r5)) {
      for (const cell of msg.cells_r5.slice(0, MAX_CELLS)) {
        if (typeof cell !== 'string' || client.cells.has(cell)) continue;
        if (client.cells.size >= MAX_CELLS) break;
        client.cells.add(cell);
        await this.retain(CELL_CHANNEL(cell));
      }
    }
    if (msg.type === 'unsubscribe' && Array.isArray(msg.cells_r5)) {
      for (const cell of msg.cells_r5) {
        if (client.cells.delete(cell)) await this.release(CELL_CHANNEL(cell));
      }
    }
  }

  private async retain(channel: string) {
    const n = (this.channelRefs.get(channel) ?? 0) + 1;
    this.channelRefs.set(channel, n);
    if (n === 1) await this.sub.subscribe(channel);
  }

  private async release(channel: string) {
    const n = (this.channelRefs.get(channel) ?? 1) - 1;
    if (n <= 0) { this.channelRefs.delete(channel); await this.sub.unsubscribe(channel).catch(() => {}); }
    else this.channelRefs.set(channel, n);
  }
}
