import { describe, it, expect, beforeEach } from "vitest";
import { buildChannelContext, markHandled } from "./channel-context.js";

const SELF_ID = "self-bot";
const CHANNEL_ID = "chan-1";

interface FakeMessage {
  id: string;
  authorId: string;
  name: string;
  bot?: boolean;
  content: string;
  ts: number;
  system?: boolean;
}

let fetchCalls: { after?: string; limit?: number }[] = [];

function toDiscordLike(m: FakeMessage) {
  return {
    id: m.id,
    author: { id: m.authorId, username: m.name, bot: m.bot ?? false },
    member: { displayName: m.name },
    content: m.content,
    createdTimestamp: m.ts,
    system: m.system ?? false,
  };
}

function makeTrigger(history: FakeMessage[], trigger: FakeMessage) {
  const all = [...history, trigger];
  return {
    ...toDiscordLike(trigger),
    client: { user: { id: SELF_ID } },
    channel: {
      id: CHANNEL_ID,
      messages: {
        fetch: async (opts: { after?: string; limit?: number }) => {
          fetchCalls.push(opts);
          const source = opts.after
            ? all.filter((m) => Number(m.id.replace(/\D/g, "")) > Number(opts.after!.replace(/\D/g, "")))
            : all.slice(-(opts.limit ?? 30));
          // Discord does not guarantee chronological order
          const shuffled = [...source].reverse().map(toDiscordLike);
          return new Map(shuffled.map((m) => [m.id, m]));
        },
      },
    },
  } as any;
}

beforeEach(() => {
  fetchCalls = [];
  markHandled(CHANNEL_ID, ""); // empty id is falsy, so the next build starts from a cold window
});

describe("buildChannelContext", () => {
  it("returns humans and other bots in chronological order", async () => {
    const msg = makeTrigger(
      [
        { id: "m3", authorId: "u2", name: "Jacek", content: "zgoda", ts: 300 },
        { id: "m1", authorId: "u1", name: "Domin", content: "robimy auth", ts: 100 },
        { id: "m2", authorId: "other-bot", name: "ClaudeJacek", bot: true, content: "sugeruję OAuth", ts: 200 },
      ],
      { id: "m4", authorId: "u1", name: "Domin", content: "@bot zrób to", ts: 400 },
    );

    const context = await buildChannelContext(msg);

    expect(context).toBe(
      "Domin: robimy auth\nClaudeJacek (bot): sugeruję OAuth\nJacek: zgoda",
    );
  });

  it("excludes the triggering message and its own past output", async () => {
    const msg = makeTrigger(
      [
        { id: "m1", authorId: SELF_ID, name: "ClaudeDomin", bot: true, content: "moja stara odpowiedź", ts: 100 },
        { id: "m2", authorId: "u1", name: "Domin", content: "ok", ts: 200 },
      ],
      { id: "m3", authorId: "u1", name: "Domin", content: "trigger", ts: 300 },
    );

    const context = await buildChannelContext(msg);

    expect(context).toBe("Domin: ok");
    expect(context).not.toContain("trigger");
  });

  it("skips empty and system messages", async () => {
    const msg = makeTrigger(
      [
        { id: "m1", authorId: "u1", name: "Domin", content: "   ", ts: 100 },
        { id: "m2", authorId: "u1", name: "Domin", content: "dołączył", ts: 150, system: true },
        { id: "m3", authorId: "u1", name: "Domin", content: "realna treść", ts: 200 },
      ],
      { id: "m4", authorId: "u1", name: "Domin", content: "trigger", ts: 300 },
    );

    expect(await buildChannelContext(msg)).toBe("Domin: realna treść");
  });

  it("truncates an overlong single message", async () => {
    const msg = makeTrigger(
      [{ id: "m1", authorId: "u1", name: "Domin", content: "x".repeat(2000), ts: 100 }],
      { id: "m2", authorId: "u1", name: "Domin", content: "trigger", ts: 200 },
    );

    const context = await buildChannelContext(msg);

    expect(context.endsWith("…")).toBe(true);
    expect(context.length).toBeLessThan(1000);
  });

  it("drops the oldest lines when the transcript exceeds the total cap", async () => {
    const history: FakeMessage[] = [];
    for (let i = 1; i <= 20; i++) {
      history.push({ id: `m${i}`, authorId: "u1", name: "Domin", content: `${i}-${"y".repeat(700)}`, ts: i * 10 });
    }
    const msg = makeTrigger(history, { id: "m99", authorId: "u1", name: "Domin", content: "trigger", ts: 9999 });

    const context = await buildChannelContext(msg);

    expect(context.length).toBeLessThanOrEqual(6000);
    expect(context).toContain("Domin: 20-");
    expect(context).not.toContain("Domin: 1-");
  });

  it("fetches only messages after the last handled one", async () => {
    const history: FakeMessage[] = [
      { id: "m1", authorId: "u1", name: "Domin", content: "stare", ts: 100 },
      { id: "m2", authorId: "u1", name: "Domin", content: "nowe", ts: 200 },
    ];
    markHandled(CHANNEL_ID, "m1");

    const msg = makeTrigger(history, { id: "m3", authorId: "u1", name: "Domin", content: "trigger", ts: 300 });
    const context = await buildChannelContext(msg);

    expect(fetchCalls[0]).toEqual({ after: "m1", limit: 100 });
    expect(context).toBe("Domin: nowe");
  });
});
