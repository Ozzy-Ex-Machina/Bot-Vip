require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();
const bot = new Telegraf((process.env.BOT_TOKEN || '').trim());
const app = express();
app.use(express.json());

const REWARD_DAYS = parseInt((process.env.REWARD_DAYS || '7').trim());
const ADMIN_ID = (process.env.ADMIN_ID || '').trim(); // Pegando o ID do dono sem espaços

const adminState = {}; // Memória temporária para o painel de admin

// Busca a configuração ou cria uma padrão
async function getConfig() {
  let config = await prisma.config.findUnique({ where: { id: 'default' } });
  if (!config) {
    config = await prisma.config.create({ data: { id: 'default' } });
  }
  return config;
}

// Menu principal estático
const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      [{ text: '💎 Ver Planos' }, { text: '🔗 Painel de Afiliado' }],
      [{ text: '👤 Minha Assinatura' }]
    ],
    resize_keyboard: true
  }
};

// --- BOT HANDLERS ---

bot.start(async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || 'Usuário';
  
  const payload = ctx.payload; 
  let referredBy = null;

  if (payload && payload.startsWith('ref_')) {
    const refCode = payload;
    if (refCode !== `ref_${telegramId}`) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: refCode }});
      if (referrer) referredBy = referrer.telegramId;
    }
  }

  let user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        username,
        profileName: ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : ''),
        referralCode: `ref_${telegramId}_${uuidv4().substring(0, 5)}`,
        referredBy
      }
    });
  } else if (referredBy && user.referredBy !== referredBy) {
    user = await prisma.user.update({
      where: { telegramId },
      data: { referredBy }
    });
  }

  const config = await getConfig();
  const welcomeMessage = config.welcomeText.replace(/{nome}/g, username);
  
  if (config.welcomeMediaId) {
    try {
      if (config.welcomeMediaType === 'photo') {
        await ctx.replyWithPhoto(config.welcomeMediaId, { caption: welcomeMessage, parse_mode: 'HTML', ...MAIN_MENU });
      } else if (config.welcomeMediaType === 'video') {
        await ctx.replyWithVideo(config.welcomeMediaId, { caption: welcomeMessage, parse_mode: 'HTML', ...MAIN_MENU });
      }
    } catch (e) {
      // Fallback em caso de erro na mídia
      await ctx.reply(welcomeMessage, { parse_mode: 'HTML', ...MAIN_MENU });
    }
  } else {
    await ctx.reply(welcomeMessage, { parse_mode: 'HTML', ...MAIN_MENU });
  }
});

bot.hears('💎 Ver Planos', async (ctx) => {
  const config = await getConfig();
  const buttons = [];
  
  if (config.monthlyActive) {
    buttons.push([{ text: `Mensal - R$ ${config.monthlyPrice.toFixed(2).replace('.', ',')}`, callback_data: 'buy_monthly' }]);
  }
  if (config.quarterlyActive) {
    buttons.push([{ text: `Trimestral - R$ ${config.quarterlyPrice.toFixed(2).replace('.', ',')}`, callback_data: 'buy_quarterly' }]);
  }
  if (config.lifetimeActive) {
    buttons.push([{ text: `Vitalício - R$ ${config.lifetimePrice.toFixed(2).replace('.', ',')}`, callback_data: 'buy_lifetime' }]);
  }

  if (buttons.length === 0) {
    return ctx.reply('Nenhum plano disponível no momento.', MAIN_MENU);
  }

  ctx.reply('Escolha o plano que mais combina com você:', {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.hears('👤 Minha Assinatura', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const sub = await prisma.subscription.findFirst({
    where: { userId: telegramId, status: 'ACTIVE' },
    orderBy: { expiresAt: 'desc' }
  });

  if (!sub) {
    return ctx.reply('❌ Você não possui uma assinatura ativa no momento.\n\nClique em "💎 Ver Planos" para assinar.');
  }

  const diff = sub.expiresAt.getTime() - Date.now();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  ctx.reply(`✅ <b>Sua Assinatura VIP</b>\n\nStatus: <b>Ativa</b>\nVálida até: ${sub.expiresAt.toLocaleDateString('pt-BR')}\nRestam: ${days} dias`, { parse_mode: 'HTML' });
});

bot.hears('🔗 Painel de Afiliado', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const user = await prisma.user.findUnique({ where: { telegramId } });
  
  if (user) {
    const referralsPayments = await prisma.payment.findMany({
      where: { user: { referredBy: telegramId }, status: 'PAID' },
      include: { user: true },
      orderBy: { createdAt: 'desc' }
    });

    const uniqueReferrals = [];
    const seen = new Set();
    for (const p of referralsPayments) {
      if (!seen.has(p.userId)) {
        seen.add(p.userId);
        uniqueReferrals.push(p);
      }
    }

    let listTxt = '';
    if (uniqueReferrals.length > 0) {
      listTxt = '\n\n<b>👥 Seus Afiliados Ativos:</b>\n';
      uniqueReferrals.forEach((p, idx) => {
        const name = p.user.profileName || p.user.username || 'User';
        const masked = name.charAt(0) + '***' + (name.length > 3 ? name.slice(-1) : '');
        listTxt += `${idx + 1}. ${masked} - Assinou em ${p.createdAt.toLocaleDateString('pt-BR')}\n`;
      });
    }

    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
    ctx.reply(`<b>🔥 Programa de Afiliados VIP</b>\n\nConvide pessoas usando o seu link exclusivo e ganhe recompensas incríveis a cada novo assinante que entrar através de você!\n\n<b>1 Indicação:</b> Ganhe +15 dias grátis na sua assinatura atual.\n<b>2 Indicações:</b> Se você não for assinante, ganha 1 MÊS GRÁTIS de acesso total!\n<b>3 Indicações:</b> Desbloqueia um prêmio exclusivo: um vídeo personalizado de 8 minutos!\n\nSeu link de indicação é:\n${link}${listTxt}`, { parse_mode: 'HTML', disable_web_page_preview: true });
  } else {
    ctx.reply('Por favor, envie /start primeiro para registrar sua conta.');
  }
});

// Ações de botões (Compra)
const PLANS = {
  'buy_monthly': { field: 'monthlyPrice', days: 30, name: 'Mensal' },
  'buy_quarterly': { field: 'quarterlyPrice', days: 90, name: 'Trimestral' },
  'buy_lifetime': { field: 'lifetimePrice', days: 99999, name: 'Vitalício' }
};

bot.action(/buy_(monthly|quarterly|lifetime)/, async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from.id.toString();
  const planKey = ctx.match[0];
  const planInfo = PLANS[planKey];
  
  const config = await getConfig();
  const price = config[planInfo.field];
  const valorCentavos = Math.round(price * 100); 
  
  await ctx.reply(`Gerando seu PIX para o plano ${planInfo.name}... aguarde um momento ⏳`);

  try {
    const response = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', {
      value: valorCentavos
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PUSHINPAY_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    const pixData = response.data;
    const qrCode = pixData.qr_code;
    const txId = pixData.id;

    await prisma.payment.create({
      data: {
        userId: telegramId,
        gatewayTxId: txId,
        amount: price,
        status: 'PENDING',
        qrCode: qrCode,
        planDays: planInfo.days
      }
    });

    await ctx.reply(`Aqui está seu PIX Copia e Cola no valor de R$ ${price.toFixed(2).replace('.', ',')}.\n\n\`${qrCode}\`\n\nBasta copiar o texto acima e colar no seu banco. O acesso será liberado aqui automaticamente após o pagamento!`, { parse_mode: 'HTML' });

  } catch (error) {
    console.error('Erro PushinPay:', error?.response?.data || error.message);
    await ctx.reply('Desculpe, ocorreu um erro ao gerar o pagamento. Tente novamente ou contate o suporte.');
  }
});

// --- PAINEL DE ADMINISTRAÇÃO ---

async function sendAdminPanel(ctx) {
  const config = await getConfig();
  
  const keyboard = [
    [
      { text: `💰 Mensal: R$ ${config.monthlyPrice}`, callback_data: 'admin_edit_monthly' },
      { text: config.monthlyActive ? '✅ Ativo' : '❌ Inativo', callback_data: 'admin_toggle_monthly' }
    ],
    [
      { text: `💰 Trimestral: R$ ${config.quarterlyPrice}`, callback_data: 'admin_edit_quarterly' },
      { text: config.quarterlyActive ? '✅ Ativo' : '❌ Inativo', callback_data: 'admin_toggle_quarterly' }
    ],
    [
      { text: `💰 Vitalício: R$ ${config.lifetimePrice}`, callback_data: 'admin_edit_lifetime' },
      { text: config.lifetimeActive ? '✅ Ativo' : '❌ Inativo', callback_data: 'admin_toggle_lifetime' }
    ],
    [{ text: '📝 Editar Boas Vindas', callback_data: 'admin_edit_welcome' }],
    [{ text: '📢 Mandar Anúncio', callback_data: 'admin_broadcast' }],
    [{ text: '📊 Estatísticas', callback_data: 'admin_stats' }]
  ];

  const msg = '🛠 <b>Painel de Administração</b>\nAqui você gerencia seus planos, envia mídias e anúncios.';
  
  if (ctx.callbackQuery) {
    await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  } else {
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  }
}

bot.command('admin', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  await sendAdminPanel(ctx);
});

bot.command('setlog', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const chatId = ctx.chat.id.toString();
  await prisma.config.update({ where: { id: 'default' }, data: { logGroupId: chatId } });
  ctx.reply(`✅ <b>Grupo de Logs Configurado!</b>\n\nA partir de agora, todas as notificações de novas assinaturas e prêmios de afiliados serão enviadas para este chat.`, { parse_mode: 'HTML' });
});

// Toggles de planos
bot.action(/admin_toggle_(monthly|quarterly|lifetime)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const plan = ctx.match[1];
  const field = `${plan}Active`;
  const config = await getConfig();
  await prisma.config.update({ where: { id: 'default' }, data: { [field]: !config[field] } });
  await sendAdminPanel(ctx);
});

// Edição de Preços
bot.action(/admin_edit_(monthly|quarterly|lifetime)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const plan = ctx.match[1];
  adminState[ADMIN_ID] = `WAITING_PRICE_${plan.toUpperCase()}`;
  ctx.reply(`Digite o novo preço para o plano ${plan} (ex: 45.90):`);
  ctx.answerCbQuery();
});

// Edição de Boas Vindas
bot.action('admin_edit_welcome', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  adminState[ADMIN_ID] = 'WAITING_WELCOME';
  ctx.reply('Para definir as boas vindas, você pode me enviar um Texto Simples, ou enviar uma <b>Foto/Vídeo com a legenda que deseja salvar</b>.\n\n(Você pode usar {nome} no texto para citar o cliente).', { parse_mode: 'HTML' });
  ctx.answerCbQuery();
});

// Anúncio
bot.action('admin_broadcast', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  adminState[ADMIN_ID] = 'WAITING_BROADCAST';
  ctx.reply('Me envie a mensagem que deseja disparar para todos. Pode ser Texto, Foto, Vídeo ou Áudio. O bot enviará uma cópia idêntica a todos os clientes.');
  ctx.answerCbQuery();
});

// Estatísticas
bot.action('admin_stats', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const usersCount = await prisma.user.count();
  const activeSubs = await prisma.subscription.count({ where: { status: 'ACTIVE' } });
  
  await ctx.reply(`📊 <b>Estatísticas do Bot</b>\n\n👥 Total de Usuários: ${usersCount}\n✅ Assinaturas Ativas: ${activeSubs}\n\n⏳ Gerando relatório completo em arquivo...`, { parse_mode: 'HTML' });
  ctx.answerCbQuery();

  const allUsers = await prisma.user.findMany({
    include: { subscriptions: { where: { status: 'ACTIVE' } } }
  });

  let report = '=== RELATÓRIO COMPLETO DE USUÁRIOS ===\n\n';
  for (const u of allUsers) {
    const isVIP = u.subscriptions.length > 0 ? 'SIM' : 'NÃO';
    const usernameStr = u.username ? `@${u.username}` : 'Sem @username';
    const profileStr = u.profileName ? u.profileName : 'Sem Nome';
    let line = `ID: ${u.telegramId} | Nome: ${profileStr} | User: ${usernameStr} | VIP: ${isVIP}`;
    if (u.referredBy) {
      line += ` | Indicado por: ${u.referredBy}`;
    }
    report += line + '\n';
  }

  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, 'relatorio_usuarios.txt');
  fs.writeFileSync(filePath, report);

  await ctx.replyWithDocument({ source: filePath, filename: 'relatorio_usuarios.txt' });
});

// Listener Global para capturar os inputs do admin
bot.on('message', async (ctx, next) => {
  const telegramId = ctx.from.id.toString();
  
  if (telegramId === ADMIN_ID && adminState[ADMIN_ID]) {
    const state = adminState[ADMIN_ID];

    // Verifica se estamos esperando preço
    if (state.startsWith('WAITING_PRICE_')) {
      if (!ctx.message.text) return ctx.reply('Envie apenas texto numérico!');
      const plan = state.split('_')[2].toLowerCase();
      const newPrice = parseFloat(ctx.message.text.replace(',', '.'));
      if (isNaN(newPrice)) return ctx.reply('Preço inválido. Digite apenas números, ex: 30.50');
      
      const field = `${plan}Price`;
      await prisma.config.update({ where: { id: 'default' }, data: { [field]: newPrice } });
      ctx.reply(`✅ Preço do plano atualizado com sucesso!`);
      delete adminState[ADMIN_ID];
      return sendAdminPanel(ctx);
    }
    
    // Verifica se estamos esperando boas vindas (texto ou mídia)
    if (state === 'WAITING_WELCOME') {
      let text = ctx.message.text || ctx.message.caption || '';
      let mediaId = null;
      let mediaType = null;
      
      if (ctx.message.photo) {
        mediaId = ctx.message.photo[ctx.message.photo.length - 1].file_id; // Pega a maior resolução
        mediaType = 'photo';
      } else if (ctx.message.video) {
        mediaId = ctx.message.video.file_id;
        mediaType = 'video';
      }
      
      await prisma.config.update({ 
        where: { id: 'default' }, 
        data: { welcomeText: text || 'Bem-vindo!', welcomeMediaId: mediaId, welcomeMediaType: mediaType } 
      });
      
      ctx.reply('✅ Mensagem de boas-vindas e mídia salva com sucesso!');
      delete adminState[ADMIN_ID];
      return sendAdminPanel(ctx);
    }
    
    // Verifica se estamos esperando anúncio (usa copyMessage para mandar igual)
    if (state === 'WAITING_BROADCAST') {
      ctx.reply('Iniciando o disparo do anúncio... ⏳');
      const users = await prisma.user.findMany();
      let sent = 0;
      for (const user of users) {
        try {
          await ctx.copyMessage(user.telegramId); // Copia qualquer tipo de mensagem recebida
          sent++;
        } catch(e) {}
      }
      ctx.reply(`✅ Anúncio enviado com sucesso para ${sent} usuários!`);
      delete adminState[ADMIN_ID];
      return;
    }
  }
  
  return next();
});

// --- SERVIDOR WEBHOOK E PING ---

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.post('/webhook/pushinpay', async (req, res) => {
  try {
    res.status(200).send('OK');
    const { id, status } = req.body; 
    
    if (status !== 'paid' && status !== 'approved') return;

    const payment = await prisma.payment.findFirst({
      where: { gatewayTxId: id, status: 'PENDING' },
      include: { user: true }
    });

    if (!payment) return; 

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'PAID' }
    });

    const userId = payment.userId;

    const expirationDate = new Date();
    // Se for 99999, é vitalício (quase eterno)
    expirationDate.setDate(expirationDate.getDate() + payment.planDays);

    await prisma.subscription.create({
      data: {
        userId: userId,
        status: 'ACTIVE',
        expiresAt: expirationDate
      }
    });

    const user = payment.user;
    const config = await getConfig();
    const logTarget = config.logGroupId || ADMIN_ID;
    
    const userName = user.profileName || 'Sem Nome';
    const userHandle = user.username ? `@${user.username}` : 'Sem @username';
    const planValue = payment.amount.toFixed(2).replace('.', ',');
    
    await bot.telegram.sendMessage(logTarget, `💰 <b>NOVA VENDA REALIZADA!</b>\n\n👤 Cliente: <b>${userName}</b> (${userHandle} / ID: ${userId})\n💵 Valor: R$ ${planValue}\n⏳ Plano: ${payment.planDays} dias`, { parse_mode: 'HTML' }).catch(() => {});

    const groupId = process.env.GROUP_ID;
    if (groupId && groupId !== 'ID_DO_GRUPO') {
      const inviteLink = await bot.telegram.createChatInviteLink(groupId, {
        member_limit: 1, 
        expire_date: Math.floor(Date.now() / 1000) + (60 * 60 * 24) 
      });

      await bot.telegram.sendMessage(userId, `🎉 <b>Pagamento Confirmado!</b>\n\nAqui está o seu link de acesso exclusivo: ${inviteLink.invite_link}\n\nEntre logo, pois este link é de uso único e expira em 24h!`, { parse_mode: 'HTML' });
    } else {
      await bot.telegram.sendMessage(userId, `🎉 Pagamento Confirmado! Porém o ID do grupo VIP não está configurado. Fale com o dono.`);
    }

    if (user.referredBy) {
      const referrerId = user.referredBy;
      
      const paidReferralsCount = await prisma.payment.count({
        where: { 
          user: { referredBy: referrerId },
          status: 'PAID'
        }
      });

      const referrerSub = await prisma.subscription.findFirst({
        where: { userId: referrerId, status: 'ACTIVE' },
        orderBy: { expiresAt: 'desc' }
      });

      if (referrerSub) {
        // Já é assinante, ganha 15 dias.
        const newExpiresAt = new Date(referrerSub.expiresAt);
        newExpiresAt.setDate(newExpiresAt.getDate() + 15);
        await prisma.subscription.update({
          where: { id: referrerSub.id },
          data: { expiresAt: newExpiresAt }
        });
        await bot.telegram.sendMessage(referrerId, `🤑 <b>Você ganhou +15 dias grátis!</b>\nAlguém assinou usando seu link de afiliado. Sua assinatura agora vai até ${newExpiresAt.toLocaleDateString('pt-BR')}.`, { parse_mode: 'HTML' });
      } else {
        // Não é assinante, checa se bateu 2 indicações pra ganhar 30 dias
        if (paidReferralsCount >= 2) {
          const expirationDate = new Date();
          expirationDate.setDate(expirationDate.getDate() + 30);
          await prisma.subscription.create({
            data: {
              userId: referrerId,
              status: 'ACTIVE',
              expiresAt: expirationDate
            }
          });
          
          let inviteLinkText = 'Peça seu link ao administrador.';
          if (groupId && groupId !== 'ID_DO_GRUPO') {
            const inviteLink = await bot.telegram.createChatInviteLink(groupId, {
              member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + (60 * 60 * 24) 
            });
            inviteLinkText = inviteLink.invite_link;
          }

          await bot.telegram.sendMessage(referrerId, `🎉 <b>Parabéns! Você indicou 2 pessoas!</b>\nVocê ganhou 1 MÊS GRÁTIS de acesso VIP sem precisar pagar nada.\n\nAqui está o seu link: ${inviteLinkText}`, { parse_mode: 'HTML' });
        }
      }

      // Regra de 3 indicações (Vídeo)
      if (paidReferralsCount === 3) {
        const referrerObj = await prisma.user.findUnique({ where: { telegramId: referrerId } });
        const refName = referrerObj?.profileName || 'Sem Nome';
        const refUser = referrerObj?.username ? `@${referrerObj.username}` : 'Sem @username';
        
        await bot.telegram.sendMessage(referrerId, `🎁 <b>PRÊMIO DESBLOQUEADO!</b>\nVocê trouxe 3 assinantes e ganhou o direito a um vídeo personalizado de 8 minutos!\nO administrador entrará em contato com você em breve.`, { parse_mode: 'HTML' }).catch(() => {});
        await bot.telegram.sendMessage(logTarget, `🚨 <b>NOVO PRÊMIO DE AFILIADO!</b>\nO afiliado <b>${refName}</b> (${refUser} / ID: ${referrerId}) acaba de completar 3 pagamentos de indicações e tem direito a um vídeo personalizado de 8 minutos!\nEntre em contato com ele.`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Erro no Webhook:', err);
  }
});

// --- ROTINA DE VERIFICAÇÃO DE ASSINATURAS EXPIRADAS ---
const CHECK_INTERVAL = 1000 * 60 * 60; 
setInterval(async () => {
  try {
    const groupId = process.env.GROUP_ID;
    if (!groupId || groupId === 'ID_DO_GRUPO') return;

    const expiredSubs = await prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lte: new Date() }
      }
    });

    for (const sub of expiredSubs) {
      try {
        await bot.telegram.banChatMember(groupId, sub.userId);
        await bot.telegram.unbanChatMember(groupId, sub.userId);
        
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { status: 'EXPIRED' }
        });

        await bot.telegram.sendMessage(sub.userId, 'Sua assinatura VIP expirou e seu acesso ao grupo foi revogado. Renove agora clicando em "💎 Ver Planos" no menu!');
      } catch (err) {
        console.error(`Erro ao expulsar user ${sub.userId}:`, err.message);
      }
    }
  } catch (error) {
    console.error('Erro na rotina de varredura:', error);
  }
}, CHECK_INTERVAL);

bot.catch((err, ctx) => {
  console.error(`Erro no bot para ${ctx.updateType}:`, err);
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  
  if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'SEU_TOKEN_AQUI') {
    bot.launch().then(() => console.log('Bot rodando com Painel Admin Ativo!'));
  } else {
    console.log('Aviso: BOT_TOKEN não configurado no .env, o bot não foi iniciado.');
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
