// index.js
require('dotenv').config(); // Carrega as variáveis do .env
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const basicAuth = require('express-basic-auth');
const { Client, GatewayIntentBits, Partials, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const app = express();
const prisma = new PrismaClient();
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});
// Compatibilidade fetch no Node.js (CJS)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pasta pública (inclui/uploads)
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Certifique-se que a pasta existe
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// armazenamento de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// --- CONFIGURAÇÃO ---
let CONFIG = {
  mainChannelId: '',
  mainMessageId: '',
  deliveryChannelId: '',
  clientRoleId: '',
  guildId: '',
  reviewsChannelId: '',
  baseUrl: '', // URL base para links de upload
  isManagedExternally: false // Flag para indicar se a config é externa
};

async function loadConfig() {
  // Prioriza variáveis de ambiente (usadas no Render)
  const envMainChannelId = process.env.MAIN_CHANNEL_ID;
  const envDeliveryChannelId = process.env.DELIVERY_CHANNEL_ID;

  if (envMainChannelId && envDeliveryChannelId) {
    console.log('Carregando configurações a partir das variáveis de ambiente (Render).');
    CONFIG.mainChannelId = envMainChannelId;
    CONFIG.deliveryChannelId = envDeliveryChannelId;
    CONFIG.mainMessageId = process.env.MAIN_MESSAGE_ID || null;
    CONFIG.clientRoleId = process.env.CLIENT_ROLE_ID || null;
    CONFIG.guildId = process.env.GUILD_ID || null;
    CONFIG.reviewsChannelId = process.env.REVIEWS_CHANNEL_ID || null;
    CONFIG.baseUrl = process.env.BASE_URL || null;
    CONFIG.isManagedExternally = true;
  } else {
    // Fallback para o banco de dados (para desenvolvimento local)
    console.log('Carregando configurações a partir do banco de dados.');
    try {
      const savedConfig = await prisma.configuration.findUnique({
        where: { id: 1 },
      });
      if (savedConfig) {
        CONFIG = { ...CONFIG, ...savedConfig, isManagedExternally: false };
      } else {
        await prisma.configuration.create({ data: { id: 1 } });
        console.log('Nenhuma configuração encontrada. Criada entrada padrão no banco de dados.');
      }
    } catch (e) {
      console.error('Erro ao carregar configurações do banco de dados:', e);
    }
  }
}

async function saveConfig() {
  // Não salva no DB se a configuração for externa
  if (CONFIG.isManagedExternally) {
    console.log('Configurações gerenciadas por variáveis de ambiente. O salvamento no banco de dados foi ignorado.');
    return;
  }
  await prisma.configuration.upsert({
    where: { id: 1 },
    update: { ...CONFIG },
    create: { id: 1, ...CONFIG },
  });
}

// Estoque padrão (usado para popular o banco de dados na primeira execução)
const defaultStock = [
  { id: "TOMATRIO", name: "TOMATRIO", emoji: "🍅", quantity: 202, price: 0.50, max: 300 },
  { id: "MANGO", name: "MANGO", emoji: "🥭", quantity: 260, price: 0.70, max: 300 },
  { id: "MR_CARROT", name: "MR CARROT", emoji: "🥕", quantity: 74, price: 0.40, max: 150 },
  { id: "PLANTA", name: "PLANTA (100k ~ 500k DPS)", emoji: "🌱", quantity: 12, price: 7.50, max: 20 }
];

// Função para popular o banco de dados com o estoque padrão se estiver vazio
async function seedDatabase() {
  const itemCount = await prisma.stockItem.count();
  if (itemCount === 0) {
    console.log('Banco de dados de estoque vazio. Populando com dados padrão...');
    await prisma.stockItem.createMany({
      data: defaultStock,
    });
    console.log('Banco de dados populado.');
  }
}

// ---------- endpoints API ---------- //

// Rota de login para o painel
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const panelUser = process.env.PANEL_USER;
  const panelPass = process.env.PANEL_PASSWORD;

  if (username === panelUser && password === panelPass) {
    // Em um app real, você usaria sessões ou JWTs.
    // Por simplicidade, vamos apenas retornar sucesso.
    // O frontend irá armazenar um token simples.
    res.json({ success: true, message: 'Login bem-sucedido.' });
  } else {
    res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
  }
});

const adminRouter = express.Router();

// Middleware de autenticação para o dashboard
const dashboardAuth = basicAuth({
    users: { [process.env.PANEL_USER]: process.env.PANEL_PASSWORD },
    challenge: true,
    realm: 'Imb4T3st4pp',
});

adminRouter.get('/dashboard', dashboardAuth, async (req, res) => {
    try {
        // 1. Buscar apenas entregas confirmadas e que ainda tenham um item válido associado.
        const deliveries = await prisma.deliveryRecord.findMany({
            where: { 
                messageSent: true,
                item: { isNot: null } // Garante que o item relacionado existe
            },
            include: { item: true }
        });

        // 2. Calcular as estatísticas principais de forma segura.
        let totalRevenue = 0;
        let totalItemsSold = 0;
        const salesByDate = {};
        const productsSold = {};

        for (const d of deliveries) {
            // O 'where' na query já garante que d.item não é nulo.
            const saleValue = Number(d.item.price) * d.quantity;
            totalRevenue += saleValue;
            totalItemsSold += d.quantity;

            // Agrupar receita por data
            const date = d.timestamp.toISOString().split('T')[0];
            salesByDate[date] = (salesByDate[date] || 0) + saleValue;

            // Agrupar itens vendidos por nome
            productsSold[d.itemName] = (productsSold[d.itemName] || 0) + d.quantity;
        }

        const totalSales = deliveries.length;
        const averageTicket = totalSales > 0 ? totalRevenue / totalSales : 0;

        // 3. Formatar os dados para os gráficos.
        const salesOverTime = Object.keys(salesByDate).map(date => ({
            date: date,
            revenue: salesByDate[date]
        })).sort((a, b) => new Date(a.date) - new Date(b.date));

        const topProducts = Object.keys(productsSold).map(name => ({
            itemName: name,
            quantity: productsSold[name]
        })).sort((a, b) => b.quantity - a.quantity).slice(0, 5); // Top 5

        // 4. Renderizar a página com os dados processados.
        res.render('dashboard', { totalRevenue, totalSales, totalItemsSold, averageTicket, salesOverTime, topProducts });
    } catch (error) {
        console.error("Erro ao carregar o dashboard:", error);
        res.status(500).send("Erro ao carregar as estatísticas.");
    }
});

// Get/Save Config
adminRouter.get('/get-config', (req, res) => {
  res.json(CONFIG);
});

adminRouter.post('/save-config', async (req, res) => {
  const { mainChannelId, deliveryChannelId, mainMessageId, clientRoleId, guildId, reviewsChannelId } = req.body;
  if (mainChannelId !== undefined) CONFIG.mainChannelId = mainChannelId;
  if (deliveryChannelId !== undefined) CONFIG.deliveryChannelId = deliveryChannelId;
  if (mainMessageId !== undefined) CONFIG.mainMessageId = mainMessageId;
  if (clientRoleId !== undefined) CONFIG.clientRoleId = clientRoleId;
  if (guildId !== undefined) CONFIG.guildId = guildId; 
  if (reviewsChannelId !== undefined) CONFIG.reviewsChannelId = reviewsChannelId;
  await saveConfig();
  console.log('Configurações salvas:', CONFIG);
  res.json({ status: 'success', message: 'Configurações salvas.' });
});

// Get stock (front-end)
adminRouter.get('/get-stock', async (req, res) => {
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  res.json(stock);
});

// Add new fruit (creates entry in stock.json and returns updated list)
adminRouter.post('/add-fruit', async (req, res) => {
  const { id, name, emoji, price, quantity, max } = req.body;
  if (!id || !name) return res.status(400).json({ status: 'error', message: 'id e name obrigatórios' });

  const existingItem = await prisma.stockItem.findUnique({ where: { id: String(id).toUpperCase().replace(/\s+/g, '_') } });
  if (existingItem) {
    return res.status(400).json({ status: 'error', message: 'ID já existe' });
  }

  const newItemData = {
    id: String(id).toUpperCase().replace(/\s+/g, '_'),
    name: name.toUpperCase(),
    emoji: emoji || '',
    price: Number(price) || 0,
    quantity: Number(quantity) || 0,
    max: Number(max) || (Number(quantity) || 100)
  };

  const item = await prisma.stockItem.create({ data: newItemData });
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  return res.json({ status: 'success', stock, item });
});

// Update stock/prices (from panel)
adminRouter.post('/update-stock', async (req, res) => {
  try {
    const newStockData = req.body; // keys like TOMATRIO_quantity, TOMATRIO_price
    const currentStock = await prisma.stockItem.findMany({ select: { id: true } });

    const updateOperations = currentStock
      .map(item => {
        const quantityKey = `${item.id}_quantity`;
        const priceKey = `${item.id}_price`;
        const dataToUpdate = {};

        if (newStockData[quantityKey] !== undefined) {
          dataToUpdate.quantity = parseInt(newStockData[quantityKey], 10);
        }
        if (newStockData[priceKey] !== undefined) {
          // Use o tipo Decimal do Prisma, que espera uma string ou número
          dataToUpdate.price = parseFloat(newStockData[priceKey]);
        }

        if (Object.keys(dataToUpdate).length > 0) {
          return prisma.stockItem.update({ where: { id: item.id }, data: dataToUpdate });
        }
        return null;
      })
      .filter(Boolean); // Remove nulls from the array

    await prisma.$transaction(updateOperations);

    // Se o canal de estoque estiver configurado, cria ou atualiza o embed.
    if (CONFIG.mainChannelId) {
      try {
        const message = await updateMainEmbed();
        // Se uma nova mensagem foi criada, salva seu ID.
        if (message && !CONFIG.mainMessageId) {
          CONFIG.mainMessageId = message.id;
          await saveConfig();
          console.log(`Nova mensagem de estoque criada com ID: ${message.id}`);
        }
      } catch (err) { console.error('Erro ao criar/atualizar embed principal:', err); }
    }
    
    const updatedStock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
    res.json({ status: 'success', stock: updatedStock });
  } catch (error) {
    console.error('Erro ao atualizar o estoque:', error);
    res.status(500).json({ status: 'error', message: 'Falha ao atualizar o estoque.' });
  }
});

// Deliveries: create delivery (with optional file upload)
// Fields expected: webhook (delivery webhook URL), mention (string), itemId, quantity, note (optional)
// multipart/form-data with file field 'photo' (optional)
adminRouter.post('/deliver', upload.single('photo'), async (req, res) => {
  try {
    const { mention, itemId, quantity, note } = req.body;
    if (!CONFIG.deliveryChannelId) return res.status(400).json({ status: 'error', message: 'Canal de entregas não configurado no painel.' });
    if (!itemId) return res.status(400).json({ status: 'error', message: 'itemId requerido' });

    const item = await prisma.stockItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ status: 'error', message: 'item não encontrado' });

    const qty = Number(quantity) || 1;

    // save photo URL if uploaded
    let photoUrl = null;
    if (req.file) {
      photoUrl = `${getServerBaseUrl(req)}/uploads/${req.file.filename}`;
    }

    // build embed payload for delivery
    const embed = {
      title: '📦 Entrega Confirmada',
      color: 3066993,
      image: photoUrl ? { url: photoUrl } : undefined,
      fields: [
        { name: 'Destinatário', value: mention || 'Não informado', inline: true },
        { name: 'Produto', value: `${item.emoji} ${item.name}`, inline: true },
        { name: 'Quantidade', value: String(qty), inline: true },
        { name: 'Preço Unit.', value: `R$${item.price.toFixed(2)}`, inline: true },
      ],
      description: note ? `${note}` : undefined,
      footer: { text: 'DOLLYA STORE — Entrega' }
    };

    // Para a menção funcionar, ela precisa estar no campo "content".
    // Também verificamos se o usuário digitou um ID numérico e o formatamos corretamente.
    let content = mention || '';
    if (/^\d{17,19}$/.test(content)) {
      content = `<@${content}>`;
    }

    // Monta o corpo da mensagem para o bot
    const body = {
      content: content,
      embeds: [embed]
    };

    // Envia a mensagem usando o bot
    const sentMessage = await sendMessageWithBot(CONFIG.deliveryChannelId, null, body);

    // save delivery log to database
    const deliveryRecord = await prisma.deliveryRecord.create({
      data: {
        mention: mention || null,
        itemId,
        itemName: item.name,
        quantity: qty,
        photoUrl,
        messageSent: !!sentMessage,
        messageStatus: sentMessage ? 200 : 500 // Simula um status de sucesso/falha
      }
    });

    res.json({ status: 'success', delivery: deliveryRecord });
  } catch (err) {
    console.error('Erro em /deliver:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// Get deliveries history
adminRouter.get('/get-deliveries', async (req, res) => {
  const deliveries = await prisma.deliveryRecord.findMany({ orderBy: { timestamp: 'desc' } });
  res.json(deliveries);
});

// Get banned users
adminRouter.get('/get-bans', async (req, res) => {
  if (!CONFIG.guildId) return res.status(400).json([]);
  try {
    const guild = await bot.guilds.fetch(CONFIG.guildId);
    const bans = await guild.bans.fetch();
    res.json(bans.map(ban => ({ user: ban.user, reason: ban.reason })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bans' });
  }
});

// Rota para exibir a página de upload de comprovante
app.get('/upload-proof/:deliveryId', async (req, res) => {
  const { deliveryId } = req.params;
  const deliveryRecord = await prisma.deliveryRecord.findUnique({ where: { id: parseInt(deliveryId) } });

  if (!deliveryRecord || deliveryRecord.messageSent) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Erro</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap');
          body { font-family: 'Inter', sans-serif; background-color: #1e1f22; color: #dcddde; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
          .container { background-color: #2b2d31; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
          h1 { color: #f2b84b; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⚠️ Entrega não encontrada</h1>
          <p>Este link de upload pode ser inválido ou a entrega já foi finalizada.</p>
        </div>
      </body>
      </html>
    `);
  }

  // Página HTML simples para o upload
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Enviar Comprovante de Entrega</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
            body {
                font-family: 'Inter', sans-serif;
                background-color: #111827;
                color: #dcddde;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
                padding: 1.5rem;
                box-sizing: border-box;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            }
            .card {
                background-color: #1f2937;
                padding: 2rem;
                border-radius: 8px;
                box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
                width: 100%;
                max-width: 500px;
            }
            h2 {
                color: #f9fafb;
                text-align: center;
                margin-top: 0;
                margin-bottom: 0.5rem;
            }
            p { text-align: center; margin-bottom: 2rem; color: #9ca3af; }
            strong { color: #60a5fa; }
            .form-group { margin-bottom: 1.5rem; }
            label { display: block; margin-bottom: 0.5rem; font-weight: 500; color: #b5bac1; }
            input[type="file"] { display: none; }
            .file-label {
                display: block;
                background-color: #3a3c42;
                color: #dcddde;
                padding: 14px;
                border-radius: 5px;
                cursor: pointer;
                text-align: center;
                transition: background-color 0.2s;
                border: 1px dashed #4b5563;
            }
            .file-label:hover { background-color: #4a4d53; }
            #file-name { margin-top: 10px; color: #949ba4; font-size: 0.9em; text-align: center; }
            textarea {
                width: 100%;
                background-color: #111827;
                border: 1px solid #374151;
                border-radius: 5px;
                padding: 10px;
                color: #dcddde;
                resize: vertical;
                min-height: 80px;
                box-sizing: border-box;
                transition: border-color 0.2s;
            }
            textarea:focus {
                outline: none;
                border-color: #3b82f6;
            }
            button {
                width: 100%;
                padding: 12px;
                background-color: #5865f2;
                color: white;
                border: none;
                border-radius: 5px;
                font-size: 1rem;
                font-weight: 700;
                cursor: pointer;
                transition: background-color 0.2s;
            }
            button:hover { background-color: #2563eb; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Enviar Comprovante</h2>
            <p>Produto: <strong>${deliveryRecord.itemName}</strong></p>
            <form action="/submit-proof/${deliveryId}" method="post" enctype="multipart/form-data">
                <div class="form-group">
                    <label for="photo">Foto da Entrega</label>
                    <label for="photo" class="file-label">Escolher arquivo...</label>
                    <input type="file" id="photo" name="photo" accept="image/*" required>
                    <div id="file-name">Nenhum arquivo selecionado</div>
                </div>
                <div class="form-group">
                    <label for="note">Nota (opcional)</label>
                    <textarea id="note" name="note" placeholder="Alguma observação sobre a entrega?"></textarea>
                </div>
                <button type="submit">Enviar Comprovante</button>
            </form>
        </div>
        <script>
            document.getElementById('photo').addEventListener('change', function() {
                const fileName = this.files[0] ? this.files[0].name : 'Nenhum arquivo selecionado';
                document.getElementById('file-name').textContent = fileName;
            });
        </script>
    </body>
    </html>
  `);
});

// Rota para receber o comprovante enviado
app.post('/submit-proof/:deliveryId', upload.single('photo'), async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const { note } = req.body;
    const deliveryRecord = await prisma.deliveryRecord.findUnique({ where: { id: parseInt(deliveryId) } });

    if (!deliveryRecord) {
      return res.status(404).send(getStyledMessage('⚠️ Erro', 'Registro de entrega não encontrado.'));
    }
    if (!req.file) {
      return res.status(400).send(getStyledMessage('⚠️ Erro', 'Nenhum arquivo de imagem foi enviado.'));
    }

    const photoUrl = `${getServerBaseUrl(req)}/uploads/${req.file.filename}`;

    // Chama a função principal de entrega
    await createDelivery(deliveryRecord.mention, deliveryRecord.itemId, deliveryRecord.quantity, note, photoUrl, deliveryRecord.ticketChannelId);

    res.send(getStyledMessage('✅ Sucesso!', 'Comprovante enviado e entrega registrada no Discord. Você já pode fechar esta página.')); 

  } catch (error) {
    console.error('Erro ao submeter comprovante:', error);
    res.status(500).send(getStyledMessage('❌ Erro no Servidor', 'Ocorreu uma falha ao processar sua solicitação. Por favor, tente novamente.'));
  }
});

// Endpoint para manter o serviço "acordado" em plataformas como o Render
app.get('/ping', (req, res) => {
  console.log('Ping recebido!');
  res.status(200).json({ status: 'ok', message: 'Bot is alive.' });
});

// Rota para a vitrine pública da loja
app.get('/loja', async (req, res) => {
  try {
    const stock = await prisma.stockItem.findMany({
      orderBy: { name: 'asc' }
    });
    // Renderiza o arquivo 'loja.ejs' dentro da pasta 'views'
    // e passa a variável 'stock' para o template
    res.render('loja', { stock: stock, guildId: CONFIG.guildId });
  } catch (error) {
    console.error("Erro ao carregar a página da loja:", error);
    res.status(500).send("Erro ao carregar a loja. Tente novamente mais tarde.");
  }
});
// As rotas da API do painel são agrupadas aqui
app.use('/', adminRouter);

// Serve os arquivos estáticos do painel (HTML, CSS, JS)
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- helper functions ---------- //

// get base url from request
function getServerBaseUrl(req) {
  // If behind proxy, you might want to use X-Forwarded-Proto/header; this is a simple approach
  const host = req.get('host');
  const proto = req.protocol;
  return `${proto}://${host}`;
}

/**
 * Gera uma página HTML estilizada para mensagens de status (sucesso/erro).
 * @param {string} title O título da página.
 * @param {string} message A mensagem a ser exibida.
 * @returns {string} O HTML completo da página.
 */
function getStyledMessage(title, message) {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #111827; color: #dcddde; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
        .container { background-color: #1f2937; padding: 2rem 3rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        h1 { margin-top: 0; color: #fff; }
        p { color: #9ca3af; }
      </style>
    </head>
    <body><div class="container"><h1>${title}</h1><p>${message}</p></div></body>
    </html>`;
}

/**
 * Garante que o cargo "Castigado" exista e tenha as permissões corretas.
 * @param {import('discord.js').Guild} guild O servidor.
 * @returns {Promise<import('discord.js').Role>} O cargo de castigo.
 */
async function getOrCreatePunishedRole(guild) {
  const roleName = 'Castigado';
  let punishedRole = guild.roles.cache.find(role => role.name === roleName);

  if (!punishedRole) {
    try {
      console.log(`Cargo "${roleName}" não encontrado. Criando...`);
      punishedRole = await guild.roles.create({
        name: roleName,
        color: '#718096', // Cinza
        permissions: [], // Começa sem nenhuma permissão
        reason: 'Cargo para isolar membros castigados.'
      });
      console.log(`Cargo "${roleName}" criado com ID: ${punishedRole.id}`);

      // Aplica a restrição de visualização em todos os canais
      const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice);
      for (const channel of channels.values()) {
        await channel.permissionOverwrites.edit(punishedRole.id, {
          ViewChannel: false
        });
      }
      console.log(`Permissões do cargo "${roleName}" aplicadas nos canais existentes.`);
    } catch (error) {
      console.error(`Falha ao criar ou configurar o cargo "${roleName}":`, error);
      throw new Error('Não foi possível criar o cargo de castigo. Verifique as permissões do bot.');
    }
  }
  return punishedRole;
}
/**
 * Envia ou edita uma mensagem em um canal do Discord usando o bot.
 * @param {string} channelId O ID do canal.
 * @param {string|null} messageId O ID da mensagem para editar. Se for nulo, uma nova mensagem será enviada.
 * @param {object} body O corpo da mensagem (compatível com a API do Discord).
 * @returns {Promise<import('discord.js').Message|null>} A mensagem enviada/editada ou nulo em caso de erro.
 */
async function sendMessageWithBot(channelId, messageId, body) {
  if (!bot.isReady()) {
    console.error('Bot não está pronto para enviar mensagens.');
    return null;
  }
  try {
    const channel = await bot.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`Canal ${channelId} não encontrado ou não é um canal de texto.`);
      return null;
    }
    return messageId ? await channel.messages.edit(messageId, body) : await channel.send(body);
  } catch (error) {
    console.error(`Erro ao interagir com a API do Discord no canal ${channelId}:`, error);
    return null;
  }
}
// generate main embed from stock (if you want to update the main store embed)
async function generateMainEmbed() {
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  return {
    username: "DOLLYA VS BRAINROTS [PREÇOS]",
    avatar_url: "", // optional
    embeds: [{
      title: "🧠 DOLLYA STORE | TABELA DE PREÇOS",
      color: 16753920,
      fields: stock.map(item => ({
        name: `${item.emoji} ${item.name}`,
        value: `**Preço:** R$${item.price.toFixed(2)}\n**Estoque:** ${item.quantity > 0 ? item.quantity : 'ESGOTADO'}`,
        inline: true
      })),
      footer: { text: '🛒 DOLLYA STORE' }
    }],
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 3, // Success (verde)
            label: '🛒 Comprar',
            custom_id: 'buy_item_button'
          }
        ]
      }
    ]
  };
}

// update the main embed (if configured)
async function updateMainEmbed() {
  if (!CONFIG.mainChannelId) {
    console.log('Canal principal não configurado; pulando updateMainEmbed.');
    return null;
  }
  try {
    const body = await generateMainEmbed();
    // Remove username/avatar_url que são específicos de webhooks
    delete body.username;
    delete body.avatar_url;
    
    let message = null;
    try {
      // Tenta editar a mensagem se um ID existir
      if (CONFIG.mainMessageId) {
        message = await sendMessageWithBot(CONFIG.mainChannelId, CONFIG.mainMessageId, body);
      }
    } catch (error) {
      // Se a edição falhar (ex: mensagem não existe ou permissão negada), cria uma nova.
      if (error.code === 10008 || error.code === 50005) { // 10008: Unknown Message, 50005: Cannot edit another user's message
        console.warn(`Não foi possível editar a mensagem ${CONFIG.mainMessageId}. Criando uma nova.`);
        CONFIG.mainMessageId = null; // Limpa o ID inválido
      } else {
        throw error; // Lança outros erros
      }
    }
    
    // Se a mensagem não foi editada (ou a edição falhou), cria uma nova.
    if (!message) {
      message = await sendMessageWithBot(CONFIG.mainChannelId, null, body);
    }
    
    if (message) console.log(`Embed de estoque ${CONFIG.mainMessageId ? 'atualizado' : 'criado'}.`);
    
    return message; // Retorna a mensagem para que o ID possa ser salvo
  } catch (err) {
    console.error('Erro ao atualizar main embed:', err);
  }
}

// read selected message to populate stock (if you used a message to store stock)
async function fetchSelectedMessage() {
  if (!CONFIG.mainChannelId || !CONFIG.mainMessageId) {
    console.log('Canal/ID da mensagem não configurados para leitura.');
    return;
  }
  try {
    if (!bot.isReady()) {
      console.error('Bot não está pronto para buscar mensagens.');
      return;
    }
    const channel = await bot.channels.fetch(CONFIG.mainChannelId);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(CONFIG.mainMessageId);
    if (message && message.embeds && message.embeds.length > 0) {
      console.log('Lendo embed do Discord para atualizar estoque local...');
      const fields = message.embeds[0].fields || [];
      
      const currentStock = await prisma.stockItem.findMany();
      const updatePromises = [];

      // Itera sobre os campos do embed para atualizar o estoque local
      fields.forEach(field => {
        // Encontra o item correspondente no estoque local pelo nome
        const itemInStock = currentStock.find(item => field.name.includes(item.name));
        
        if (itemInStock) {
          const cleaned = String(field.value).replace(/\*\*/g, '');
          const matchQty = cleaned.match(/Estoque:\s*([0-9]+|ESGOTADO)/i);
          const matchPrice = cleaned.match(/Preço:\s*R\$([\d,.]+)/i);

          const dataToUpdate = {};
          if (matchQty) {
            dataToUpdate.quantity = matchQty[1].toUpperCase() === 'ESGOTADO' ? 0 : parseInt(matchQty[1], 10);
          }
          if (matchPrice) {
            dataToUpdate.price = parseFloat(matchPrice[1].replace(',', '.'));
          }
          if (Object.keys(dataToUpdate).length > 0) {
            updatePromises.push(prisma.stockItem.update({ where: { id: itemInStock.id }, data: dataToUpdate }));
          }
        }
      });

      await Promise.all(updatePromises);
      console.log('Estoque local atualizado com base na mensagem do Discord. Itens novos foram preservados.');
    }
  } catch (err) {
    console.error('Erro ao buscar mensagem selecionada:', err);
  }
}

// Função refatorada para criar uma entrega, pode ser chamada de qualquer lugar
async function createDelivery(mention, itemId, quantity, note, photoUrl, channelIdForFeedback) {
  try {
    if (!CONFIG.deliveryChannelId) {
      if (channelIdForFeedback) await bot.channels.cache.get(channelIdForFeedback)?.send('Erro: Canal de entregas não configurado.');
      return;
    }
    const item = await prisma.stockItem.findUnique({ where: { id: itemId } });
    if (!item) {
      if (channelIdForFeedback) await bot.channels.cache.get(channelIdForFeedback)?.send('Erro: Item da entrega não encontrado.');
      return;
    }

    const embed = {
      title: '📦 Entrega Confirmada',
      color: 3066993,
      image: photoUrl ? { url: photoUrl } : undefined, // Mantido para consistência, já estava correto.
      fields: [
        { name: 'Destinatário', value: `<@${mention}>`, inline: true },
        { name: 'Produto', value: `${item.emoji} ${item.name}`, inline: true },
        { name: 'Quantidade', value: String(quantity), inline: true },
        { name: 'Preço Unit.', value: `R$${Number(item.price).toFixed(2)}`, inline: true },
      ],
      description: note ? `${note}` : undefined,
      footer: { text: 'DOLLYA STORE — Entrega' }
    };
    
    // A menção no conteúdo será do usuário que comprou.
    const content = `<@${mention}>`;
    
    const body = {
      content: content,
      embeds: [embed]
    };

    const sentMessage = await sendMessageWithBot(CONFIG.deliveryChannelId, null, body);

    // Atualiza o registro de entrega existente em vez de criar um novo
    // Isso evita duplicatas e mantém o fluxo consistente
    const existingRecord = await prisma.deliveryRecord.findFirst({
      where: { mention: mention, itemId: itemId, messageSent: false },
      orderBy: { timestamp: 'desc' }
    });

    if (existingRecord) {
      await prisma.deliveryRecord.update({
        where: { id: existingRecord.id },
        data: {
          photoUrl,
          messageSent: !!sentMessage,
          messageStatus: sentMessage ? 200 : 500
        }
      });
    } else { // 10. Adicionada verificação para evitar erro se o registro não for encontrado
      console.warn(`Registro de entrega para ${mention} (item ${itemId}) não encontrado para atualização.`);
      return;
    }

    // Atualiza o estoque
    await prisma.stockItem.update({
      where: { id: itemId },
      data: { quantity: { decrement: quantity } }
    });

    // Atribui o cargo de cliente, se configurado
    if (CONFIG.guildId && CONFIG.clientRoleId && mention) {
      try {
        const guild = await bot.guilds.fetch(CONFIG.guildId);
        const member = await guild.members.fetch(mention);
        const role = await guild.roles.fetch(CONFIG.clientRoleId);
        if (member && role) {
          await member.roles.add(role);
          console.log(`Cargo "${role.name}" atribuído a ${member.user.tag}.`);
        }
      } catch (roleError) {
        console.error('Erro ao atribuir cargo de cliente:', roleError);
      }
    }

    // Pergunta pela avaliação se o canal estiver configurado
    if (CONFIG.reviewsChannelId && existingRecord && channelIdForFeedback) {
      const threadChannel = await bot.channels.fetch(channelIdForFeedback);
      if (threadChannel) {
        await threadChannel.send({
          content: `Obrigado pela sua compra, <@${mention}>! Gostaria de deixar uma avaliação?`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`leave_review_${existingRecord.id}`)
              .setLabel('Deixar Avaliação')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('⭐')
          )]
        });
      }
    }
  } catch (error) {
    console.error('Erro ao criar entrega via bot:', error);
  }
}

/**
 * Registra os comandos de barra (/) da aplicação no Discord.
 * Garante que os comandos estejam disponíveis na guilda especificada.
 */
async function registerCommands() {
  const clientId = process.env.CLIENT_ID;
  const guildId = CONFIG.guildId; // Usa o guildId carregado da configuração

  if (!clientId || !guildId) {
    console.error('Erro ao registrar comandos: CLIENT_ID ou GUILD_ID não estão configurados.');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('criar-cupom')
      .setDescription('Cria um novo cupom de desconto.')
      .addStringOption(option => option.setName('codigo').setDescription('O código único do cupom (ex: BEMVINDO10)').setRequired(true))
      .addNumberOption(option => option.setName('desconto').setDescription('A porcentagem de desconto (ex: 10 para 10%)').setRequired(true))
      .addIntegerOption(option => option.setName('usos').setDescription('O número de vezes que o cupom pode ser usado').setRequired(true)),
    new SlashCommandBuilder()
      .setName('deletar-cupom')
      .setDescription('Deleta um cupom de desconto existente.')
      .addStringOption(option =>
        option.setName('codigo')
          .setDescription('O código do cupom a ser deletado.')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('castigar')
      .setDescription('Aplica um castigo a um membro, restringindo seu acesso.')
      .addUserOption(option => option.setName('usuario').setDescription('O membro a ser castigado.').setRequired(true))
      .addStringOption(option => option.setName('razao').setDescription('A razão para o castigo.').setRequired(true))
      .setDefaultMemberPermissions(0), // Apenas admins
    new SlashCommandBuilder()
      .setName('banir')
      .setDescription('Bane um membro permanentemente do servidor.')
      .addUserOption(option => option.setName('usuario').setDescription('O membro a ser banido.').setRequired(true))
      .addStringOption(option => option.setName('razao').setDescription('A razão para o banimento.').setRequired(false))
      .setDefaultMemberPermissions(0), // Apenas admins
    new SlashCommandBuilder()
      .setName('perdoar')
      .setDescription('Remove o castigo de um membro.')
      .addUserOption(option => option.setName('usuario').setDescription('O membro a ser perdoado.').setRequired(true)),
    new SlashCommandBuilder()
      .setName('advertir')
      .setDescription('Aplica uma advertência a um membro.')
      .addUserOption(option => option.setName('usuario').setDescription('O membro a ser advertido.').setRequired(true))
      .addStringOption(option => option.setName('razao').setDescription('A razão da advertência.').setRequired(true))
      .setDefaultMemberPermissions(0),
    new SlashCommandBuilder()
      .setName('advertencias')
      .setDescription('Mostra o histórico de advertências de um membro.')
      .addUserOption(option => option.setName('usuario').setDescription('O membro a ser consultado.').setRequired(true))
      .setDefaultMemberPermissions(0),
    new SlashCommandBuilder()
      .setName('remover-advertencia')
      .setDescription('Remove uma advertência específica pelo ID.')
      .addIntegerOption(option => option.setName('id').setDescription('O ID da advertência a ser removida.').setRequired(true)),
    new SlashCommandBuilder().setName('dashboard').setDescription('Gera um link para o painel de estatísticas.').setDefaultMemberPermissions(0)
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  try {
    console.log('Iniciando o registro de (/) comandos da aplicação.');
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );
    console.log('(/) comandos da aplicação registrados com sucesso.');
  } catch (error) {
    console.error('Falha ao registrar comandos:', error);
  }
}

async function startServer() {
  // 1. Verifica as variáveis de ambiente
  if (!process.env.DATABASE_URL || !process.env.BOT_TOKEN) {
    console.error('Erro Crítico: As variáveis de ambiente DATABASE_URL e BOT_TOKEN devem ser definidas no arquivo .env.');
    process.exit(1); // Encerra a aplicação se o DB não estiver configurado.
  }

  // 2. Carrega as configurações do config.json
  await loadConfig();

  // 3. Conecta o bot do Discord
  console.log("Fazendo login do bot...");
  await bot.login(process.env.BOT_TOKEN);

  bot.on('ready', async () => {
    console.log(`Bot logado como ${bot.user.tag}!`);

    // Registra os comandos de barra no Discord
    await registerCommands();

    // 4. Popula o banco de dados se necessário
    await seedDatabase();

    // 5. Sincroniza com o Discord se configurado
    if (CONFIG.mainChannelId && CONFIG.mainMessageId) {
      await fetchSelectedMessage();
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando e pronto na porta ${PORT}`);
    });
  });

  bot.on('interactionCreate', async interaction => {
    try {
      // --- Manipulador do Botão "Comprar" ---
      if (interaction.isButton() && interaction.customId === 'buy_item_button') { // Botão Comprar
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const availableStock = await prisma.stockItem.findMany({
          where: { quantity: { gt: 0 } },
          orderBy: { name: 'asc' }
        });

        if (availableStock.length === 0) {
          await interaction.editReply({ content: 'Desculpe, todos os nossos itens estão esgotados no momento.', flags: [MessageFlags.Ephemeral] });
          return;
        }

        // 1. Corrige a criação do Select Menu usando builders
        const selectMenu = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_item_to_buy')
            .setPlaceholder('Selecione um item para comprar')
            .addOptions(availableStock.map(item => ({
              label: item.name,
              description: `Preço: R$${item.price.toFixed(2)} | Estoque: ${item.quantity}`,
              value: item.id,
              emoji: item.emoji || undefined
            })))
        );

        await interaction.editReply({
          content: 'Por favor, selecione o item que você deseja comprar:',
          components: [selectMenu]
        });
      }

      // --- Manipulador da Seleção do Item ---
      else if (interaction.isStringSelectMenu() && interaction.customId === 'select_item_to_buy') { // Seleção de item
        // Adia a resposta para o Discord saber que estamos processando.
        // Isso nos dá 15 minutos para concluir e evita o erro "Unknown Interaction".
        await interaction.deferUpdate();

        // Desativa o menu de seleção para evitar duplo clique e dar feedback ao usuário.
        const originalMessage = interaction.message;
        const newActionRow = new ActionRowBuilder();
        originalMessage.components[0].components.forEach(component => {
          const newSelectMenu = StringSelectMenuBuilder.from(component).setDisabled(true);
          newActionRow.addComponents(newSelectMenu);
        });
        await interaction.editReply({ components: [newActionRow] });

        const selectedItemId = interaction.values[0];
        const item = await prisma.stockItem.findUnique({ where: { id: selectedItemId } });
        const owner = (await bot.application.fetch()).owner;

        if (!item) {
          await interaction.followUp({ content: 'O item selecionado não foi encontrado.', flags: [MessageFlags.Ephemeral] });
          return;
        }

        // 1. Cria um registro de entrega preliminar no banco de dados
        // para que o ID do registro possa ser usado no tópico, se necessário.
        const deliveryRecord = await prisma.deliveryRecord.create({
          data: {
            mention: interaction.user.id,
            itemId: item.id,
            itemName: item.name,
            quantity: 1, // Assumindo quantidade 1 por enquanto
            messageSent: false, // Ainda não foi enviado para o canal de entregas
            messageStatus: 102, // Status "Processing"
          }
        });

        // Cria um canal de texto privado (ticket)
        const guild = interaction.guild;
        const channelName = `🛒-${item.name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 20)}-${interaction.user.username.substring(0, 10)}`;

        const ticketChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: guild.roles.everyone, // @everyone role
              deny: ['ViewChannel'],
            },
            {
              id: interaction.user.id, // O comprador
              allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'],
            },
            {
              id: owner.id, // O dono do bot
              allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'ManageMessages'],
            },
            {
              id: bot.user.id, // O próprio bot
              allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'],
            }
          ],
          reason: `Ticket de compra para ${interaction.user.tag} (Record ID: ${deliveryRecord.id})`,
        });

        // Agora, atualiza o registro com o ID do canal
        await prisma.deliveryRecord.update({
          where: { id: deliveryRecord.id },
          data: { ticketChannelId: ticketChannel.id }
        });

        // Mensagem de boas-vindas com o botão de fechar
        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`apply_coupon_${deliveryRecord.id}`)
            .setLabel('Aplicar Cupom')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎟️'),
          new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('Fechar Ticket')
            .setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({
          content: `Olá <@${interaction.user.id}> e <@${owner.id}>! Este é o seu ticket para a compra de **${item.emoji} ${item.name}**.\n\n` +
                   `**Valor original:** R$ ${item.price.toFixed(2)}\n\n` +
                   `Se tiver um cupom, clique no botão para aplicá-lo. ` +
                   `Após a confirmação do pagamento, o administrador irá confirmar a entrega.`,
          components: [actionRow]
        });
        
        // Envia a mensagem de confirmação para o admin no ticket
        if (owner) {
          await ticketChannel.send({
            content: `<@${owner.id}>, o pedido já foi entregue?`,
            components: [{
              type: 1,
              components: [ // 3. Corrige a criação do botão usando builders (mesmo que dentro de um objeto)
                new ButtonBuilder()
                  .setCustomId(`confirm_delivery_${deliveryRecord.id}`)
                  .setLabel('Confirmar Entrega')
                  .setStyle(ButtonStyle.Success)
              ],
            }]
          });
        }

        await interaction.followUp({ content: `Seu ticket de compra foi criado com sucesso: <#${ticketChannel.id}>`, flags: [MessageFlags.Ephemeral] });
      }

      // --- Manipulador do Botão "Confirmar Entrega" ---
      else if (interaction.isButton() && interaction.customId.startsWith('confirm_delivery_')) { // Botão Confirmar Entrega
        // Adia a resposta IMEDIATAMENTE para evitar o erro "Unknown Interaction"
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const owner = (await bot.application.fetch()).owner;
        // Garante que apenas o dono do bot pode clicar
        if (interaction.user.id !== owner.id) {
          return interaction.editReply({ content: 'Apenas o administrador pode confirmar a entrega.', flags: [MessageFlags.Ephemeral] });
        }

        // Obtém o ID do registro a partir do custom_id
        const deliveryRecordId = parseInt(interaction.customId.split('_')[2], 10);
        const deliveryRecord = await prisma.deliveryRecord.findUnique({ where: { id: deliveryRecordId } });

        if (!deliveryRecord) {
          // --- INÍCIO DO FALLBACK ---
          console.warn(`Registro de entrega ${deliveryRecordId} não encontrado. Iniciando fallback manual.`);

          // Encontra o comprador no ticket (qualquer um que não seja o bot ou o admin)
          const members = await interaction.channel.members.fetch();
          const buyer = members.find(m => m.id !== owner.id && m.id !== bot.user.id);

          if (!buyer) {
            return interaction.editReply({ content: 'Erro: Não foi possível identificar o comprador neste ticket para continuar manualmente.', flags: [MessageFlags.Ephemeral] });
          }

          const allStock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
          const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`manual_delivery_${buyer.id}`) // 5. Corrigido para usar métodos encadeados
              .setPlaceholder('Selecione a fruta que foi entregue') // 3. Corrigido para usar o método
              .addOptions(allStock.map(item => ({ // 4, 6. Corrigido o encadeamento e fechamento
                label: item.name,
                description: `Preço: R$${item.price.toFixed(2)} | Estoque: ${item.quantity}`,
                value: item.id,
                emoji: item.emoji || undefined
              })))
          );

          await interaction.editReply({ content: '⚠️ **Falha ao encontrar o registro automático.**\nPor favor, selecione manualmente o item que foi entregue para continuar:', components: [selectMenu] });
          return; // Encerra o fluxo normal e aguarda a seleção manual
          // --- FIM DO FALLBACK ---
        }

        // Desativa o botão para evitar cliques duplos
        const originalMessage = interaction.message;
        const newActionRow = new ActionRowBuilder();
        originalMessage.components[0].components.forEach(button => {
          const newButton = ButtonBuilder.from(button).setDisabled(true);
          newActionRow.addComponents(newButton);
        });

        await originalMessage.edit({ components: [newActionRow] });
        await interaction.editReply({ content: 'Botão desativado. Processando...' }); // Confirma que a ação foi recebida.

        // Usa a URL base da configuração
        const baseUrl = CONFIG.baseUrl;
        if (!baseUrl) {
            return interaction.followUp({ content: 'Erro: A `BASE_URL` não está configurada nas variáveis de ambiente. Não é possível gerar o link de upload.', flags: [MessageFlags.Ephemeral] });
        }


        // Constrói a URL de forma segura para evitar barras duplas
        const url = new URL(baseUrl);
        url.pathname = path.join(url.pathname, `/upload-proof/${deliveryRecord.id}`);
        const uploadUrl = url.toString();

        const uploadButton = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Enviar Comprovante')
            .setStyle(ButtonStyle.Link)
            .setURL(uploadUrl)
            .setEmoji('📸')
        );

        await interaction.followUp({
          content: `Clique no botão abaixo para enviar a foto de comprovação e uma nota para a entrega.`,
          components: [uploadButton],
          flags: [MessageFlags.Ephemeral]
        });
      }

      // --- Manipulador do Fallback de Entrega Manual ---
      else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('manual_delivery_')) {
        await interaction.deferUpdate(); // Confirma o recebimento da seleção

        const buyerId = interaction.customId.split('_')[2];
        const itemId = interaction.values[0];

        const item = await prisma.stockItem.findUnique({ where: { id: itemId } });

        // Cria um registro de entrega para o fluxo manual
        const deliveryRecord = await prisma.deliveryRecord.create({
            data: {
                mention: buyerId,
                itemId: itemId,
                itemName: item.name,
                quantity: 1,
                messageSent: false,
                messageStatus: 102
            }
        });

        // Gera o link de upload, assim como no fluxo normal
        const baseUrl = CONFIG.baseUrl;
        if (!baseUrl) {
            return interaction.followUp({ content: 'Erro: A `BASE_URL` não está configurada. Não é possível gerar o link de upload.', flags: [MessageFlags.Ephemeral] });
        }
        // Constrói a URL de forma segura para evitar barras duplas
        const url = new URL(baseUrl);
        url.pathname = path.join(url.pathname, `/upload-proof/${deliveryRecord.id}`);
        const uploadUrl = url.toString();

        const uploadButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Enviar Comprovante (Manual)')
                .setStyle(ButtonStyle.Link)
                .setURL(uploadUrl)
                .setEmoji('📸')
        );

        await interaction.followUp({
            content: `Item selecionado manualmente. Clique no botão para enviar o comprovante.`,
            components: [uploadButton],
            flags: [MessageFlags.Ephemeral]
        });
      }

      // --- Manipulador do Botão "Deixar Avaliação" ---
      else if (interaction.isButton() && interaction.customId.startsWith('leave_review_')) {
        const deliveryRecordId = parseInt(interaction.customId.split('_')[2], 10);
        const deliveryRecord = await prisma.deliveryRecord.findUnique({ where: { id: deliveryRecordId } });

        // Garante que apenas o comprador pode deixar a avaliação
        if (interaction.user.id !== deliveryRecord.mention) {
          return interaction.reply({ content: 'Apenas o comprador pode deixar uma avaliação para este pedido.', flags: [MessageFlags.Ephemeral] });
        }

        const modal = new ModalBuilder()
          .setCustomId(`review_modal_${deliveryRecordId}`)
          .setTitle('Sua Avaliação');

        const reviewInput = new TextInputBuilder()
          .setCustomId('review_text')
          .setLabel("O que você achou da sua compra?")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Sua experiência foi ótima? O atendimento foi rápido? Nos conte tudo!')
          .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(reviewInput);
        modal.addComponents(firstActionRow);

        await interaction.showModal(modal);
      }

      // --- Manipulador do Modal de Avaliação ---
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('review_modal_')) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const deliveryRecordId = parseInt(interaction.customId.split('_')[2], 10);
        const deliveryRecord = await prisma.deliveryRecord.findUnique({ where: { id: deliveryRecordId } });
        const reviewText = interaction.fields.getTextInputValue('review_text');

        const reviewEmbed = {
          color: 0x5865F2, // Discord Blurple
          author: {
            name: `Avaliação de ${interaction.user.username}`,
            icon_url: interaction.user.displayAvatarURL(),
          },
          description: `**Produto Comprado:** ${deliveryRecord.itemName}\n\n>>> ${reviewText}`,
          footer: { text: `Cliente verificado` },
          timestamp: new Date().toISOString(),
        };

        await sendMessageWithBot(CONFIG.reviewsChannelId, null, { embeds: [reviewEmbed] });

        await interaction.editReply({ content: 'Obrigado! Sua avaliação foi enviada com sucesso.', flags: [MessageFlags.Ephemeral] });

        // Fecha o ticket após a avaliação
        await interaction.channel.send('Avaliação recebida! Este ticket será fechado em 10 segundos.');
        const channelToArchive = interaction.channel;
        setTimeout(async () => {
          try {
            if (channelToArchive) await channelToArchive.delete('Avaliação recebida e ticket finalizado.');
          } catch (error) {
            console.error(`Falha ao deletar o canal ${channelToArchive?.id} após avaliação:`, error);
          }
        }, 10000);
      }

      // --- Manipulador do Botão "Fechar Ticket" ---
      else if (interaction.isButton() && interaction.customId === 'close_ticket') {
        await interaction.deferUpdate(); // Adia a resposta para evitar erros
        
        // Desativa o botão para evitar cliques múltiplos
        const message = interaction.message;
        const newActionRow = new ActionRowBuilder();
        message.components[0].components.forEach(button => {
          const newButton = ButtonBuilder.from(button).setDisabled(true);
          newActionRow.addComponents(newButton);
        });

        await message.edit({ components: [newActionRow] });
        await interaction.followUp({ content: 'O ticket será fechado em 5 segundos...', ephemeral: true });
        const channelToClose = interaction.channel;
        setTimeout(async () => {
          try {
            if (channelToClose) await channelToClose.delete('Ticket fechado manualmente.');
          } catch (error) {
            console.error(`Falha ao deletar o canal ${channelToClose?.id} manualmente:`, error);
          }
        }, 5000);
      }

      // --- Manipulador do Botão "Aplicar Cupom" ---
      else if (interaction.isButton() && interaction.customId.startsWith('apply_coupon_')) {
        const deliveryRecordId = parseInt(interaction.customId.split('_')[2], 10);

        const modal = new ModalBuilder()
          .setCustomId(`coupon_modal_${deliveryRecordId}`)
          .setTitle('Aplicar Cupom de Desconto');

        const couponInput = new TextInputBuilder()
          .setCustomId('coupon_code_input')
          .setLabel("Digite seu código de cupom")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('EX: BEMVINDO10')
          .setRequired(true);

        const actionRow = new ActionRowBuilder().addComponents(couponInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
      }

      // --- Manipulador do Modal de Cupom ---
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('coupon_modal_')) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const deliveryRecordId = parseInt(interaction.customId.split('_')[2], 10);
        const couponCode = interaction.fields.getTextInputValue('coupon_code_input').toUpperCase();

        const coupon = await prisma.coupon.findUnique({ where: { code: couponCode } });

        if (!coupon || !coupon.isActive || coupon.usesLeft <= 0) {
          return interaction.editReply({ content: '❌ Cupom inválido, expirado ou já utilizado.' });
        }

        // Decrementa o uso do cupom
        await prisma.coupon.update({
          where: { id: coupon.id },
          data: { usesLeft: { decrement: 1 } }
        });

        const deliveryRecord = await prisma.deliveryRecord.findUnique({ where: { id: deliveryRecordId } });
        const item = await prisma.stockItem.findUnique({ where: { id: deliveryRecord.itemId } });

        const originalPrice = parseFloat(item.price);
        const discount = originalPrice * (coupon.discountPercentage / 100);
        const finalPrice = originalPrice - discount;

        // Notifica no canal do ticket sobre o desconto
        await interaction.channel.send({
          embeds: [{
            title: '🎟️ Cupom Aplicado com Sucesso!',
            color: 0x22c55e, // Verde
            description: `O cupom **${coupon.code}** foi aplicado.`,
            fields: [
              { name: 'Desconto', value: `${coupon.discountPercentage}%`, inline: true },
              { name: 'Valor Original', value: `R$ ${originalPrice.toFixed(2)}`, inline: true },
              { name: 'Novo Valor', value: `**R$ ${finalPrice.toFixed(2)}**`, inline: true },
            ],
            footer: { text: 'O administrador foi notificado do novo valor.' }
          }]
        });

        await interaction.editReply({ content: '✅ Cupom aplicado! O novo valor foi exibido no ticket.' });
      }

      // --- Comando de Admin para Criar Cupom ---
      else if (interaction.isCommand() && interaction.commandName === 'criar-cupom') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }

        const code = interaction.options.getString('codigo').toUpperCase();
        const discount = interaction.options.getNumber('desconto');
        const uses = interaction.options.getInteger('usos');

        try {
          const newCoupon = await prisma.coupon.create({
            data: {
              code: code,
              discountPercentage: discount,
              usesLeft: uses
            }
          });

          await interaction.reply({
            content: `✅ Cupom **${newCoupon.code}** criado com sucesso!\n` +
                     `- **Desconto:** ${newCoupon.discountPercentage}%\n` +
                     `- **Usos:** ${newCoupon.usesLeft}`,
            ephemeral: true
          });
        } catch (error) {
          if (error.code === 'P2002') { // Erro de violação de chave única do Prisma
            await interaction.reply({ content: `❌ Erro: O código de cupom "${code}" já existe.`, ephemeral: true });
          } else {
            await interaction.reply({ content: '❌ Ocorreu um erro ao criar o cupom.', ephemeral: true });
          }
        }
      }

      // --- Comando de Admin para Deletar Cupom ---
      else if (interaction.isCommand() && interaction.commandName === 'deletar-cupom') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }

        const code = interaction.options.getString('codigo').toUpperCase();

        try {
          const deletedCoupon = await prisma.coupon.delete({
            where: { code: code }
          });
          await interaction.reply({ content: `✅ Cupom **${deletedCoupon.code}** foi deletado com sucesso.`, ephemeral: true });
        } catch (error) {
          // Prisma's error code for "record to delete not found"
          if (error.code === 'P2025') {
            await interaction.reply({ content: `❌ Erro: O cupom com o código "${code}" não foi encontrado.`, ephemeral: true });
          } else {
            await interaction.reply({ content: '❌ Ocorreu um erro ao deletar o cupom.', ephemeral: true });
          }
        }
      }

      // --- Comando /dashboard ---
      else if (interaction.isCommand() && interaction.commandName === 'dashboard') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }

        const baseUrl = CONFIG.baseUrl;
        if (!baseUrl) {
          return interaction.reply({ content: 'A `BASE_URL` não está configurada. Não é possível gerar o link.', ephemeral: true });
        }

        const dashboardUrl = new URL(baseUrl);
        dashboardUrl.pathname = path.join(dashboardUrl.pathname, '/dashboard');

        await interaction.reply({ content: `Aqui está o link para o seu painel de estatísticas: ${dashboardUrl.toString()}`, ephemeral: true });
      }

      // --- COMANDOS DE MODERAÇÃO ---

      // Comando /castigar
      else if (interaction.isCommand() && interaction.commandName === 'castigar') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }

        const userToPunish = interaction.options.getUser('usuario');
        const reason = interaction.options.getString('razao');
        const member = await interaction.guild.members.fetch(userToPunish.id);

        if (!member) {
          return interaction.reply({ content: 'Membro não encontrado no servidor.', ephemeral: true });
        }

        // Verifica se o membro já está castigado
        const existingPunishment = await prisma.punishment.findUnique({ where: { userId: userToPunish.id } });
        if (existingPunishment) {
          const existingChannel = await bot.channels.fetch(existingPunishment.punishChannelId).catch(() => null);
          return interaction.reply({ content: `Este membro já está em um processo de julgamento. Canal: ${existingChannel || 'não encontrado'}. Use /perdoar para remover o castigo.`, ephemeral: true });
        }

        // Garante que o cargo "Castigado" exista
        let punishedRole;
        try {
          punishedRole = await getOrCreatePunishedRole(interaction.guild);
        } catch (error) {
          return interaction.reply({ content: `Erro ao configurar o sistema de castigo: ${error.message}`, ephemeral: true });
        }
        // Salva os cargos originais
        const originalRoles = member.roles.cache
          .filter(role => role.id !== interaction.guild.id) // Filtra o @everyone
          .map(role => role.id);

        // Cria o canal de julgamento
        const judgmentChannel = await interaction.guild.channels.create({
          name: `julgamento-${userToPunish.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: ['ViewChannel'] }, // Nega para @everyone
            { id: userToPunish.id, allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages'] }, // Agora o usuário pode falar no canal
            { id: punishedRole.id, deny: ['ViewChannel'] }, // Nega o cargo "Castigado" de ver este canal
            { id: owner.id, allow: ['ViewChannel', 'SendMessages'] }, // Permite para o admin
          ],
        });

        // Salva o estado do castigo no DB
        await prisma.punishment.create({
          data: {
            userId: userToPunish.id,
            originalRoles: originalRoles,
            punishChannelId: judgmentChannel.id,
            reason: reason,
          }
        });

        // Remove todos os cargos do usuário e adiciona apenas o de "Castigado"
        await member.roles.set([punishedRole.id]);

        // Envia a mensagem no canal de julgamento
        const judgmentRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`forgive_punishment_${userToPunish.id}`).setLabel('Perdoar Membro').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`confirm_punishment_${userToPunish.id}`).setLabel('Confirmar Castigo').setStyle(ButtonStyle.Danger)
        );

        await judgmentChannel.send({
          content: `<@${owner.id}>, o membro <@${userToPunish.id}> foi isolado.`,
          embeds: [{
            title: '⚖️ JULGAMENTO',
            description: `O membro foi colocado em julgamento pelo seguinte motivo:`,
            fields: [{ name: 'Motivo', value: reason }],
            color: 0xef4444,
            footer: { text: 'Decida se o membro será perdoado ou se o castigo será confirmado.' }
          }],
          components: [judgmentRow]
        });

        await interaction.reply({ content: `O usuário ${userToPunish.tag} foi castigado. Um canal de julgamento foi criado: <#${judgmentChannel.id}>`, ephemeral: true });
      }

      // Interação com os botões de julgamento
      else if (interaction.isButton() && interaction.customId.startsWith('forgive_punishment_')) {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) return interaction.reply({ content: 'Apenas o administrador pode decidir o julgamento.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true }); // Adia a resposta

        const userId = interaction.customId.split('_')[2];
        const punishment = await prisma.punishment.findUnique({ where: { userId } });
        if (!punishment) return interaction.editReply({ content: 'Castigo não encontrado no banco de dados.' });

        const member = await interaction.guild.members.fetch(userId);
        await member.roles.set(punishment.originalRoles);

        await prisma.punishment.delete({ where: { userId } });

        await interaction.channel.send(`O usuário <@${userId}> foi perdoado. Este canal será deletado em 5 segundos.`);
        await interaction.editReply({ content: 'Membro perdoado com sucesso.' });
        setTimeout(() => interaction.channel.delete('Membro perdoado.'), 5000);
      }

      else if (interaction.isButton() && interaction.customId.startsWith('confirm_punishment_')) {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) return interaction.reply({ content: 'Apenas o administrador pode decidir o julgamento.', ephemeral: true });
        
        await interaction.deferReply({ ephemeral: true }); // Adia a resposta

        const userId = interaction.customId.split('_')[2];
        const member = await interaction.guild.members.fetch(userId);

        await member.timeout(24 * 60 * 60 * 1000, 'Castigo confirmado pelo administrador.'); // Castigo de 24h por padrão
        await interaction.channel.send(`O castigo de <@${userId}> foi confirmado (24h). O membro não poderá interagir no servidor. Este canal será deletado em 10 segundos.`);
        await interaction.editReply({ content: 'Castigo confirmado com sucesso.' });
        setTimeout(() => interaction.channel.delete('Castigo confirmado.'), 10000);
      }

      // Comando /perdoar
      else if (interaction.isCommand() && interaction.commandName === 'perdoar') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true }); // Adia a resposta para ganhar tempo

        const userToForgive = interaction.options.getUser('usuario');
        if (!userToForgive) {
          return interaction.editReply({ content: 'Por favor, especifique um usuário válido para perdoar.' });
        }

        const punishment = await prisma.punishment.findUnique({ where: { userId: userToForgive.id } });

        if (!punishment) return interaction.editReply({ content: 'Este usuário não está castigado.' });

        const member = await interaction.guild.members.fetch(userToForgive.id);
        // Restaura os cargos
        await member.roles.set(punishment.originalRoles);
        // Remove o timeout (castigo) se houver
        if (member.isCommunicationDisabled()) {
          await member.timeout(null, 'Castigo removido pelo administrador.');
        }

        const channel = await bot.channels.fetch(punishment.punishChannelId).catch(() => null);
        if (channel) await channel.delete('Usuário perdoado.');

        await prisma.punishment.delete({ where: { userId: userToForgive.id } });

        await interaction.editReply({ content: `O usuário ${userToForgive.tag} foi perdoado e seus cargos foram restaurados.` });
      }

      // Comando /banir
      else if (interaction.isCommand() && interaction.commandName === 'banir') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }

        const userToBan = interaction.options.getUser('usuario');
        const reason = interaction.options.getString('razao') || 'Nenhuma razão fornecida.';
        const member = await interaction.guild.members.fetch(userToBan.id);

        await member.ban({ reason: reason });

        await interaction.reply({ content: `O usuário ${userToBan.tag} foi banido com sucesso. Motivo: ${reason}`, ephemeral: true });
      }

      // --- SISTEMA DE ADVERTÊNCIAS ---

      // Comando /advertir
      else if (interaction.isCommand() && interaction.commandName === 'advertir') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        const userToWarn = interaction.options.getUser('usuario');
        const reason = interaction.options.getString('razao');
        const member = await interaction.guild.members.fetch(userToWarn.id);

        // Salva a advertência
        await prisma.warning.create({
          data: {
            userId: userToWarn.id,
            moderatorId: interaction.user.id,
            reason: reason,
          }
        });

        // Conta o total de advertências
        const warnCount = await prisma.warning.count({ where: { userId: userToWarn.id } });

        let punishmentMessage = `✅ Usuário ${userToWarn.tag} advertido com sucesso. Ele(a) agora tem **${warnCount}** advertência(s).`;
        let punishmentApplied = false;

        // Aplica punições automáticas
        if (warnCount >= 9) {
          await member.ban({ reason: `Acúmulo de ${warnCount} advertências.` });
          punishmentMessage += `\n\n**PUNIÇÃO APLICADA:** Usuário banido permanentemente.`;
          punishmentApplied = true;
        } else if (warnCount >= 6) {
          await member.timeout(7 * 24 * 60 * 60 * 1000, `Acúmulo de ${warnCount} advertências.`);
          punishmentMessage += `\n\n**PUNIÇÃO APLICADA:** Castigo de 7 dias.`;
          punishmentApplied = true;
        } else if (warnCount >= 3) {
          await member.timeout(1 * 24 * 60 * 60 * 1000, `Acúmulo de ${warnCount} advertências.`);
          punishmentMessage += `\n\n**PUNIÇÃO APLICADA:** Castigo de 1 dia.`;
          punishmentApplied = true;
        }

        // Envia DM para o usuário advertido
        try {
          await userToWarn.send(`Você recebeu uma advertência no servidor **${interaction.guild.name}**.\n\n**Motivo:** ${reason}\n\nVocê agora tem um total de **${warnCount}** advertência(s).` + (punishmentApplied ? `\n\nComo resultado, uma punição automática foi aplicada.` : ''));
        } catch (dmError) {
          punishmentMessage += `\n(Não foi possível notificar o usuário por DM.)`;
        }

        await interaction.editReply({ content: punishmentMessage });
      }

      // Comando /advertencias
      else if (interaction.isCommand() && interaction.commandName === 'advertencias') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        const user = interaction.options.getUser('usuario');
        const warnings = await prisma.warning.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' }
        });

        if (warnings.length === 0) {
          return interaction.editReply({ content: `O usuário ${user.tag} não possui nenhuma advertência.` });
        }

        const embed = {
          title: `Histórico de Advertências de ${user.username}`,
          color: 0xfacc15, // Amarelo
          fields: warnings.map(warn => ({
            name: `Advertência #${warn.id} (por <@${warn.moderatorId}>)`,
            value: `**Motivo:** ${warn.reason}\n**Data:** <t:${Math.floor(warn.createdAt.getTime() / 1000)}:f>`,
          })),
          footer: { text: `Total de advertências: ${warnings.length}` }
        };

        await interaction.editReply({ embeds: [embed] });
      }

      // Comando /remover-advertencia
      else if (interaction.isCommand() && interaction.commandName === 'remover-advertencia') {
        const owner = (await bot.application.fetch()).owner;
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o dono do bot pode usar este comando.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        const warnId = interaction.options.getInteger('id');
        try {
          const deletedWarn = await prisma.warning.delete({ where: { id: warnId } });
          await interaction.editReply({ content: `✅ Advertência #${warnId} (para <@${deletedWarn.userId}>) foi removida com sucesso.` });
        } catch (error) {
          if (error.code === 'P2025') { // Record not found
            await interaction.editReply({ content: `❌ Erro: Nenhuma advertência encontrada com o ID #${warnId}.` });
          } else {
            await interaction.editReply({ content: '❌ Ocorreu um erro ao remover a advertência.' });
          }
        }
      }

    } catch (error) {
      console.error('Erro ao processar interação:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Ocorreu um erro ao processar sua solicitação.', flags: [MessageFlags.Ephemeral] });
      } else {
        await interaction.reply({ content: 'Ocorreu um erro ao processar sua solicitação.', flags: [MessageFlags.Ephemeral] });
      }
    }
  });

  bot.on('error', console.error);
}

// Executa a função principal e captura erros críticos na inicialização
(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error("Falha ao iniciar o servidor:", err);
    process.exit(1);
  }
})();