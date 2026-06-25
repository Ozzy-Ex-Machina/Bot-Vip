const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function run() {
  await p.subscription.deleteMany();
  await p.payment.deleteMany();
  await p.user.deleteMany();
  console.log('Limpeza concluida!');
}

run().catch(console.error).finally(() => p.$disconnect());
