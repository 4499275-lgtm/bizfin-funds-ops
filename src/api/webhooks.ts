import { createHmac } from "node:crypto";
import type { DB, IdGen } from "../core/db.js";
import { jparse, jstr, nowText } from "../core/db.js";

/**
 * API 输出：可信资金状态 / 异常事件变化通过 Webhook 推送（HMAC-SHA256 签名）。
 * 事件头：X-BFO-Event / X-BFO-Signature / X-BFO-Delivery
 * 签名：hex(hmac_sha256(secret, `${deliveryId}.${timestamp}.${body}`))
 */

export interface DispatchResult { webhookId: string; deliveryId: string; status: string; error?: string; }

export function emitEvents(db: DB, idGen: IdGen, events: Array<{ event: string; payload: unknown }>): void {
  const hooks = db.prepare(`SELECT * FROM webhooks WHERE enabled=1`).all() as any[];
  if (!hooks.length) return;
  for (const hook of hooks) {
    const subscribed = jparse<string[]>(hook.events, []);
    for (const { event, payload } of events) {
      if (!subscribed.includes("*") && !subscribed.includes(event)) continue;
      db.prepare(`INSERT INTO webhook_deliveries(id,webhook_id,event,payload,status,attempts,created_at) VALUES(?,?,?,?, 'PENDING',0,?)`)
        .run(idGen.next("WD"), hook.id, event, jstr(payload), nowText());
    }
  }
}

export async function deliverPending(db: DB, idGen: IdGen, limit = 20): Promise<DispatchResult[]> {
  const pending = db.prepare(`SELECT * FROM webhook_deliveries WHERE status='PENDING' ORDER BY created_at LIMIT ?`).all(limit) as any[];
  const results: DispatchResult[] = [];
  for (const d of pending) {
    const hook = db.prepare(`SELECT * FROM webhooks WHERE id=?`).get(d.webhook_id) as any;
    if (!hook) {
      db.prepare(`UPDATE webhook_deliveries SET status='FAILED', last_error='webhook removed' WHERE id=?`).run(d.id);
      continue;
    }
    const deliveryId = d.id;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = d.payload;
    const signature = createHmac("sha256", hook.secret).update(`${deliveryId}.${timestamp}.${body}`).digest("hex");
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bfo-event": d.event,
          "x-bfo-delivery": deliveryId,
          "x-bfo-timestamp": String(timestamp),
          "x-bfo-signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        db.prepare(`UPDATE webhook_deliveries SET status='DELIVERED', delivered_at=?, attempts=attempts+1, last_error=NULL WHERE id=?`).run(nowText(), d.id);
        results.push({ webhookId: hook.id, deliveryId, status: "DELIVERED" });
      } else {
        const err = `HTTP ${res.status}`;
        db.prepare(`UPDATE webhook_deliveries SET status='PENDING', attempts=attempts+1, last_error=? WHERE id=?`).run(err, d.id);
        results.push({ webhookId: hook.id, deliveryId, status: "RETRY", error: err });
      }
    } catch (e: any) {
      db.prepare(`UPDATE webhook_deliveries SET status='PENDING', attempts=attempts+1, last_error=? WHERE id=?`).run(String(e?.message ?? e).slice(0, 300), d.id);
      results.push({ webhookId: hook.id, deliveryId, status: "RETRY", error: String(e?.message ?? e) });
    }
  }
  // 超过 10 次投递失败的标记为 FAILED
  db.prepare(`UPDATE webhook_deliveries SET status='FAILED' WHERE status='PENDING' AND attempts>=10`).run();
  void idGen;
  return results;
}
