import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || "https://icefishing.business";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Запускай тетрис 👇",
    Markup.inlineKeyboard([
      Markup.button.webApp("🎮 Открыть игру", WEBAPP_URL),
    ])
  );
});

bot.command("help", (ctx) => ctx.reply("Напиши /start чтобы открыть игру."));
bot.on("text", (ctx) => ctx.reply("Напиши /start 🙂"));

bot.launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
