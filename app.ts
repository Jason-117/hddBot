import { Bot, Context, InlineKeyboard, webhookCallback } from "https://deno.land/x/grammy@v1.36.1/mod.ts";
import { Menu } from "https://deno.land/x/grammy_menu@v1.3.0/mod.ts";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN");
const ADMIN_ID = Deno.env.get("ADMIN_ID");
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN")

if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN 环境变量未设置！");
}
if (!ADMIN_ID) {
    throw new Error("ADMIN_ID 环境变量未设置！");
}

const bot = new Bot(BOT_TOKEN);
const admin_id = parseInt(ADMIN_ID);

// 初始化 Deno KV
const kv = await Deno.openKv();

// 会话活跃时间 30分钟
const active = 1800000;
// 回复等待时间 20分钟
const waitTime = 1200000;

const handleUpdate = webhookCallback(bot, "std/http");

interface ReplyContext {
    targetUserId: number;
}

// 对 "_" 进行转义
function escapeUnderscore(text: string): string {
    return text.replace(/_/g, '\\_');
}

// 主菜单
const menu = new Menu("root")
  .url("官方客服", "https://t.me/haoduoduo001").row()
  .url("官方频道", "https://t.me/haodd1688").row();

// 官方客服菜单
const services = new Menu("serviecs")
    .url("官方客服", "https://t.me/haoduoduo001").row()
    .back("返回");

menu.register(services);
bot.use(menu);

// 处理 "delete_message" 回调查询
bot.callbackQuery("delete_message", async (ctx) => {
    try {
        if (ctx.callbackQuery.message?.message_id) {
            await ctx.deleteMessage();
            await ctx.answerCallbackQuery();
        } else {
            console.error("撤回消息失败: message_id 为 undefined");
            await ctx.answerCallbackQuery({ text: "撤回失败：消息ID丢失！", show_alert: true });
        }
    } catch (error) {
        console.error("撤回消息失败:", error);
        await ctx.answerCallbackQuery({ text: "撤回消息失败！", show_alert: true });
    }
});

// 处理 管理员回复 的回调
bot.callbackQuery(/^reply:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.from?.id !== admin_id) {
        return ctx.answerCallbackQuery("非管理员");
    }
    try {
        const old = await kv.get<
            ReplyContext & { promptMsgId : number }
        >(["reply_context",admin_id]);
        if(old.value){
            try{
                await bot.api.deleteMessage(
                    admin_id,
                    old.value.promptMsgId
                );
            }catch {}
            await kv.delete(["reply_context",admin_id]);
        }
        const parts = ctx.match[0].split(':');
        const userChatId = parseInt(parts[1]);

        const replyInstruction = `回复消息：`;

        const prompt = await ctx.reply(
            replyInstruction,
            {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("取消回复", "cancel_reply")
            }
        );

        // const context: ReplyContext = { targetUserId: userChatId };
        const context : ReplyContext & { msgId : number ; promptMsgId : number } = {
            targetUserId: userChatId,
            msgId: ctx.callbackQuery.message!.message_id,
            promptMsgId : prompt.message_id
        };

        await kv.set(["reply_context", admin_id], context, { expireIn: active });

        
    } catch (error) {
        console.error("存储消息失败：", error);
        await ctx.answerCallbackQuery({ text: "回复失败", show_alert: true });
    }
});

// 取消回复按钮
bot.callbackQuery("cancel_reply", async (ctx) => {
    if (ctx.from?.id !== admin_id) return;
    try {
        const contextResult = await kv.get<ReplyContext>(["reply_context", admin_id]);
        const targetUserId = contextResult.value?.targetUserId;

        await kv.delete(["reply_context", admin_id]);
        if (targetUserId) {
            await kv.delete(["active_chat", targetUserId]);
            await kv.delete(["active",targetUserId]);
            await kv.delete(["chat_wait",targetUserId]);

            await kv.set(
                ["force_exit",targetUserId],
                true,
                { expireIn : active }
            );
        }
        await ctx.deleteMessage();
        await ctx.answerCallbackQuery("退出回复");
    } catch (error) {
        console.error("取消回复失败:", error);
        await ctx.answerCallbackQuery("取消回复失败");
    }
});

// 处理 start
bot.command("start", async (ctx) => {
    console.log("触发start");
    if (ctx.from?.id == admin_id) {
        await ctx.reply("管理员");
    } else {
        const userId = ctx.from?.id;
        const username = ctx.from?.username;
        const firstName = ctx.from?.first_name;
        const lastName = ctx.from?.last_name;

        if (userId) {
            await kv.set(["users", userId], {
                username: username,
                firstName: firstName,
                lastName: lastName,
                lastInteraction: new Date().toISOString(),
            });
        }
        await ctx.reply("双向请在聊天框发送‘客服’\n ", { reply_markup: menu });
    }
});

bot.command("exit", async (ctx) => {
    if (ctx.from?.id !== admin_id) return;

    const contextResult = await kv.get<ReplyContext>(["reply_context", admin_id]);
    const targetUserId = contextResult.value?.targetUserId;

    try {
        await kv.delete(["reply_context", admin_id]);
        if (targetUserId) {
            await kv.delete(["active_chat", targetUserId]);
        }
        await ctx.reply("已退出会话", { reply_to_message_id: ctx.message?.message_id });
    } catch (error) {
        await ctx.reply("退出会话失败", { reply_to_message_id: ctx.message?.message_id });
    }
});

// 处理其他的消息并将消息推送至管理员
bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const username = ctx.from.username;

    const messageText = ctx.message.text ? ctx.message.text.toLowerCase() : '';

    // 处理管理员消息
    if (userId == admin_id) {
        const contextResult = await kv.get< ReplyContext & { msgId : number ; promptMsgId : number ; }>(['reply_context', admin_id]);
        if (contextResult.value) {
            const { targetUserId , msgId , promptMsgId , }  = contextResult.value;
            const replyText = `${ctx.message.text}`;

            try {
                const context: ReplyContext = { targetUserId: targetUserId };
                await kv.set(["reply_text", admin_id], context, { expireIn: active });
                await kv.set(["active", targetUserId], { admin: admin_id },{expireIn : active });
                await bot.api.sendMessage(targetUserId, replyText, { parse_mode: "Markdown" });

                await kv.set(["active_chat", targetUserId], { adminId: admin_id }, { expireIn: active });
                await kv.delete(["force_exit",targetUserId]);

                await bot.api.deleteMessage(admin_id,promptMsgId).catch(console.error);

                await kv.delete(["reply_context", admin_id]);

                const sent = await ctx.reply(`已发送至用户`, { reply_to_message_id: ctx.message.message_id });

                setTimeout(async()=>{
                    try{
                        await bot.api.deleteMessage(
                            admin_id,
                            sent.message_id
                        );
                    }catch {}
                },10000);
                return;
            } catch (error) {
                console.error("发送消息失败", error);
                await kv.delete(["reply_context", admin_id]);
                await ctx.reply("回复失败");
                return;
            }
        }
    }
    
    // 处理普通用户消息
    if (userId !== admin_id) {
        const isRequest = messageText.includes("客服");
        const forceExit = await kv.get<boolean>(["force_exit",userId]);
        const activeChat = await kv.get(["active_chat", userId]);
        const isChatActive = activeChat.value !== null;
        const chatWait = await kv.get(["chat_wait", userId]);
        const isWait = chatWait.value != null;

        if(forceExit.value && !isRequest){
            await ctx.reply("如需客服帮助，请发送'客服'");
            return;
        }
        if(isRequest){
            await kv.delete(["force_exit",userId]);
        }

        const messageToAdmin = isChatActive || isRequest;

        if (!messageToAdmin && isWait) {
            await ctx.reply("消息已发送，客服正快马加鞭赶来！\n");
            return;
        }

        if (!messageToAdmin) {
            ctx.reply("如需客服帮助，请回复'客服'");
            return;
        }

        const escapedUsername = escapeUnderscore(username || '无用户名');
        const escapedUserText = escapeUnderscore(ctx.message.text || '');

        console.log("消息转发至管理");
        const userText = `新消息来自  @${escapedUsername}\n`;

        const replyKeyboard = new InlineKeyboard()
            .text("回复用户", `reply:${chatId}:${messageId}`).row()
            .url("联系用户", `https://t.me/${ctx.from.username}`);

        try {
            if (ctx.message.text) {
                const fullText = userText + escapedUserText;
                await bot.api.sendMessage(admin_id, fullText, {
                    parse_mode: "Markdown",
                    reply_markup: replyKeyboard
                });
            } else if (ctx.message.photo || ctx.message.video || ctx.message.document) {
                await bot.api.copyMessage(
                    admin_id,
                    chatId,
                    messageId,
                    {
                        caption: userText + escapedUserText,
                        parse_mode: "Markdown",
                        reply_markup: replyKeyboard
                    }
                );
            } else {
                await ctx.forwardMessage(admin_id);
                await bot.api.sendMessage(admin_id, `点击下方回复按钮进行回复`, { parse_mode: "Markdown", reply_markup: replyKeyboard });
            }
            if (!isChatActive) {
                await kv.set(['chat_wait', userId], { timestamp: Date.now() }, { expireIn: waitTime });
                await ctx.reply("消息已发送，客服正快马加鞭赶来！\n");
            }
        } catch (error) {
            console.error("发送至管理员失败", error);
            await ctx.reply("服务繁忙，请点击下方按钮联系客服或稍后重试！", { reply_markup: services });
        }
    }
});


// 处理 /users 路径
async function handleUsersRequest(req: Request): Promise<Response> {
    const authHeader = req.headers.get("Authorization");
    
    if (authHeader !== `Bearer ${ADMIN_TOKEN}`) {
        return new Response(JSON.stringify({ error: "Unauthorized: 无效的 Token" }), {
            status: 401,
            headers: { 
                "Content-Type": "application/json", 
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Authorization"
            }
        });
    }

    const users: any[] = [];
    try {
        for await (const entry of kv.list({ prefix: ["users"] })) {
            users.push(entry.value);
        }
        return new Response(JSON.stringify(users), {
            headers: { 
                "Content-Type": "application/json", 
                "Access-Control-Allow-Origin": "*" 
            }
        });
    } catch (error) {
        console.error("获取数据失败:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
    }
}

Deno.serve(async (req) => {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type"
            }
        });
    }

    if (req.method == "POST" && url.pathname.slice(1) == bot.token) {
        try { 
            return await handleUpdate(req); 
        } catch (err) { 
            console.error(err);
            return new Response("Error", { status: 500 }); 
        }
    }

    if (req.method == "GET" && url.pathname == "/users") {
        return await handleUsersRequest(req);
    }

    return new Response("Not Found", { status: 404 });
});