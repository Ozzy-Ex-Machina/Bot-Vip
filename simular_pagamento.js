const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

async function simular() {
  console.log('Procurando o último pagamento pendente...');
  
  // Busca o último pagamento gerado
  const ultimoPagamento = await prisma.payment.findFirst({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' }
  });

  if (!ultimoPagamento) {
    console.log('❌ Nenhum pagamento pendente encontrado.');
    console.log('👉 Vá no bot e gere um PIX (clique em "Ver Planos" e escolha um) antes de rodar este script.');
    process.exit(0);
  }

  console.log(`✅ Pagamento encontrado! ID da transação: ${ultimoPagamento.gatewayTxId}`);
  console.log('Simulando o recebimento do PIX pela API do PushinPay...');

  try {
    // Dispara o Webhook local do bot fingindo ser o banco confirmando
    await axios.post('http://localhost:3000/webhook/pushinpay', {
      id: ultimoPagamento.gatewayTxId,
      status: 'paid'
    });

    console.log('🎉 Simulação concluída com sucesso! Olhe o seu Telegram, o bot deve ter enviado os acessos e a recompensa.');
  } catch (err) {
    console.error('❌ Erro ao enviar a simulação:', err.message);
  }
}

simular();
