/**
 * Pi-Browser Telegram Bot
 * 텔레그램에서 명령을 받아 브라우저 작업 실행
 */

import { Bot, Context } from "grammy";

export interface TelegramBotConfig {
  token: string;
  allowedUsers?: number[]; // 허용된 사용자 ID 목록
  onMessage: (text: string, ctx: MessageContext) => Promise<string>;
}

export interface MessageContext {
  chatId: number;
  userId: number;
  username?: string;
  replyTo: (text: string) => Promise<void>;
}

let bot: Bot | null = null;

export async function startTelegramBot(config: TelegramBotConfig): Promise<Bot> {
  const { token, allowedUsers, onMessage } = config;

  bot = new Bot(token);

  // 에러 핸들러
  bot.catch((err) => {
    console.error("[Telegram] 에러:", err.message);
  });

  // 메시지 핸들러
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const username = ctx.from?.username;

    // 허용된 사용자 체크 (비어있으면 아무도 허용 안함)
    if (!allowedUsers || allowedUsers.length === 0) {
      await ctx.reply(
        `⛔ <b>허용된 사용자가 설정되지 않았습니다</b>\n\n` +
        `📋 <b>당신의 ID:</b>\n<code>${userId}</code>\n\n` +
        `👆 위 숫자를 복사해서 웹 설정에 추가하세요\n` +
        `(설정 → 텔레그램 봇 → 허용된 사용자 ID)`,
        { parse_mode: "HTML" }
      );
      return;
    }
    if (!userId || !allowedUsers.includes(userId)) {
      await ctx.reply(
        `⛔ <b>권한이 없습니다</b>\n\n` +
        `📋 <b>당신의 ID:</b>\n<code>${userId}</code>\n\n` +
        `관리자에게 위 ID를 전달하세요.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    console.log(`[Telegram] 메시지: ${text} (from: ${username || userId})`);

    const messageCtx: MessageContext = {
      chatId,
      userId: userId!,
      username,
      replyTo: async (reply: string) => {
        await ctx.reply(reply, { parse_mode: "HTML" });
      },
    };

    try {
      const response = await onMessage(text, messageCtx);
      if (response) {
        await ctx.reply(response, { parse_mode: "HTML" });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ 에러: ${errMsg}`);
    }
  });

  // 시작
  console.log("[Telegram] 봇 시작 중...");
  bot.start({
    onStart: (botInfo) => {
      console.log(`[Telegram] 봇 시작됨: @${botInfo.username}`);
    },
  });

  return bot;
}

export function stopTelegramBot(): void {
  if (bot) {
    bot.stop();
    bot = null;
    console.log("[Telegram] 봇 종료됨");
  }
}

// 메시지 전송 헬퍼
export async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  text: string
): Promise<void> {
  const tempBot = new Bot(token);
  await tempBot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
}
